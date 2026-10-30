import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createMonitor } = require('../../server/features/monitor/index.cjs');
const { createObservability } = require('../../server/observability/index.cjs');
const { createSession } = require('../../server/runtime/session.cjs');

// 诊断是「介入」：它会拉起独立 claude、写快照、并在换会话后改 session.mainSessionId。
// 本文件钉的是它的**协议**（互斥 / 两拍写 / 失败收口 / 后效对齐），不是 prompt 内容。

const DIAG_FILE = ['.awf', 'logs', 'run-diagnosis.json'];
const META_FILE = ['.awf', 'logs', 'run-meta.json'];

function readJson(root, rel) {
  return JSON.parse(fs.readFileSync(path.join(root, ...rel), 'utf8'));
}

/** 造一份 monitor + 它的依赖；spawn 可注入以控制诊断进程何时返回 */
function makeHarness({ spawn } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-monitor-'));
  fs.mkdirSync(path.join(root, '.awf', 'logs'), { recursive: true });
  const ctx = {
    projectRoot: root,
    stores: { state: { readSync: () => ({ mode: 'run', currentState: 'CODE', tasks: [] }) } },
    logger: { logNotice: () => {} },
  };
  const session = createSession({ sid: 'sid-test' });
  const observability = createObservability({ ctx, session });
  const spawnCalls = [];
  const oneshot = {
    spawnClaudeP: async (opts) => {
      spawnCalls.push(opts);
      if (spawn) return spawn(opts);
      return { ok: true, stdout: JSON.stringify({ severity: 'healthy', summary: '正常', findings: [], dataGaps: [] }), stderr: '', code: 0 };
    },
  };
  return { root, ctx, session, observability, monitor: createMonitor({ ctx, session, observability, oneshot }), spawnCalls };
}

const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

describe('server · monitor（诊断介入）', () => {
  let root;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  beforeEach(() => { root = null; });

  it('两拍写：先落 status=running 占位，结束后覆盖为 complete', async () => {
    let release;
    const h = makeHarness({ spawn: () => new Promise((res) => { release = res; }) });
    root = h.root;

    const first = await h.monitor.diagnose();
    expect(first.ok).toBe(true);
    expect(first.diagnosis.status).toBe('running');           // 第一拍：立刻返回给调用方展示
    expect(readJson(root, DIAG_FILE).status).toBe('running');
    expect(h.monitor.inFlight).toBe(true);

    release({ ok: true, stdout: JSON.stringify({ severity: 'watch', summary: '有观察项', findings: [], dataGaps: [] }), stderr: '', code: 0 });
    await tick();

    const final = readJson(root, DIAG_FILE);
    expect(final.status).toBe('complete');                     // 第二拍：同文件覆盖
    expect(final.diagnosis.severity).toBe('watch');
    expect(h.monitor.inFlight).toBe(false);
  });

  it('互斥：诊断进行中重复触发 → 报「已在诊断中」，不重复起进程', async () => {
    let release;
    const h = makeHarness({ spawn: () => new Promise((res) => { release = res; }) });
    root = h.root;

    await h.monitor.diagnose();
    const second = await h.monitor.diagnose();
    expect(second).toEqual({ ok: false, error: 'diagnosis already running' });
    expect(h.spawnCalls).toHaveLength(1);

    release({ ok: true, stdout: '{"severity":"healthy","summary":"ok","findings":[],"dataGaps":[]}', stderr: '', code: 0 });
    await tick();
    expect(h.monitor.inFlight).toBe(false);
  });

  it('诊断进程失败 → 快照落 failed 并带错误，闩锁照常解除', async () => {
    const h = makeHarness({ spawn: async () => ({ ok: false, stderr: 'boom', code: 1 }) });
    root = h.root;

    await h.monitor.diagnose();
    await tick();

    const snap = readJson(root, DIAG_FILE);
    expect(snap.status).toBe('failed');
    expect(snap.error).toBe('boom');
    expect(h.monitor.inFlight).toBe(false);
  });

  it('诊断隔离约束：起进程时带 --safe-mode --no-session-persistence', async () => {
    const h = makeHarness();
    root = h.root;

    await h.monitor.diagnose();
    await tick();

    expect(h.spawnCalls[0].args).toEqual(['--safe-mode', '--no-session-persistence']);
    expect(h.spawnCalls[0].cwd).toBe(root);
  });

  it('后效对齐：诊断换过会话 id → 以快照为准改 mainSessionId 并订正 run-meta', async () => {
    const h = makeHarness();
    root = h.root;
    h.session.mainSessionId = 'sess-old';
    fs.writeFileSync(path.join(root, ...DIAG_FILE), JSON.stringify({
      status: 'running',
      metrics: {
        startedAt: '2026-09-13T00:00:00.000Z',
        sources: {
          mainSessionId: 'sess-new',
          mainTranscriptPath: '/t/main.jsonl',
          transcriptPaths: ['/t/main.jsonl', '/t/agent-1.jsonl'],
        },
      },
    }));

    h.monitor.reconcile();

    expect(h.session.mainSessionId).toBe('sess-new');
    const meta = readJson(root, META_FILE);
    expect(meta.mainSessionId).toBe('sess-new');
    expect(Object.keys(meta.subagents)).toEqual(['agent-1']); // 由 transcript 反推（排除主会话）
  });

  it('后效对齐幂等：会话 id 未变时不改写 run-meta', async () => {
    const h = makeHarness();
    root = h.root;
    h.session.mainSessionId = 'sess-same';
    fs.writeFileSync(path.join(root, ...DIAG_FILE), JSON.stringify({
      status: 'running',
      metrics: { sources: { mainSessionId: 'sess-same' } },
    }));

    h.monitor.reconcile();

    expect(fs.existsSync(path.join(root, ...META_FILE))).toBe(false); // 没动它
  });

  it('已完成的快照不做后效对齐（只有进行中的诊断才带来新会话事实）', async () => {
    const h = makeHarness();
    root = h.root;
    h.session.mainSessionId = 'sess-old';
    fs.writeFileSync(path.join(root, ...DIAG_FILE), JSON.stringify({
      status: 'complete',
      metrics: { sources: { mainSessionId: 'sess-new' } },
    }));

    h.monitor.reconcile();

    expect(h.session.mainSessionId).toBe('sess-old');
  });

  it('reset 解除闩锁（测试复位 / shutdown 路径）', async () => {
    let release;
    const h = makeHarness({ spawn: () => new Promise((res) => { release = res; }) });
    root = h.root;

    await h.monitor.diagnose();
    expect(h.monitor.inFlight).toBe(true);
    h.monitor.reset();
    expect(h.monitor.inFlight).toBe(false);

    release({ ok: true, stdout: '{"severity":"healthy","summary":"ok","findings":[],"dataGaps":[]}', stderr: '', code: 0 });
    await tick();
  });

  it('观测侧契约：每次指标采集前回调 onBeforeSnapshot（诊断后效对齐的触发时机）', async () => {
    const h = makeHarness();
    root = h.root;
    let calls = 0;
    const obs = createObservability({ ctx: h.ctx, session: h.session, onBeforeSnapshot: () => { calls += 1; } });

    obs.metricsSnapshot();
    expect(calls).toBe(1);
    obs.metricsSnapshot();               // 1s 缓存命中也要先回调 —— 对齐不能被缓存跳过
    expect(calls).toBe(2);
  });
});
