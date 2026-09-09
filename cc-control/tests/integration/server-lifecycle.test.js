import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// T1-067 冒烟：① cli 薄化后命令面测试绿（run/cli-aux 等既有单测，本文件聚焦冒烟）；
// ② 单写者（并发经 server /run/state/* 写一致）；③ 常驻 server：空闲超时自回收 + /shutdown。

const SERVER_PATH = fileURLToPath(new URL('../../src/server/server.cjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lifecycle-'));
const runProj = path.join(TMP, 'run');
fs.mkdirSync(path.join(runProj, '.awf'), { recursive: true });

let server; // in-process server（单写者冒烟）
let api; // in-process server url
const children = []; // spawn 的 server 子进程（清理用）

function writeTasks(root, tasks) {
  fs.writeFileSync(path.join(root, '.awf', 'state.json'), JSON.stringify({ mode: 'idle', currentState: 'CODE', tasks }, null, 2));
}
function readState(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.awf', 'state.json'), 'utf-8'));
}
function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body: json };
}
async function serverUp(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/status`); return r.ok; } catch { return false; }
}

/** spawn server.cjs 子进程并等待 /status 可达；返回 { proc, port } */
async function spawnServer({ idleMs, idleCheckMs }) {
  const port = await freePort();
  const proj = path.join(TMP, `spawn-${port}`);
  fs.mkdirSync(path.join(proj, '.awf'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.awf', 'state.json'), JSON.stringify({ mode: 'idle', currentState: 'CODE', tasks: [] }, null, 2));
  const proc = spawn('node', [SERVER_PATH], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CC_PORT: String(port),
      CC_PROJECT: proj,
      CC_SERVER_IDLE_MS: String(idleMs),
      CC_SERVER_IDLE_CHECK_MS: String(idleCheckMs),
    },
  });
  children.push(proc);
  proc.stderr.on('data', () => {}); // 防背压；错误仅调试
  const deadline = Date.now() + 6000;
  while (!(await serverUp(port))) {
    if (Date.now() > deadline || proc.exitCode != null) throw new Error('server 子进程未就绪');
    await sleep(60);
  }
  return { proc, port };
}

async function waitExit(proc, timeoutMs = 8000) {
  if (proc.exitCode != null) return proc.exitCode;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    proc.once('exit', (code) => { clearTimeout(t); resolve(code); });
  });
}

afterAll(async () => {
  await server?.stop().catch(() => {});
  for (const c of children) { if (c.exitCode == null) c.kill('SIGKILL'); }
  delete process.env.CC_PROJECT;
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── ① 单写者冒烟：并发写经 server（state.lock 序列化）不丢不坏 ──

describe('单写者冒烟（server 唯一写 /run/state/*）', () => {
  const TASKS = Array.from({ length: 20 }, (_, i) => ({ id: `T${String(i + 1).padStart(3, '0')}`, kind: 'dev', status: 'pending', deps: [] }));

  beforeAll(async () => {
    process.env.CC_PROJECT = runProj;
    writeTasks(runProj, TASKS);
    const mod = await import(SERVER_PATH);
    server = mod;
    const { url } = await server.start(0);
    api = url;
  });

  it('并发 20 路 task/active + 40 路 mode 写 → state 无损坏、任务全 active、mode 有效', async () => {
    await Promise.all(TASKS.map((t) => postJson(`${api}/run/state/task/active`, { taskId: t.id })));
    await Promise.all(TASKS.map((t) => postJson(`${api}/run/state/task/active`, { taskId: t.id })));
    await Promise.all([
      ...TASKS.map(() => postJson(`${api}/run/state/mode`, { mode: 'run' })),
      ...TASKS.map(() => postJson(`${api}/run/state/mode`, { mode: 'pause' })),
    ]);

    const s = readState(runProj);
    expect(s.tasks).toHaveLength(TASKS.length);
    for (const t of s.tasks) expect(t.status).toBe('active'); // 无丢写
    expect(['run', 'pause']).toContain(s.mode); // 每次整体原子覆盖，末次胜出
  });

  it('T1-077：/run/state/apply 落盘 + GET /awf/state 读回一致（server 单写者）', async () => {
    const st = readState(runProj);
    st.tasks.push({ id: 'X1', kind: 'doc', title: '旁路写入', status: 'done', deps: [] });
    st.version = st.version || '0.2.0';
    const r = await postJson(`${api}/run/state/apply`, { state: st });
    expect(r.body.ok).toBe(true);
    const g = await (await fetch(`${api}/awf/state`)).json();
    expect(g.tasks.some((t) => t.id === 'X1')).toBe(true);
    expect(g.version).toBe('0.2.0');
  });
});

// ── ② 常驻 server：空闲自回收 + /shutdown 优雅关闭 ──

describe('常驻 server 冒烟（空闲回收 / shutdown）', () => {
  it('空闲超时（无请求且无 run 驱动）→ server 自动退出', async () => {
    const { proc, port } = await spawnServer({ idleMs: 400, idleCheckMs: 80 });
    await fetch(`http://127.0.0.1:${port}/status`); // 一次活动刷新计时
    const code = await waitExit(proc, 6000);
    expect(code).toBe(0);
  }, 15000);

  it('POST /shutdown → server 优雅退出（不依赖 kill-by-port）', async () => {
    const { proc, port } = await spawnServer({ idleMs: 0, idleCheckMs: 0 }); // 空闲回收禁用
    const r = await postJson(`http://127.0.0.1:${port}/shutdown`, {});
    expect(r.body.ok).toBe(true);
    const code = await waitExit(proc, 6000);
    expect(code).toBe(0);
  }, 15000);
});

// ── ③ T1-071：/hook 按 sid 路由 + 内存状态机隔离（ready/busy/decision 不串 run）──

describe('server /hook sid 路由 + 内存状态机隔离（T1-071）', () => {
  async function hook(event, sid, body = {}) {
    const qs = sid ? `?event=${event}&sid=${sid}` : `?event=${event}`;
    const res = await fetch(`${api}/hook${qs}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  }
  async function status(sid) {
    const res = await fetch(`${api}/status${sid ? `?sid=${sid}` : ''}`);
    return res.json();
  }

  it('a/b 两槽 ready/busy/decision 独立，不串 run', async () => {
    await hook('SessionStart', 'a');
    await hook('UserPromptSubmit', 'a'); // a busy
    expect((await status('a')).state).toBe('busy');
    expect((await status('b')).state).toBe('ready'); // b 不被 a 影响

    // a 触发决策（gate 关捕获）；b 无
    await hook('PreToolUse', 'a', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '选哪个', options: [{ label: 'X' }, { label: 'Y' }] }] } });
    expect((await status('a')).decisionPending?.question).toBe('选哪个');
    expect((await status('b')).decisionPending).toBe(null); // 不串

    // a Stop（gate 关）→ clear decision + ready；b 仍无决策
    await hook('Stop', 'a', { last_assistant_message: 'ok' });
    expect((await status('a')).state).toBe('ready');
    expect((await status('a')).decisionPending).toBe(null);
    expect((await status('b')).decisionPending).toBe(null);
  });
});

// ── T1-078：run-state 按 sid 分片边界（软约束：只碰本 sid run）──

describe('run-state 按 sid 分片（T1-078）', () => {
  it('?sid apply/read 只写/读 .awf/runs/<sid>/state.json，互不影响', async () => {
    const mk = (id) => ({ mode: 'run', currentState: 'CODE', version: '0.2.0', tasks: [{ id, kind: 'dev', status: 'pending', deps: [] }], wbs: [], plan: {} });
    const r1 = await postJson(`${api}/run/state/apply?sid=ra`, { state: mk('A') });
    const r2 = await postJson(`${api}/run/state/apply?sid=rb`, { state: mk('B') });
    expect(r1.body.ok).toBe(true);
    expect(r2.body.ok).toBe(true);

    const a = await (await fetch(`${api}/awf/state?sid=ra`)).json();
    const b = await (await fetch(`${api}/awf/state?sid=rb`)).json();
    expect(a.tasks[0].id).toBe('A');
    expect(b.tasks[0].id).toBe('B');

    // 落盘位置：各自 .awf/runs/<sid>/state.json
    expect(fs.existsSync(path.join(runProj, '.awf', 'runs', 'ra', 'state.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(runProj, '.awf', 'runs', 'rb', 'state.json'), 'utf8')).tasks[0].id).toBe('B');
  });

  it('T1-080：POST /oneshot 空 prompt → 400（不触发 claude spawn）', async () => {
    const r = await postJson(`${api}/oneshot`, {});
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('prompt');
  });
});

// ── T1-086：共享主题/工具资产（4 托管页公共抽取）──
describe('共享主题/工具资产（T1-086）', () => {
  it('GET /theme.css 与 /common.js → 200 + content-type + 内容标记', async () => {
    const css = await fetch(`${api}/theme.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(await css.text()).toContain('--bg');

    const js = await fetch(`${api}/common.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(await js.text()).toContain('AWF_COMMON');
  });
});
