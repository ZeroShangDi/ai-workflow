import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const session = require('../../cli/lib/session.cjs');
const { runCommand, observe, renderEvent } = require('../../cli/commands/run.cjs');

/**
 * awf run（薄 CLI）— 起环境 → 提交 run → 订阅展示 → 收尾
 *
 * 随旧树退役重写。旧版测的是**旧编排主循环**（选任务/推进阶段/门禁闭环/多 agent 分流）——
 * 那些已整体搬进宿主 `server/run/host.cjs`，覆盖在 `tests/unit/run-host.test.js` +
 * `tests/integration/run-host.test.js`。本文件只测**新 CLI 剩下的四件事**。
 *
 * 怎么拦：旧版用 `vi.mock`，对新树不成立（CJS 的 require 不被拦，见 .awf/issues/014）。这里不用缝：
 *   - `session` 是命名空间访问（`session.bringUp`）→ 测试侧替换该属性即可（同进程同实例）；
 *   - `createClient` 走**全局 fetch** → `vi.stubGlobal('fetch', …)` 即可。
 *
 * 未覆盖：真起 tmux/server 的 bringUp 本体（见 issue 014）。
 */

let TMP;
let net;
let logs;
let errors;
let savedSession;

function res(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = new URL(String(url));
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    net.calls.push({ path: u.pathname, method, body, project: u.searchParams.get('p') });

    if (u.pathname === '/run/state/mode') { net.modes.push(body.mode); return res({ ok: true }); }
    if (u.pathname === '/run/submit') {
      const runId = body?.runId || 'default';
      net.submitted.push({ runId, mode: body?.mode });
      return res({ ok: true, runId, mode: body?.mode || 'single' });
    }
    if (u.pathname === '/run/events') {
      const after = Number(u.searchParams.get('afterSeq') || 0);
      return res({ ok: true, events: net.events.filter((e) => e.seq > after) });
    }
    if (u.pathname === '/run/status') {
      return u.searchParams.get('runId') ? res({ ok: true, run: net.run }) : res({ ok: true, runs: net.runs });
    }
    if (u.pathname === '/status') return res({ ok: true, state: 'ready', decisionPending: net.decisionPending });
    return res({ ok: true });
  }));
}

function writeState(overrides = {}) {
  fs.mkdirSync(path.join(TMP, '.awf'), { recursive: true });
  fs.writeFileSync(path.join(TMP, '.awf', 'state.json'), JSON.stringify({
    version: '0.2.0', mode: 'idle', currentState: 'CODE', plan: { summary: '示例计划' }, tasks: [], ...overrides,
  }, null, 2));
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-run-'));
  vi.spyOn(process, 'cwd').mockReturnValue(TMP);
  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')); });

  net = { calls: [], modes: [], submitted: [], events: [], runs: [], run: { status: 'done' }, decisionPending: null };
  installFetch();

  savedSession = { bringUp: session.bringUp, stopSession: session.stopSession };
  session.bringUp = vi.fn(async () => ({ server: { started: true }, sessionCreated: true }));
  session.stopSession = vi.fn();
});

afterEach(() => {
  session.bringUp = savedSession.bringUp;
  session.stopSession = savedSession.stopSession;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ═══════════════════ 事件渲染（纯函数）═══════════════════

describe('renderEvent — 事件 → 一行人读文本', () => {
  it('run 生命周期三态', () => {
    expect(renderEvent({ type: 'run.started', payload: { mode: 'batch' } })).toContain('mode=batch');
    expect(renderEvent({ type: 'run.stopped', payload: { status: 'done' } })).toContain('status=done');
    expect(renderEvent({ type: 'run.error', payload: { error: '炸了' } })).toContain('炸了');
  });

  it('task.done 复用 task.started 记下的标题（信息只报一次）', () => {
    renderEvent({ type: 'task.started', payload: { taskId: 'T1', title: '实现 A' } });
    expect(renderEvent({ type: 'task.done', payload: { taskId: 'T1' } })).toContain('[T1] 实现 A');
  });

  it('gate.fix 带出派生的修复任务（fixId 由宿主从派发结果带出）', () => {
    expect(renderEvent({ type: 'gate.fix', payload: { taskId: 'R1', fixId: 'R1-F1' } }))
      .toContain('门禁 R1 非 pass → 派生修复任务 R1-F1');
  });

  it('未知类型原样打 type（不吞事件）', () => {
    expect(renderEvent({ type: 'whatever.new' })).toContain('whatever.new');
  });
});

// ═══════════════════ observe（订阅循环）═══════════════════

describe('observe — 订阅事件与状态直到终态', () => {
  /** 手造 client（observe 只依赖这四件事），避免依赖真实 fetch */
  function stubClient(over = {}) {
    return {
      pollRunEvents: vi.fn(async () => ({ ok: true, events: [] })),
      runSnapshot: vi.fn(async () => ({ ok: true, run: { status: 'done' } })),
      getStatus: vi.fn(async () => ({ ok: true, decisionPending: null })),
      respond: vi.fn(async () => ({ ok: true })),
      ...over,
    };
  }

  it('按序遍历事件并渲染，run done → ok', async () => {
    const c = stubClient({ pollRunEvents: vi.fn(async () => ({ ok: true, events: [
      { seq: 1, type: 'task.started', payload: { taskId: 'T1', title: 'A' } },
      { seq: 2, type: 'task.done', payload: { taskId: 'T1' } },
    ] })) });
    expect(await observe(c, { runId: 'r1' })).toEqual({ ok: true });
    expect(logs.join('\n')).toContain('[T1] A');
  });

  it('run 终止于 error → ok:false 且带原因（调用方据此保留现场）', async () => {
    const c = stubClient({ runSnapshot: vi.fn(async () => ({ ok: true, run: { status: 'error', error: '宿主炸了' } })) });
    expect(await observe(c, { runId: 'r1' })).toEqual({ ok: false, error: 'run 终止于 error：宿主炸了' });
  });

  it('事件流取不到 → ok:false（不假装跑完）', async () => {
    const c = stubClient({ pollRunEvents: vi.fn(async () => ({ ok: false, error: '连接断' })) });
    expect(await observe(c, { runId: 'r1' })).toEqual({ ok: false, error: '连接断' });
  });

  it('会话面挂着待答决策 → 交给决策路由（manual 路由只提示，不抢答）', async () => {
    const c = stubClient({ getStatus: vi.fn(async () => ({
      ok: true,
      decisionPending: { decisionId: 'D-1', question: '选哪个？', options: ['A', 'B'] },
    })) });
    // 用 manual 路由：应答行为本身由 decision-routing.test.js 覆盖（auto 有 5s 倒计时，这里不引入等待）
    await observe(c, { runId: 'r1', mode: 'manual' });
    expect(c.respond).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('决策待答');
  });
});

// ═══════════════════ runCommand（薄编排）═══════════════════

describe('runCommand', () => {
  it('state.json 不存在 → 报错退出（exit 1），不起环境', async () => {
    const code = [];
    vi.spyOn(process, 'exit').mockImplementation((c) => { code.push(c); throw new Error('exit'); });
    await expect(runCommand(undefined)).rejects.toThrow('exit');
    expect(code).toEqual([1]);
    expect(errors.join('\n')).toContain('未找到 .awf/state.json');
    expect(session.bringUp).not.toHaveBeenCalled();
  });

  it('正常路径：起环境 → mode=run → 提交 → 观察 → mode=idle → 停会话', async () => {
    writeState();
    await runCommand(undefined);

    expect(session.bringUp).toHaveBeenCalledWith(expect.anything(), { reuseExisting: false });
    expect(net.modes).toEqual(['run', 'idle']);
    expect(net.submitted).toEqual([{ runId: 'default', mode: undefined }]);
    expect(session.stopSession).toHaveBeenCalled();
    expect(logs.join('\n')).toContain('已停止运行会话');
  });

  it('--multi-agent → 提交时声明 mode=batch（多 agent 分流由宿主判定）', async () => {
    writeState();
    await runCommand(undefined, { multiAgent: true });
    expect(net.submitted[0].mode).toBe('batch');
  });

  it('run 异常收尾 → 抛错（顶层 catch 收口）+ **保留现场**：不置 idle、不停会话', async () => {
    writeState();
    net.run = { status: 'error', error: '宿主炸了' };
    await expect(runCommand(undefined)).rejects.toThrow('run 终止于 error：宿主炸了');

    expect(net.modes).toEqual(['run']); // 没有 idle
    expect(session.stopSession).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('保留 tmux 与 server 现场');
  });

  it('每个请求都带 ?p= 项目标记（单 server 多项目不串）', async () => {
    writeState();
    await runCommand(undefined);
    expect(net.calls.every((c) => c.project === TMP)).toBe(true);
  });

  it('--attach：挂接活跃 run（**不重复提交**），保留现场与否按观察结果', async () => {
    writeState();
    net.runs = [{ runId: 'r9', status: 'running' }];
    await runCommand(undefined, { attach: true });

    expect(net.submitted).toEqual([]); // 没提交
    expect(session.bringUp).toHaveBeenCalledWith(expect.anything(), { reuseExisting: true });
    expect(logs.join('\n')).toContain('挂接 runId=r9');
  });

  it('--attach 撞上宿主空闲 → 报错且不提交（不擅自开新 run）', async () => {
    writeState();
    net.runs = [];
    await expect(runCommand(undefined, { attach: true })).rejects.toThrow('没有活跃 run 可挂接');
    expect(net.submitted).toEqual([]);
    expect(logs.join('\n')).toContain('保留 tmux 与 server 现场');
  });

  // ── T-P1-06：run -r 的最小恢复（先查活跃 run → 有则挂接，与 --attach 同路径）──

  it('run -r 撞上有活跃 run → 挂接现场（**不重复提交**，此前会 409）', async () => {
    writeState();
    net.runs = [{ runId: 'r7', status: 'running' }];
    await runCommand(undefined, { resume: true });

    expect(net.submitted).toEqual([]); // 关键：没有第二次 submit
    expect(logs.join('\n')).toContain('挂接 runId=r7');
    expect(logs.join('\n')).toContain('未重复提交');
    expect(session.bringUp).toHaveBeenCalledWith(expect.anything(), { reuseExisting: true });
  });

  it('run -r 无活跃 run（只有已结束的）→ 按现状提交', async () => {
    writeState();
    net.runs = [{ runId: 'r0', status: 'done' }];
    await runCommand(undefined, { resume: true });

    expect(net.submitted).toEqual([{ runId: 'default', mode: undefined }]);
  });

  it('--resume 撞上 pause：保留 pause 闩锁（不擅自把 mode 切成 run）', async () => {
    writeState({ mode: 'pause' });
    await runCommand(undefined, { resume: true });
    expect(net.modes).not.toContain('run'); // 不把 pause 闩锁掀掉（run 结束后照常复位 idle）
    expect(session.bringUp).toHaveBeenCalledWith(expect.anything(), { reuseExisting: true });
  });

  it('注册 SIGINT/SIGTERM 清理处理器（异常退出也要停会话）', async () => {
    writeState();
    const on = vi.spyOn(process, 'on');
    await runCommand(undefined);
    expect(on).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  });
});
