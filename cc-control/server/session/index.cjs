'use strict';
/**
 * session/index.cjs — 会话内存态（per-session）
 *
 * 抽象动机：原 server 把「一个会话的全部内存态」拆成两套并行机制 —— 主槽散在 `pcx` 上
 * （`pcx.state` / `pcx.decisionPending` / `pcx.waiters` / `pcx.fallbackTimer` / `pcx.contextReady`
 * / `pcx.mainSessionId` / `pcx.sessionSeq` / `pcx.decisionGate` / `pcx.decisionResume`），
 * 而 per-sid 槽另有 `run-slot.cjs` 的 `createRunSlot`。两者语义相同、字段重叠，却各写一遍。
 *
 * 本模块把「一个会话的内存态」收敛成**一个对象**：主槽是一个 Session，每个 sid 也是一个 Session。
 * 好处：状态有归属 —— 谁持有、谁能改、生命周期到哪结束，都在一个文件里看得见；server 不再
 * 往一个共享可变对象上贴字段。
 *
 * 边界（明确不做什么）：
 *   - 只管**内存态**，不落盘：持久化走 `pcx.stores`（出口之一）。
 *   - 不含「当前是不是决策模式」的判定规则：`decisionGate` 只是承载位，判定在 decision 模块。
 *   - 不知道 cc / tmux 的任何事：注入由调用方经 `pcx.tmux` 完成。
 */

/**
 * @param {{ sid?: string|null, decisionSeqGen?: object|null }} opts
 *   sid            本会话的 run 标签（多 run 分片用；主槽为 null）
 *   decisionSeqGen 决策序号生成器（由 decision 侧注入 —— 本模块不 import 能力层）
 */
function createSession({ sid = null, decisionSeqGen = null } = {}) {
  let state = 'ready';        // 'ready' | 'busy'
  let decisionPending = null; // null | { type, question, options?, multiSelect?, header?, source?, answer?, answered? }
  let waiters = [];           // waitReady 等待者
  let fallbackTimer = null;   // 本地命令兜底回 ready 的定时器
  let contextReady = false;   // 上下文快照已就绪（一次性消费）
  let mainSessionId = null;   // 主会话 id（区分主/子 agent，子 agent 不翻 ready/busy 闩锁）
  let sessionSeq = 0;         // 会话启动序号：每次 SessionStart +1（单调；供 CLI 判定「本次会话已就绪」）
  let decisionGate = null;    // null | { phase:'deciding', startedAt }（决策门阀承载位）
  let decisionResume = null;  // 决策结束后待注入的续跑指令（一次性消费）

  /** 置 ready 并唤醒全部等待者（waiters 一次性清空） */
  function setReady() {
    state = 'ready';
    const pending = waiters;
    waiters = [];
    for (const fn of pending) fn();
  }

  function setBusy() {
    state = 'busy';
  }

  /** 等本会话 ready；超时返回 false（不抛 —— 由调用方决定下一步） */
  function waitReady(timeout) {
    if (state === 'ready') return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const fn = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        waiters = waiters.filter((w) => w !== fn);
        resolve(false);
      }, timeout);
      waiters.push(fn);
    });
  }

  function setDecision(d) { decisionPending = d; }
  function clearDecision() { decisionPending = null; }

  function setFallbackTimer(timer) { fallbackTimer = timer; }
  function clearFallbackTimer() {
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
  }

  function snapshot() {
    return {
      sid: sid ?? null,
      state,
      decisionPending,
      activeWaiters: waiters.length,
      contextReady,
      mainSessionId,
      sessionSeq,
      decisionGate,
      decisionResume,
    };
  }

  function reset() {
    state = 'ready';
    decisionPending = null;
    waiters = [];
    contextReady = false;
    mainSessionId = null;
    sessionSeq = 0;
    decisionGate = null;
    decisionResume = null;
    clearFallbackTimer();
  }

  /** 上下文快照就绪标记：置位后由消费方一次性取走（消费即清） */
  function setContextReady() { contextReady = true; }
  function consumeContextReady() {
    const v = contextReady;
    contextReady = false;
    return v;
  }

  /** 决策续跑指令：置位后由消费方一次性取走 */
  function setDecisionResume(text) { decisionResume = text; }
  function consumeDecisionResume() {
    const v = decisionResume;
    decisionResume = null;
    return v;
  }

  return {
    sid: sid ?? null,

    get state() { return state; },
    get decisionPending() { return decisionPending; },
    get fallbackTimer() { return fallbackTimer; },
    get contextReady() { return contextReady; },
    get mainSessionId() { return mainSessionId; },
    get sessionSeq() { return sessionSeq; },
    get decisionGate() { return decisionGate; },
    get decisionResume() { return decisionResume; },
    get decisionSeqGen() { return decisionSeqGen; },

    set mainSessionId(v) { mainSessionId = v; },
    set decisionGate(v) { decisionGate = v; },

    bumpSessionSeq() { sessionSeq += 1; return sessionSeq; },
    setContextReady,
    consumeContextReady,
    setDecisionResume,
    consumeDecisionResume,

    setReady,
    setBusy,
    waitReady,
    setDecision,
    clearDecision,
    setFallbackTimer,
    clearFallbackTimer,
    snapshot,
    reset,
  };
}

module.exports = { createSession };
