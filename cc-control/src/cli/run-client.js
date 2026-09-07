// src/cli/run-client.js — CLI 与 Server 的「提交 + 订阅 + 应答」调用面（薄化本体在 W3-005）
//
// run.js 长期是「司机」：spawn server/tmux + 直接调度 + 轮询 + 人机应答。
// 目标形态：CLI 提交 run → 订阅状态/事件 → 收到需决策/上下文就绪再应答。本模块先把
// 这些交互收敛为可注入传输的 client 面（submit/subscribe 轮询桩/respond），W3-005
// 薄化本体时把事件订阅换成真实事件通道（server api/WS，T1-056），本接口不变。
//
// 传输注入：默认走 session client（httpPostJson/…）；测试/未来 client 可注入 mock。

import { SERVER_PORT, httpPostJson, getStatus } from '../lib/session/client.js';

function base(port) {
  return `http://127.0.0.1:${port ?? SERVER_PORT}`;
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
};

/**
 * @param {{ port?: number, http?: { postJson, respond, status }, sleep?: Function, onEvent?: Function }} deps
 */
export function createRunClient({ port, http, sleep } = {}) {
  const postJson = http?.postJson || ((path, body) => httpPostJson(`${base(port)}${path}`, body));
  const respond = http?.respond || ((value) => httpPostJson(`${base(port)}/respond`, { value }));
  const status = http?.status || (() => getStatus(port));
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
  };
}
