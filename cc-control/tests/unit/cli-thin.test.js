import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createClient } = require('../../cli/lib/client.cjs');
const { buildContext } = require('../../cli/lib/context.cjs');
const env = require('../../cli/lib/env.cjs');

// 新 CLI 是薄客户端：本文件钉住「薄」的三处 —— 请求怎么拼、环境边界怎么划、上下文来自谁。
// 编排（挑任务/推进阶段/调度）不在这里，也就没有可测的编排。

describe('cli · 薄客户端（client）', () => {
  /** 记录调用并返回可控响应的 fetch 替身 */
  function fakeFetch({ status = 200, body = '{}', throws } = {}) {
    const calls = [];
    const impl = async (url, init) => {
      calls.push({ url, init });
      if (throws) throw throws;
      return { ok: status >= 200 && status < 300, status, text: async () => body };
    };
    return { impl, calls };
  }

  it('所有请求带 ?p= 路由到本项目（单 server 多项目）', async () => {
    const { impl, calls } = fakeFetch();
    const c = createClient({ port: 8787, project: '/tmp/p', fetchImpl: impl });
    await c.getStatus();
    expect(calls[0].url).toBe('http://127.0.0.1:8787/status?p=%2Ftmp%2Fp');
  });

  it('已有 query 时用 & 拼接，不吞掉原参数', async () => {
    const { impl, calls } = fakeFetch();
    const c = createClient({ port: 8787, project: '/tmp/p', fetchImpl: impl });
    await c.pollRunEvents({ afterSeq: '3' });
    expect(calls[0].url).toBe('http://127.0.0.1:8787/run/events?afterSeq=3&p=%2Ftmp%2Fp');
  });

  it('POST 带 JSON body；非 2xx 归一为 { ok:false, error }', async () => {
    const { impl, calls } = fakeFetch({ status: 409, body: JSON.stringify({ error: '已有活跃 run' }) });
    const c = createClient({ port: 1, project: null, fetchImpl: impl });
    const r = await c.submitRun({ runId: 'r1' });
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body)).toEqual({ runId: 'r1' });
    expect(r).toMatchObject({ ok: false, status: 409, error: '已有活跃 run' });
  });

  it('连不上 / 超时都返回 { ok:false }，不抛（调用方据此判服务器未起）', async () => {
    const c = createClient({ port: 1, project: null, fetchImpl: fakeFetch({ throws: new Error('ECONNREFUSED') }).impl });
    expect(await c.alive(10)).toBe(false);
  });
});

describe('cli · 环境边界（env）', () => {
  it('run 会话内（CC_AWF_STATE_SERVER=1）清洗父 run 身份', () => {
    const out = env.commandConfigEnv({
      CC_AWF_STATE_SERVER: '1', CC_SESSION: 'cc-parent', CC_PROJECT: '/p', CC_WORKDIR: '/p', CC_SID: 's1', CC_PORT: '8787',
    });
    expect(out.CC_SESSION).toBeUndefined();
    expect(out.CC_SID).toBeUndefined();
    expect(out.CC_PORT).toBe('8787'); // 控制平面配置保留
  });

  it('顶层用户显式给的身份不被清洗（保留覆盖语义）', () => {
    const out = env.commandConfigEnv({ CC_SESSION: 'cc-x', CC_PROJECT: '/x' });
    expect(out.CC_SESSION).toBe('cc-x');
  });

  it('server 子进程只收基础会话名，不继承父 run 的完整会话名 / sid', () => {
    const out = env.serverSpawnEnv({ env: { CC_SESSION: 'cc-parent', CC_SID: 's1' }, projectRoot: '/p', port: 8787, baseSession: 'cc' });
    expect(out.CC_SESSION).toBe('cc');
    expect(out.CC_SID).toBeUndefined();
    expect(out.CC_PORT).toBe('8787');
  });

  it('tmux 里的 Claude 收本次完整身份，但没有 CC_SID（主 run 走无 sid 布局）', () => {
    const out = env.runSessionEnv({ env: { CC_SID: 's1' }, projectRoot: '/p', port: 8787, sessionName: 'cc-p1' });
    expect(out).toMatchObject({ CC_SESSION: 'cc-p1', CC_WORKDIR: '/p', CC_PROJECT: '/p', CC_AWF_STATE_SERVER: '1' });
    expect(out.CC_SID).toBeUndefined();
  });
});

describe('cli · 上下文（context）', () => {
  it('服务端入口是隔壁 server/server.cjs，引导脚本共用 scripts/bootstrap.sh', () => {
    const ctx = buildContext('/tmp/p', { env: {} });
    expect(ctx.serverEntry).toBe(path.resolve(__dirname, '..', '..', 'server', 'server.cjs'));
    expect(ctx.bootstrapScript).toBe(path.resolve(__dirname, '..', '..', 'scripts', 'bootstrap.sh'));
  });

  it('路径/端口取自 server/shared/run-context（不在这里重算布局）', () => {
    const runContext = require('../../server/shared/run-context.cjs');
    const ctx = buildContext('/tmp/p', { env: {} });
    const ref = runContext.buildRunContext({ projectRoot: '/tmp/p', env: {} });
    expect(ctx.statePath).toBe(ref.statePath);
    expect(ctx.logsDir).toBe(ref.logsDir);
  });

  it('会话名按 projectSid 派生，与 server 端兜底同一个值（真机踩过：CLI 建 cc、宿主找 cc-<sid>）', () => {
    const runContext = require('../../server/shared/run-context.cjs');
    const ctx = buildContext('/tmp/p', { env: {} });
    expect(ctx.runSessionName).toBe(`cc-${runContext.projectSid('/tmp/p')}`);
    // 与 server 端的推导（runtime/project.cjs: sid || projectSid(root)）必须一致
    const serverSide = runContext.buildRunContext({ projectRoot: '/tmp/p', sid: runContext.projectSid('/tmp/p'), env: {} });
    expect(ctx.runSessionName).toBe(serverSide.runSessionName);
  });

  it('显式给 sid 时用它，不再覆盖', () => {
    const ctx = buildContext('/tmp/p', { env: {}, sid: 'r9' });
    expect(ctx.runSessionName).toBe('cc-r9');
  });
});
