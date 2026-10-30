import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createApi } = require('../../server/web/api/index.cjs');
const { createProjectRuntime } = require('../../server/runtime/index.cjs');

/**
 * `POST /interactive/plan` —— 规划入口在「CLI 进程没有 bridge」这一事实下的正确落点。
 *
 * 背景（真机踩到）：`awf plan` 原来直接在 CLI 进程里调 `interactive.launchDialog`，而 CLI 进程
 * 的 DSH 端口是 `detachedBridge`（bridge 只在常驻 server 里）→ 一律「指令通道未连接」。
 * 现在按平台**声明的能力**选路：`interactive.detached === true`（DSH，开会话 + 回 URL）才走服务端；
 * cc（交互式对话要占住用户终端）走本进程，服务端对它的该请求显式 501 —— 不静默代跑。
 */

let root; let rt; let server; let port;

function makeFakeBridge() {
  return {
    connected: () => true,
    lastFacts: () => ({ sessionExists: true, reachable: true, ready: true, cwd: root }),
    noteFacts: () => ({}),
    pendingCount: () => 0,
    detachedReason: () => null,
    onEvent: () => () => {},
    async request(op, args) {
      if (op === 'plan.launch') {
        return { commandId: 'c-plan', op, delivery: 'accepted', ok: true, result: { url: 'http://127.0.0.1:39081/?session=s-plan', sessionId: 's-plan', accepted: true, prompt: args?.prompt } };
      }
      return { commandId: `c-${op}`, op, delivery: 'accepted', ok: true, result: {} };
    },
  };
}

function startServer(runtime) {
  rt = runtime;
  const registry = { bootRoot: root, resolveRuntime: () => rt, list: () => [{ projectRoot: root }], all: () => [rt] };
  server = http.createServer(createApi({ registry, stopServer: async () => {} }).handle);
  return new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
}

const post = (body) => fetch(`http://127.0.0.1:${port}/interactive/plan?p=${encodeURIComponent(root)}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

afterAll(() => { try { server?.close(); } catch { /* 未起 */ } });

describe('POST /interactive/plan', () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-plan-route-'));
    fs.mkdirSync(path.join(root, '.awf'), { recursive: true });
    fs.writeFileSync(path.join(root, '.awf', 'state.json'), JSON.stringify({ mode: 'idle', tasks: [] }));
    // ① DSH 项目：平台声明可脱离终端 launch → 服务端代触发
    fs.writeFileSync(path.join(root, '.awf', 'config.json'), JSON.stringify({ runtime: { adapter: 'dsh' } }));
    await startServer(createProjectRuntime({ projectRoot: root, adapterDeps: { bridge: makeFakeBridge() } }));
  });

  it('DSH（detached: true）：服务端代触发 plan.launch，回会话 URL 与 id', async () => {
    expect(rt.ctx.adapters.ports.interactive.detached).toBe(true);
    const r = await post({ prompt: '/ai-workflow-code:w-plan 需求X' });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ ok: true, url: 'http://127.0.0.1:39081/?session=s-plan', sessionId: 's-plan' });
  });

  it('缺 prompt → 400（不默认拿一个残缺指令去开会话）', async () => {
    const r = await post({});
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain('prompt');
  });

  it('cc 项目（detached: false）→ 501 显式拒绝：交互式对话必须在用户终端里跑', async () => {
    await new Promise((r) => server.close(r));
    fs.writeFileSync(path.join(root, '.awf', 'config.json'), JSON.stringify({ runtime: { adapter: 'cc' } }));
    await startServer(createProjectRuntime({ projectRoot: root }));
    expect(rt.ctx.adapter).toBe('cc');
    const r = await post({ prompt: 'x' });
    expect(r.status).toBe(501);
    expect((await r.json()).error).toContain('不能脱离终端');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
