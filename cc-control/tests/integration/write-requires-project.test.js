import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * T1-110：写类端点缺 ?p 必须 400，不得兜底到 boot 项目。
 *
 * 事故背景（2026-09-10）：w-monitor 手写
 *   curl -X POST http://localhost:8787/run/state/mode -d '{"mode":"pause"}'
 * **没带 ?p**，`resolveCtx` 的 `p || bodyProjectRoot || projectRoot || boot` 静默落到
 * boot 项目（= 启动 server 的那个项目），把正在跑的 cc-control run 暂停了 4 小时。
 *
 * 本用例锁两件事：①写类端点缺 ?p → 400 且**一个字节都不写**；②带 ?p 正常、且写的是指定项目。
 * 另锁读类端点保留 boot 兜底（CLI 的 server 发现 / 看板探活依赖它），以及 /shutdown 的豁免。
 */

const SERVER_PATH = fileURLToPath(new URL('../../src/server/server.cjs', import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-write-p-'));
const BOOT = path.join(TMP, 'boot');
const OTHER = path.join(TMP, 'other');

let server;
let base;

function mkProject(root) {
  fs.mkdirSync(path.join(root, '.awf'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.awf', 'state.json'),
    JSON.stringify({ mode: 'idle', currentState: 'CODE', version: '0.2.0', tasks: [{ id: 'T1', kind: 'dev', status: 'pending', deps: [] }] }, null, 2) + '\n',
  );
}
function readState(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.awf', 'state.json'), 'utf8'));
}
function rawState(root) {
  return fs.readFileSync(path.join(root, '.awf', 'state.json'), 'utf8');
}

async function req(method, pathname, body) {
  const headers = { connection: 'close' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}

beforeAll(async () => {
  process.env.CC_PROJECT = BOOT;
  process.env.CC_SERVER_IDLE_MS = '0';
  mkProject(BOOT);
  mkProject(OTHER);
  const mod = await import(SERVER_PATH);
  server = mod;
  const { port } = await server.start(0);
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  try { await server?.stop(); } catch { /* /shutdown 用例可能已停过 */ }
  delete process.env.CC_PROJECT;
  delete process.env.CC_SERVER_IDLE_MS;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('写类端点缺 ?p → 400（不写任何项目的 state）', () => {
  it('POST /run/state/mode 缺 ?p → 400，且 boot 的 state.json 逐字节未变', async () => {
    const before = rawState(BOOT);
    const res = await req('POST', '/run/state/mode', { mode: 'pause' });
    expect(res.status).toBe(400);
    expect(res.body?.error).toContain('?p');
    expect(res.body?.error).toContain(BOOT); // 报错要指出被拒绝兜底到哪个项目
    expect(rawState(BOOT)).toBe(before);
    expect(readState(BOOT).mode).toBe('idle');
  });

  it('四个 /run/state/* 写端点缺 ?p 全部 400', async () => {
    const cases = [
      ['/run/state/task/active', { taskId: 'T1' }],
      ['/run/state/gate', { gate: { id: 'g' } }],
      ['/run/state/backup', {}],
      ['/run/state/apply', { state: { mode: 'run', tasks: [] } }],
    ];
    const before = rawState(BOOT);
    for (const [pathname, body] of cases) {
      const res = await req('POST', pathname, body);
      expect(res.status, pathname).toBe(400);
    }
    expect(rawState(BOOT)).toBe(before);
  });

  it('/intervene 与 /intervene/interrupt 缺 ?p → 400（不再误暂停别的项目）', async () => {
    const a = await req('POST', '/intervene', { text: 'x', reason: 'r' });
    const b = await req('POST', '/intervene/interrupt', { reason: 'r' });
    expect(a.status).toBe(400);
    expect(b.status).toBe(400);
  });

  it('会话注入类写端点缺 ?p 也 400（/send /cmd /choice /ask /respond /context-ready /hook /oneshot）', async () => {
    const cases = [
      ['/send', { text: 'x' }],
      ['/cmd', { cmd: '/clear' }],
      ['/choice', { question: 'Q', options: ['A'] }],
      ['/ask', { question: 'Q' }],
      ['/respond', { value: 'A' }],
      ['/context-ready', {}],
      ['/hook', { event: 'Stop' }],
      ['/oneshot', { prompt: 'hi' }],
    ];
    for (const [pathname, body] of cases) {
      const res = await req('POST', pathname, body);
      expect(res.status, pathname).toBe(400);
      expect(res.body?.error, pathname).toContain('?p');
    }
  });
});

describe('带 ?p 时写正常，且只写指定项目', () => {
  it('POST /run/state/mode?p=<boot> → 200 且 mode 落到 boot', async () => {
    const res = await req('POST', `/run/state/mode?p=${encodeURIComponent(BOOT)}`, { mode: 'run' });
    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(readState(BOOT).mode).toBe('run');
  });

  it('写其它项目不动 boot（多项目路由生效）', async () => {
    const bootBefore = rawState(BOOT);
    const res = await req('POST', `/run/state/mode?p=${encodeURIComponent(OTHER)}`, { mode: 'pause' });
    expect(res.status).toBe(200);
    expect(readState(OTHER).mode).toBe('pause');
    expect(rawState(BOOT)).toBe(bootBefore);
  });
});

describe('读类端点保留 boot 兜底（CLI 发现 / 探活依赖）', () => {
  it('GET /status 缺 ?p → 200 且报 boot 项目', async () => {
    const res = await req('GET', '/status');
    expect(res.status).toBe(200);
    expect(res.body?.projectRoot).toBe(path.resolve(BOOT));
  });

  it('GET /awf/state、/awf/decisions 缺 ?p 仍可读', async () => {
    expect((await req('GET', '/awf/state')).status).toBe(200);
    expect((await req('GET', '/awf/decisions')).status).toBe(200);
  });
});

describe('豁免：/shutdown 是 server 全局操作', () => {
  // 放最后：它真的会停掉本 server
  it('POST /shutdown 缺 ?p 不被 ?p 规则拒绝（返回 200 而非 400）', async () => {
    const res = await req('POST', '/shutdown', {});
    expect(res.status).toBe(200);
    expect(res.body?.shutting).toBe(true);
  });
});
