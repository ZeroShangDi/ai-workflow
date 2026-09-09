import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// one-server-two-projects：单 server 多项目验收（用户裁定，主键=projectRoot，不做 sid 磁盘分片）。
// 覆盖：?p 路由到各自项目（state 隔离读写）、每项目决策配置独立（gate on/off）、
// 跨项目同 sid 的 run 槽互不串、无 p 回落 boot、/status projects 枚举与会话名唯一、空闲回收（子进程）。

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-two-proj-'));
const A = path.join(TMP, 'projA');
const B = path.join(TMP, 'projB');
for (const r of [A, B]) {
  fs.mkdirSync(path.join(r, '.awf', 'logs'), { recursive: true });
}
fs.writeFileSync(path.join(A, '.awf', 'state.json'), JSON.stringify({ mode: 'idle', version: '0.2.0', currentState: 'IDLE', marker: 'A', tasks: [] }));
fs.writeFileSync(path.join(B, '.awf', 'state.json'), JSON.stringify({ mode: 'idle', version: '0.2.0', currentState: 'IDLE', marker: 'B', tasks: [] }));
// 决策闸门：A 关（无 config → 缺省关），B 开
fs.writeFileSync(path.join(B, '.awf', 'config.json'), JSON.stringify({ run: { agents: { max: 1 }, decision: { enabled: true } } }));
fs.writeFileSync(path.join(A, '.awf', 'config.json'), JSON.stringify({ run: { agents: { max: 1 }, decision: { enabled: false } } }));

// ── mocks（须在 import server.cjs 前注入）──
const m = {
  tmux: { hasSession: vi.fn(() => true), sendText: vi.fn(), sendEnter: vi.fn(), sendCtrlC: vi.fn(), capture: vi.fn(() => 'pane'), SESSION: 'cc' },
};
class MockRunLogger {
  constructor() {}
  get enabled() { return false; }
  resetTranscript() {}
  captureFromTranscript() {}
  captureSubagentTranscript() {}
  logChoice() {}
  logPrompt() {}
  logDecision() {}
}
process.env.CC_PROJECT = A;
process.env.CC_READY_TIMEOUT_MS = '300';
process.env.CC_ENTER_DELAY_MS = '0';
global.__CC_TMUX__ = m.tmux;
global.__CC_RUNLOGGER__ = { RunLogger: MockRunLogger };

const SERVER_PATH = fileURLToPath(new URL('../../src/server/server.cjs', import.meta.url));
let mod;
let base;

async function api(method, pathname, body) {
  const headers = { connection: 'close' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  return { status: res.status, body: json };
}

beforeAll(async () => {
  mod = await import(SERVER_PATH);
  const { port } = await mod.start(0);
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await mod.stop();
  for (const g of ['__CC_TMUX__', '__CC_RUNLOGGER__']) delete global[g];
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  mod._resetForTest();
});

describe('一个 server 服务两个项目目录（主键 projectRoot）', () => {
  it('?p 路由到各自 state；无 p 回落 boot（A）', async () => {
    const a = await api('GET', '/awf/state?p=' + encodeURIComponent(A));
    const b = await api('GET', '/awf/state?p=' + encodeURIComponent(B));
    const boot = await api('GET', '/awf/state');
    expect(a.status).toBe(200);
    expect(a.body.marker).toBe('A');
    expect(b.body.marker).toBe('B');
    expect(boot.body.marker).toBe('A'); // boot = A
  });

  it('/run/state/apply?p=B 只写 B；A 与 boot 不动', async () => {
    const newState = { mode: 'run', version: '0.2.0', currentState: 'CODE', marker: 'B', tasks: [{ id: 'T1', status: 'pending' }] };
    const r = await api('POST', '/run/state/apply?p=' + encodeURIComponent(B), { state: newState });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const b = JSON.parse(fs.readFileSync(path.join(B, '.awf', 'state.json'), 'utf8'));
    const a = JSON.parse(fs.readFileSync(path.join(A, '.awf', 'state.json'), 'utf8'));
    expect(b.marker).toBe('B');
    expect(b.tasks[0].status).toBe('pending');
    expect(a.marker).toBe('A');
    expect(a.currentState).toBe('IDLE');
  });

  it('/run/state/mode?p=B 只翻转 B 的 mode', async () => {
    const r = await api('POST', '/run/state/mode?p=' + encodeURIComponent(B), { mode: 'run' });
    expect(r.status).toBe(200);
    const b = JSON.parse(fs.readFileSync(path.join(B, '.awf', 'state.json'), 'utf8'));
    const a = JSON.parse(fs.readFileSync(path.join(A, '.awf', 'state.json'), 'utf8'));
    expect(b.mode).toBe('run');
    expect(a.mode).toBe('idle');
  });

  it('每项目决策闸门配置独立：A gate off 捕获 AskUserQuestion，B gate on deny（ccOutput）', async () => {
    const askBody = {
      event: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: '选哪个？', options: [{ label: 'X' }, { label: 'Y' }] }] },
    };
    const ra = await api('POST', '/hook?p=' + encodeURIComponent(A), askBody);
    const sa = await api('GET', '/status?p=' + encodeURIComponent(A));
    expect(ra.body.ccOutput).toBeUndefined(); // gate off → 捕获不 deny
    expect(sa.body.decisionPending?.question).toBe('选哪个？');
    mod._resetForTest();
    const rb = await api('POST', '/hook?p=' + encodeURIComponent(B), askBody);
    const sb = await api('GET', '/status?p=' + encodeURIComponent(B));
    expect(rb.body.ccOutput).toBeTruthy(); // gate on → deny 并指引决策标签
    expect(sb.body.decisionPending).toBeNull();
  });

  it('跨项目同 sid 的 run 槽互不串（ready/busy 按项目隔离）', async () => {
    // B 项目的 sid=rb busy；A 项目同 sid=rb 仍 ready
    await api('POST', '/hook?p=' + encodeURIComponent(B) + '&sid=rb', { event: 'UserPromptSubmit' });
    const bBusy = await api('GET', '/status?p=' + encodeURIComponent(B) + '&sid=rb');
    const aIdle = await api('GET', '/status?p=' + encodeURIComponent(A) + '&sid=rb');
    expect(bBusy.body.state).toBe('busy');
    expect(aIdle.body.state).toBe('ready');
  });

  it('/status 无 p 增量返回 projects（会话名唯一），各项目 projectRoot 正确', async () => {
    await api('GET', '/status?p=' + encodeURIComponent(B)); // 触发生成 B 上下文
    const st = await api('GET', '/status');
    const roots = (st.body.projects || []).map((x) => x.projectRoot).sort();
    expect(roots).toEqual([A, B].sort());
    const sessions = new Set((st.body.projects || []).map((x) => x.runSessionName));
    expect(sessions.size).toBe(2); // 两个项目会话名不同
    expect(st.body.projectRoot).toBe(A); // no-p 响应仍是 boot 项目
  });
});

describe('空闲回收（子进程，真实 main）', () => {
  it('无 run 驱动且空闲超时 → server 自动关闭', async () => {
    const idleProj = path.join(TMP, 'idle-proj');
    fs.mkdirSync(path.join(idleProj, '.awf'), { recursive: true });
    fs.writeFileSync(path.join(idleProj, '.awf', 'state.json'), JSON.stringify({ mode: 'idle', version: '0.2.0', tasks: [] }));
    const port = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    });
    const child = spawn(process.execPath, [SERVER_PATH], {
      cwd: idleProj,
      env: { ...process.env, CC_PROJECT: idleProj, CC_PORT: String(port), CC_SERVER_IDLE_MS: '400', CC_SERVER_IDLE_CHECK_MS: '80' },
      stdio: 'ignore',
    });
    const exited = await new Promise((resolve) => {
      const t = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 8000);
      child.on('exit', () => { clearTimeout(t); resolve(true); });
    });
    expect(exited).toBe(true);
  });
});
