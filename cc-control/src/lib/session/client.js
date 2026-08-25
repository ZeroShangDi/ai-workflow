import http from 'http';

/**
 * Session Server (:8787) HTTP 通信 + 决策自动处理
 */

/** Session Server 默认端口 */
export const SERVER_PORT = 8787;
/** waitForReady 最大等待时间 (5 min) */
export const READY_TIMEOUT = 300000;
/** ready 轮询间隔 */
export const POLL_INTERVAL = 2000;

// ── HTTP 请求 ──

/** HTTP POST 原始请求（返回 raw string） */
export function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: READY_TIMEOUT,
    }, (res) => {
      let resp = '';
      res.on('data', (c) => (resp += c));
      res.on('end', () => resolve(resp));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/** HTTP POST → JSON 解析 */
export async function httpPostJson(url, body) {
  const raw = await httpPost(url, body);
  try { return JSON.parse(raw); } catch { return null; }
}

/** GET /status — 查询 Session Server 当前状态 */
export function getStatus(port = SERVER_PORT) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/status`, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

// ── 命令发送 ──

/** POST /send — 发送 prompt */
export function sendText(text, port = SERVER_PORT) {
  return httpPostJson(`http://127.0.0.1:${port}/send`, { text });
}

/** POST /cmd — 发送 slash command */
export function sendCmd(command, port = SERVER_PORT) {
  return httpPostJson(`http://127.0.0.1:${port}/cmd`, { cmd: command });
}

/** POST /respond — 向等待输入的 CC 发送回应 */
export function sendRespond(value, port = SERVER_PORT) {
  return httpPost(`http://127.0.0.1:${port}/respond`, { value });
}

/** GET /context-ready — 一次性消费上下文就绪标记（读取后服务端自动复位） */
export function getContextReady(port = SERVER_PORT) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/context-ready`, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(!!JSON.parse(data).ready); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

// ── 等待就绪 + 决策处理 ──

/**
 * 阻塞轮询直到 state === 'ready'
 *
 * 期间自动检测 decisionPending，调用 onDecision 回调处理，避免死锁。
 * 若未提供 onDecision，使用内置 autoSelect（等 5s 默认选第一项）。
 */
export function waitForReady({ onDecision, port = SERVER_PORT } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let lastDecision = null;

    async function poll() {
      if (Date.now() - start >= READY_TIMEOUT) {
        return reject(new Error('等待 Claude Code 就绪超时'));
      }
      const status = await getStatus(port);
      if (status.decisionPending) {
        const key = JSON.stringify(status.decisionPending);
        if (key !== lastDecision) {
          const handler = onDecision || autoSelect;
          const value = await handler(status.decisionPending);
          if (value !== undefined && value !== null) {
            await sendRespond(value, port);
          }
          lastDecision = key;
        }
        setTimeout(poll, POLL_INTERVAL);
        return;
      }
      if (status?.state === 'ready') return resolve();
      setTimeout(poll, POLL_INTERVAL);
    }

    poll();
  });
}

/** autoSelect 默认等待时间 (ms) */
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * 自动选择 AskUserQuestion 的答案
 * 当前策略：等 5s 后默认选第一项
 * @param {object} decision - { multiSelect, options, question, header }
 * @returns {Promise<object>} 选择方案
 */
export async function autoSelect(decision) {
  const timeout = DEFAULT_TIMEOUT_MS;

  if (decision.multiSelect && decision.options?.length > 0) {
    console.log(`     ⏳ ${timeout / 1000}s 后默认选第一项...`);
    await sleep(timeout);
    console.log(`     ✔ 自动选择: ${decision.options[0]}`);
    return { multiSelect: true, selected: [0], customInput: '' };
  }

  console.log(`     ⏳ ${timeout / 1000}s 后默认选第一项...`);
  await sleep(timeout);

  const label = decision.options?.[0] || '';
  console.log(`     ✔ 自动选择: ${label}`);
  return { index: 1, label };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
