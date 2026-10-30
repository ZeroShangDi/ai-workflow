import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createApi } = require('../../server/web/api/index.cjs');
const { createProjectRuntime } = require('../../server/runtime/index.cjs');
const { createMockTmux } = require('../../server/mock/index.cjs');

const BASE_STATE = {
  mode: 'idle', currentState: 'CODE', version: '0.2.0', milestones: [],
  tasks: [{ id: 'T1', kind: 'dev', status: 'pending', deps: [], wbsRef: 'W1', acceptance: 'x' }],
  wbs: [{ id: 'W1', name: 'w', desc: '', deps: [] }],
  lastUpdated: '2026-09-12T00:00:00.000Z', plan: {},
};

let root; let rt; let tmux; let server; let port;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 打开一条 WS 连接，返回 { ws, frames }（frames 收集收到的文本帧） */
async function openWs(query = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/run/events?p=${encodeURIComponent(root)}${query}`);
  const frames = [];
  ws.onmessage = (e) => frames.push(String(e.data));
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return { ws, frames };
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-ws-'));
  fs.mkdirSync(path.join(root, '.awf'), { recursive: true });
  fs.writeFileSync(path.join(root, '.awf', 'state.json'), JSON.stringify(BASE_STATE));
  tmux = createMockTmux({ hasSession: false });
  rt = createProjectRuntime({ projectRoot: root, hostFactory: () => tmux });
  const registry = { bootRoot: root, resolveRuntime: () => rt, runtimeFor: () => rt, list: () => [], all: () => [rt] };
  const api = createApi({ registry, stopServer: async () => {} });
  server = http.createServer(api.handle);
  server.on('upgrade', api.handleUpgrade);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  fs.writeFileSync(path.join(root, '.awf', 'state.json'), JSON.stringify(BASE_STATE));
  tmux.setAlive(false);
});

describe('WebSocket · /run/events 实时推送', () => {
  it('连接成功并收到 run 事件（服务端订阅 → publish → 客户端收帧）', async () => {
    const { ws, frames } = await openWs();
    // 连接后服务端会 ensureRunHost 并 subscribe —— 等它就绪
    await rt.ensureRunHost();
    await wait(120);
    // 推一条领域事件（宿主 publish 进事件环，WS 订阅者转发）
    rt.runHost.publish('task.started', { taskId: 'T1', title: '测试任务' });
    await wait(200);
    expect(frames.length).toBeGreaterThan(0);
    const parsed = JSON.parse(frames[0]);
    expect(parsed.type).toBe('task.started');
    expect(parsed.payload?.taskId).toBe('T1');
    ws.close();
    await wait(50);
  });

  it('多帧按顺序到达（事件环 → 订阅者逐条转发）', async () => {
    const { ws, frames } = await openWs();
    await rt.ensureRunHost();
    await wait(120);
    rt.runHost.publish('a.one', { n: 1 });
    rt.runHost.publish('b.two', { n: 2 });
    rt.runHost.publish('c.three', { n: 3 });
    await wait(250);
    const types = frames.map((f) => JSON.parse(f).type);
    expect(types).toEqual(expect.arrayContaining(['a.one', 'b.two', 'c.three']));
    // 顺序保持（事件环按 seq 追加）
    expect(types.indexOf('a.one')).toBeLessThan(types.indexOf('b.two'));
    expect(types.indexOf('b.two')).toBeLessThan(types.indexOf('c.three'));
    ws.close();
    await wait(50);
  });

  it('非 /run/events 路径的 upgrade 被拒（连接不会打开）', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/some/other?p=${encodeURIComponent(root)}`);
    const outcome = await Promise.race([
      new Promise((res) => { ws.onopen = () => res('opened'); }),
      new Promise((res) => { ws.onerror = () => res('rejected'); ws.onclose = () => res('rejected'); }),
      wait(1500).then(() => 'timeout'),
    ]);
    expect(outcome).toBe('rejected');
  });

  it('客户端关闭后服务端退订（再次 publish 不再抛错）', async () => {
    const { ws } = await openWs();
    await rt.ensureRunHost();
    await wait(120);
    ws.close();
    await wait(200);
    // 订阅已撤销：publish 仍应正常（不指向已关 socket）
    expect(() => rt.runHost.publish('after.close', { ok: true })).not.toThrow();
  });
});
