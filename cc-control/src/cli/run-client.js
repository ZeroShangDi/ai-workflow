// src/cli/run-client.js — CLI 与 Server 的「提交 + 订阅 + 应答」调用面（薄化本体在 W3-005）
//
// run.js 长期是「司机」：spawn server/tmux + 直接调度 + 轮询 + 人机应答。
// 目标形态：CLI 提交 run → 订阅状态/事件 → 收到需决策/上下文就绪再应答。本模块先把
// 这些交互收敛为可注入传输的 client 面（submit/subscribe 轮询桩/respond），W3-005
// 薄化本体时把事件订阅换成真实事件通道（server api/WS，T1-056），本接口不变。
//
// T1-105 前置：server run host（常驻编排）挂 /run/submit + /run/status + /run/events，
// 本模块补 submitRun / runSnapshot / pollRunEvents 三个 client 方法（T1-058 cutover 消费面）。
//
// 传输注入：默认走 session client（httpPostJson/getStatus/…）；测试/未来 client 可注入 mock。

import http from 'http';
import { SERVER_PORT, httpPostJson, getStatus } from '../lib/session/client.js';

function base(port) {
  return `http://127.0.0.1:${port ?? SERVER_PORT}`;
}

/** GET → JSON 解析（本地回环；失败返回 null） */
function httpGetJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}

/** 端点集中表（替代散落的硬编码路径；/api/v1 与 legacy 别名由 server api 目录定义） */
export const API_ENDPOINTS = {
  send: { path: '/send', method: 'POST' },
  respond: { path: '/respond', method: 'POST' },
  cmd: { path: '/cmd', method: 'POST' },
  status: { path: '/status', method: 'GET' },
  contextReadyGet: { path: '/context-ready', method: 'GET' },
  contextReadyPost: { path: '/context-ready', method: 'POST' },
  awfState: { path: '/awf/state', method: 'GET' },
  awfMetrics: { path: '/awf/metrics', method: 'GET' },
  // T1-105 run host 端点（server 常驻编排：提交 / 状态快照 / 轮询事件）
  runSubmit: { path: '/run/submit', method: 'POST' },
  runStatus: { path: '/run/status', method: 'GET' },
  runEvents: { path: '/run/events', method: 'GET' },
  // T1-061 server run api 写端点（cli 侧 state 直写下线，写收口 server 单写者）
  stateMode: { path: '/run/state/mode', method: 'POST' },
  stateTaskActive: { path: '/run/state/task/active', method: 'POST' },
  stateGate: { path: '/run/state/gate', method: 'POST' },
  stateBackup: { path: '/run/state/backup', method: 'POST' },
};

/**
 * @param {{ port?: number, project?: string, http?: { postJson, getJson, respond, status }, sleep?: Function, onEvent?: Function }} deps
 *   - project  项目根（单 server 多项目）：给所有端点追加 ?p= 路由到该项目；缺省不加（存量路径不变）
 */
export function createRunClient({ port, project, http, sleep } = {}) {
  const enc = project ? encodeURIComponent(project) : null;
  /** 给路径合并 ?p=（有既有 query 则 & 追加）；无 project 原样返回 */
  const addP = (p) => (enc == null ? p : (p.includes('?') ? `${p}&p=${enc}` : `${p}?p=${enc}`));
  const postJson = http?.postJson || ((path, body) => httpPostJson(`${base(port)}${addP(path)}`, body));
  const getJson = http?.getJson || ((path) => httpGetJson(`${base(port)}${addP(path)}`));
  const respond = http?.respond || ((value) => httpPostJson(`${base(port)}${addP('/respond')}`, { value }));
  const status = http?.status || (() => getStatus(port, project));
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  return {
    /** 端点表（替代散落路径） */
    endpoints: API_ENDPOINTS,
    /** 提交一条 prompt 到 run 会话（等价旧 /send） */
    submit(text) {
      return postJson('/send', { text });
    },
    /** 人机应答决策（choice/ask 后回填 value） */
    respond(value) {
      return respond(value);
    },
    /** 订阅会话状态（轮询桩；WS 事件订阅由 server api/WS（W3-006）提供后替换为真实订阅） */
    async status() {
      return status();
    },
    /** T1-073：查询某 run 槽（sid）的会话内存态（server /status?sid，ready/busy/decision 隔离） */
    slotStatus(sid) {
      return getJson(`/status?sid=${encodeURIComponent(sid)}`);
    },
    /** 轮询直到会话 ready（subscribe 的可用性近似；超时返回 false） */
    async waitReady({ timeoutMs = 300000, intervalMs = 2000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const st = await status();
        if (st?.state === 'ready') return true;
        await wait(intervalMs);
      }
      return false;
    },
    /**
     * 事件订阅接缝：返回 unsubscribe。真实 WS 订阅由 server /api + WS（W3-006）落地后接入；
     * 当前以轮询 status 作为可用性代理（intervalMs 默认 2000）。onEvent 收到 { type, ... }。
     */
    subscribe({ intervalMs = 2000, onEvent } = {}) {
      if (typeof onEvent !== 'function') throw new Error('run-client.subscribe: onEvent 须为函数');
      let closed = false;
      (async () => {
        while (!closed) {
          const st = await status();
          onEvent({ type: 'status', ...(st || {}) });
          await wait(intervalMs);
        }
      })();
      return () => { closed = true; };
    },
    // ── T1-105 run host 调用面（T1-058 CLI cutover 消费） ──
    /** 提交 run 到 server run host；返回 { ok, runId, mode }（驱动异步，事件经 pollRunEvents） */
    submitRun({ runId } = {}) {
      return postJson('/run/submit', runId ? { runId } : {});
    },
    /** run 状态快照；runId 缺省 → 全部 run 摘要 */
    runSnapshot({ runId } = {}) {
      const qs = runId ? `?runId=${encodeURIComponent(runId)}` : '';
      return getJson(`/run/status${qs}`);
    },
    /** 读当前 state 快照（GET /awf/state；T1-062：CLI 运行态读经 server，不再直读 lib/state.js） */
    getState() {
      return getJson('/awf/state');
    },
    /** 轮询 run 事件：afterSeq 之后的增量事件（runId 过滤可选） */
    pollRunEvents({ runId, afterSeq = 0, limit } = {}) {
      const params = [`afterSeq=${Number(afterSeq) || 0}`];
      if (runId) params.push(`runId=${encodeURIComponent(runId)}`);
      if (Number.isInteger(limit) && limit > 0) params.push(`limit=${limit}`);
      return getJson(`/run/events?${params.join('&')}`);
    },
    // ── T1-061 server run api 写端点（cli 直写下线，写收口 server 单写者） ──
    /** 置工作流 mode（run/idle/pause）；server 侧单写者落盘 */
    setRunMode(mode) {
      return postJson('/run/state/mode', { mode });
    },
    /** 标记任务 active（调度派发侧；server 侧落盘） */
    markRunTaskActive(taskId) {
      return postJson('/run/state/task/active', { taskId });
    },
    /** 门禁完成闭环（review/test blocked+非 pass → server 派生修复 + 回退复审） */
    runGateComplete(taskId) {
      return postJson('/run/state/gate', { taskId });
    },
    /** run 完成版本备份（写 .awf/versions/） */
    backupRun() {
      return postJson('/run/state/backup', {});
    },
  };
}
