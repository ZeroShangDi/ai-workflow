/**
 * bridge-client.js — AWF 指令通道的 **插件侧**（DSH 进程内）
 *
 * 与 AWF 侧 `server/adapters/dsh/bridge.cjs` 对偶：
 *   - 下行：连 AWF 的 WS `/bridge/dsh`，收 `{type:'command', commandId, op, args, projectRoot}`
 *   - 上行：`POST <awfBase>/bridge/dsh/callback`
 *       ① 收到指令立刻回 `{phase:'accepted'}`（= 已交给平台）
 *       ② 执行完回 `{phase:'result', ok, result|error}`
 *       ③ 平台事件（会话/子 Agent 生命周期）用 `{kind:'event', event, facts}` 主动上报
 *
 * 为什么先回 accepted：AWF 用「ack 与 result 两段窗口」区分「我没发出去」「发了但对面没收到」
 * 「已交给平台」三种结论。插件侧把 ack 放在**执行之前**，才让那条区分成立。
 *
 * 断线：只做**重连**，不重放（指令的去重/恢复归 AWF，spec §5）。重连成功即重新 attach。
 */

/** 重连退避（ms）：指数增长、封顶 10s，带抖动避免与其它实例同步 */
const BACKOFF_BASE_MS = 300;
const BACKOFF_MAX_MS = 10000;

/**
 * @param {object} opts
 * @param {string} opts.awfBase AWF server 基址（http://127.0.0.1:8787）
 * @param {string} opts.pluginVersion 插件版本（握手时带给 AWF，供其识别对接的是哪一版插件）
 * @param {(command: object) => Promise<{ok: boolean, result?: any, error?: string}>} opts.dispatch 指令执行器
 * @param {(level: string, msg: string) => void} [opts.log]
 * @param {Function} [opts.WebSocketImpl] 注入 WebSocket（测试用；缺省用全局）
 * @param {Function} [opts.fetchImpl] 注入 fetch（测试用）
 */
export function createBridgeClient({
  awfBase,
  pluginVersion = 'unknown',
  dispatch,
  log = (level, msg) => console.error(`[awf-dsh][${level}] ${msg}`),
  WebSocketImpl = globalThis.WebSocket,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!awfBase) throw new Error('awf-dsh: 缺少 awfBase（AWF server 基址）');
  if (typeof dispatch !== 'function') throw new Error('awf-dsh: 缺少 dispatch（指令执行器）');

  const wsBase = String(awfBase).replace(/^http/, 'ws').replace(/\/$/, '');
  const callbackUrl = `${String(awfBase).replace(/\/$/, '')}/bridge/dsh/callback`;
  let socket = null;
  let stopped = false;
  let attempts = 0;
  let timer = null;
  let connected = false;

  /** 上行一条回报；失败只记日志（不能因为回报失败就把插件打挂） */
  async function post(payload) {
    try {
      const res = await fetchImpl(callbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) log('warn', `回传 ${payload.phase || payload.kind} 失败：HTTP ${res.status}`);
    } catch (err) {
      log('warn', `回传异常：${err.message}`);
    }
  }

  /** 执行一条指令：先 accepted，再 result（两条回报都带同一个 commandId） */
  async function handleCommand(command) {
    const { commandId, op } = command || {};
    if (!commandId || !op) {
      log('warn', `忽略无法识别的指令：${JSON.stringify(command)?.slice(0, 120)}`);
      return;
    }
    await post({ commandId, phase: 'accepted' });
    let outcome;
    try {
      outcome = await dispatch(command);
    } catch (err) {
      outcome = { ok: false, error: err.message };
    }
    await post({ commandId, phase: 'result', ok: outcome?.ok !== false, result: outcome?.result, error: outcome?.error });
  }

  function scheduleReconnect() {
    if (stopped) return;
    attempts += 1;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1));
    const jitter = Math.floor(Math.random() * 100);
    timer = setTimeout(connect, delay + jitter);
  }

  function connect() {
    if (stopped) return;
    try {
      socket = new WebSocketImpl(`${wsBase}/bridge/dsh?pluginVersion=${encodeURIComponent(pluginVersion)}`);
    } catch (err) {
      log('warn', `连接 AWF 失败：${err.message}`);
      scheduleReconnect();
      return;
    }
    socket.onopen = () => {
      connected = true;
      attempts = 0;
      log('info', `已连上 AWF 指令通道：${wsBase}/bridge/dsh`);
    };
    socket.onmessage = (event) => {
      let command;
      try { command = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); }
      catch { log('warn', '收到无法解析的下行帧（已丢弃）'); return; }
      if (command?.type !== 'command') return; // 本通道只承载指令
      handleCommand(command);
    };
    socket.onerror = (err) => {
      // 带上原因：连不上时（端口写错、AWF server 没起）光看「出错」两个字查不出东西
      const reason = err?.message || err?.error?.message || (socket?.url ? `目标 ${socket.url}` : '未知');
      log('warn', `指令通道出错：${reason}`);
    };
    socket.onclose = (event) => {
      const wasConnected = connected;
      connected = false;
      socket = null;
      const detail = event?.code ? `code=${event.code}${event.reason ? ` reason=${event.reason}` : ''}` : '无关闭码';
      if (wasConnected) log('warn', `指令通道断开（${detail}），准备重连`);
      else log('info', `尚未连上（${detail}），按退避重试`);
      scheduleReconnect();
    };
  }

  return {
    start() {
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      try { socket?.close?.(); } catch { /* 已关 */ }
      socket = null;
      connected = false;
    },
    connected: () => connected,
    /** 主动上报平台事件（会话/子 Agent 生命周期） */
    emitEvent(event, facts) {
      return post({ kind: 'event', event, ...(facts ? { facts } : {}) });
    },
    /** 单测/诊断用：直接走一次回报 */
    _post: post,
  };
}
