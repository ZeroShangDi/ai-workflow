'use strict';
/**
 * bridge.cjs — AWF ↔ DSH 插件 的**指令通道**（AWF 侧，传输无关）
 *
 * 依据 spec §2「建议的最小通信方案」：
 *   - **指令下行**：AWF → 插件走独立 WS（`server/web` 的 upgrade 路由，P2-5 接线）；
 *   - **确认/结果上行**：插件 → AWF 走 HTTP POST（与既有 hook 回传同一形态）。
 * 本模块只管「一条指令的生命周期」，不碰 socket / http：`send(command)` 与
 * `onCallback(payload)` 由传输层（P2-5）注入，因此**可单测、可替身**。
 *
 * ## 三种送达结论（不能混用，spec §6 原则）
 *   - `not-delivered` **未交给平台**：通道未连接，或 `send` 直接抛错；
 *   - `unconfirmed`   **无法确认**：帧已发出，但平台未在 ack 窗口内确认收到
 *                     —— 这**不等于失败**，也不等于执行；调用方必须按「未知」处理；
 *   - `accepted`      **已交给平台**：平台回了 accepted；随后等 result。
 * 结果超时也归 `accepted` + `error`：**已交给平台但结果未知**，不得显示为成功。
 *
 * ## 为什么要有 ack 这一层
 * 「写进 socket」既不能证明对端收到，也不能证明它受理。把 ack 与 result 分成两段，
 * 才能让上层区分「我没发出去」和「我发了但不知道对面怎么样」—— 这正是 F34/T3 要求的口径。
 */

const { randomUUID } = require('node:crypto');

/** ack 窗口：平台应在此时间内确认「收到指令」（不含执行时长） */
const DEFAULT_ACK_TIMEOUT_MS = 5000;
/** 结果窗口：长任务（建会话/派发/等回合）可能很久，缺省 2 分钟，按 op 可覆盖 */
const DEFAULT_RESULT_TIMEOUT_MS = 120000;

/**
 * 建一条指令通道。
 *
 * @param {object} deps
 * @param {(command: object) => void} deps.send 传输层发送一帧（WS 写帧）；抛错 = 未交给平台
 * @param {number} [deps.ackTimeoutMs] 等 accepted 的窗口（ms）
 * @param {number} [deps.resultTimeoutMs] 等 result 的窗口（ms）
 * @param {Function} [deps.setTimer] 定时器注入（测试用）
 * @param {Function} [deps.clearTimer]
 * @returns {object} 见下方方法注释
 */
function createDshBridge({
  send,
  ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS,
  resultTimeoutMs = DEFAULT_RESULT_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  /** 在途指令：commandId → entry */
  const pending = new Map();
  /** 平台事实（最近一次已知值）：会话是否存在/可达/就绪；由事件或 probe 结果刷新 */
  let facts = { sessionExists: null, reachable: null, ready: null, updatedAt: null, sessionId: null };
  /** 事件订阅者（hook 端口消费） */
  const eventHandlers = new Set();
  let connected = false;
  let detachedReason = null;

  /**
   * 收尾一条在途指令（幂等：ack/result/超时谁先到谁算）。
   * @param {object} entry
   * @param {object} payload 送达结论
   */
  function settle(entry, payload) {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.timer) clearTimer(entry.timer);
    pending.delete(entry.commandId);
    entry.resolve({ commandId: entry.commandId, op: entry.op, ...payload });
  }

  return {
    /** 通道是否已连接（插件 host 半侧已握手） */
    connected() {
      return connected;
    },

    /** 传输层握手成功后调用；`meta` 可带平台/版本事实（用于版本可识别，spec §6 原则） */
    attach(meta = {}) {
      connected = true;
      detachedReason = null;
      if (meta.platform) facts = { ...facts, platform: meta.platform, pluginVersion: meta.pluginVersion ?? null };
    },

    /**
     * 通道断开。**不自动重发在途指令**（spec §5：连接恢复 ≠ 任务恢复）；
     * 在途指令一律判为 `unconfirmed`（发过，但结果未知），并保留下载现场。
     * @param {string} [reason]
     */
    detach(reason = 'channel closed') {
      connected = false;
      detachedReason = reason;
      for (const entry of [...pending.values()]) {
        settle(entry, { delivery: 'unconfirmed', error: `通道断开：${reason}（此前已发出的指令结果未知）` });
      }
    },

    /** 断开原因（未断开 → null） */
    detachedReason() {
      return detachedReason;
    },

    /** 在途指令数（诊断/测试） */
    pendingCount() {
      return pending.size;
    },

    /** 最近一次已知的平台事实（同步；probe 取新鲜事实请走 `probe.inspect()`） */
    lastFacts() {
      return { ...facts };
    },

    /** 刷新平台事实（插件事件或 probe 结果进来时调用） */
    noteFacts(patch = {}) {
      facts = { ...facts, ...patch, updatedAt: new Date().toISOString() };
      return { ...facts };
    },

    /** 订阅平台事件（插件经 HTTP POST 上行）；返回退订函数 */
    onEvent(handler) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },

    /**
     * 发一条指令并等结论。
     * @param {string} op 指令名，如 'session.create' / 'session.prompt'
     * @param {object} [args] 指令参数
     * @param {{ projectRoot?: string, resultTimeoutMs?: number }} [opts]
     * @returns {Promise<{commandId: string, op: string, delivery: 'accepted'|'unconfirmed'|'not-delivered',
     *   ok?: boolean, result?: any, error?: string}>}
     */
    request(op, args = {}, { projectRoot, resultTimeoutMs: perOpResultMs } = {}) {
      const commandId = randomUUID();
      if (!connected) {
        return Promise.resolve({
          commandId, op, delivery: 'not-delivered',
          error: `指令通道未连接（未交给平台）${detachedReason ? `：${detachedReason}` : ''}`,
        });
      }

      const resultWindow = perOpResultMs ?? resultTimeoutMs;
      return new Promise((resolve) => {
        const entry = { commandId, op, resolve, settled: false, timer: null };
        pending.set(commandId, entry);

        // 第一段：ack 窗口。没等到就判「无法确认」，不判失败。
        entry.timer = setTimer(() => {
          settle(entry, {
            delivery: 'unconfirmed',
            error: `平台未在 ${ackTimeoutMs}ms 内确认收到指令（已发出，是否执行未知）`,
          });
        }, ackTimeoutMs);

        try {
          send({ type: 'command', commandId, op, args, projectRoot, at: new Date().toISOString() });
        } catch (err) {
          settle(entry, { delivery: 'not-delivered', error: `发送失败：${err.message}` });
          return;
        }

        // 第二段：ack 到达后换成结果窗口（由 onCallback 触发）
        entry.armResult = () => {
          if (entry.settled) return;
          if (entry.timer) clearTimer(entry.timer);
          entry.timer = setTimer(() => {
            settle(entry, {
              delivery: 'accepted',
              error: `已交给平台，但 ${resultWindow}ms 内未回结果（结果未知，不得视为成功）`,
            });
          }, resultWindow);
        };
      });
    },

    /**
     * 传输层把插件 POST 上来的回报喂进来。
     * @param {{commandId?: string, phase?: string, kind?: string, ok?: boolean, result?: any, error?: string, event?: object, facts?: object}} payload
     * @returns {boolean} 是否被本通道消费（false = 未知 commandId / 非本通道消息，调用方自行记日志）
     */
    onCallback(payload = {}) {
      // 平台事件（非指令回报）：分发给订阅者，并顺手刷新事实
      if (payload.kind === 'event' || payload.event) {
        if (payload.facts) this.noteFacts(payload.facts);
        for (const h of eventHandlers) {
          try { h(payload.event ?? payload); } catch { /* 单个订阅者异常不影响通道 */ }
        }
        return true;
      }

      const entry = pending.get(payload.commandId);
      if (!entry) return false;

      if (payload.phase === 'accepted') {
        entry.armResult();
        return true;
      }
      if (payload.phase === 'result' || payload.phase === 'error' || payload.ok !== undefined) {
        settle(entry, {
          delivery: 'accepted',
          ok: payload.ok !== false,
          result: payload.result,
          ...(payload.error ? { error: payload.error } : {}),
        });
        return true;
      }
      return false;
    },
  };
}

module.exports = {
  createDshBridge,
  DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_RESULT_TIMEOUT_MS,
};
