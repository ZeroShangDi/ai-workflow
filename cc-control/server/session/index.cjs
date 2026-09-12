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
 *   - 只管**内存态**，不落盘：持久化走 `ctx.stores`（出口之一）。
 *   - 不含「当前是不是决策模式」的判定规则：`decisionGate` 只是承载位，判定在 decision 模块。
 *   - 不知道 cc / tmux 的任何事：注入由调用方经 `ctx.tmux` 完成。
 *
 * ready/busy 状态机（全链路的核心语义）：
 *   - 会话默认 `ready`；`/send`（或 /intervene /respond）注入后置 `busy`；
 *     CC 的 Stop hook（或本地命令/决策的兜底定时器）把它放回 `ready`。
 *   - `waitReady(timeout)` 是「等这个回合结束」的同步点：就绪立即 true；busy 则排队等唤醒或超时。
 *   - 只有**主会话**翻这个闩锁 —— 子 agent 的 SessionStart/Stop 不应把主会话拉回 ready（靠 mainSessionId 区分）。
 *   - 兜底定时器兜的是「CC 不回 Stop」的情况，防止会话永久卡 busy。
 */

/**
 * @param {{ sid?: string|null, decisionSeqGen?: object|null }} opts
 *   sid            本会话的 run 标签（多 run 分片用；主槽为 null）
 *   decisionSeqGen 决策序号生成器（由 decision 侧注入 —— 本模块不 import 能力层）
 * @returns Session 对象：私有状态 + 访问器（getter/setter）+ 一次性闩锁的消费方法
 */
function createSession({ sid = null, decisionSeqGen = null } = {}) {
  let state = 'ready';        // 'ready' | 'busy'
  let decisionPending = null; // null | { type, question, options?, multiSelect?, header?, source?, answer?, answered? }
  let waiters = [];           // waitReady 等待者（每项是「被唤醒时调用」的 resolve 包装）
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
    waiters = []; // 先清空再逐个调用：重置期间新排入的 waiter 不该被本轮唤醒
    for (const fn of pending) fn();
  }

  function setBusy() {
    state = 'busy';
  }

  /** 等本会话 ready；超时返回 false（不抛 —— 由调用方决定下一步） */
  function waitReady(timeout) {
    if (state === 'ready') return Promise.resolve(true); // 快路径：已就绪，不排队
    return new Promise((resolve) => {
      let done = false; // 防「超时后又就绪」或「就绪后又超时」的双重结算
      const fn = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        waiters = waiters.filter((w) => w !== fn); // 超时要把自己从等待集摘掉，否则 setReady 会调用已结算的 fn
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

  /** 内存态快照（观测/测试用；waiters 只暴露数量，不暴露函数本身） */
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

  /** 全量复位（测试 / 项目 reset 用）：回到初始态并清兜底定时器 */
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

    // 只读访问器：外部读取当前态；写一律走下方具名方法（避免直接赋值绕过语义）
    get state() { return state; },
    get decisionPending() { return decisionPending; },
    get fallbackTimer() { return fallbackTimer; },
    get contextReady() { return contextReady; },
    get mainSessionId() { return mainSessionId; },
    get sessionSeq() { return sessionSeq; },
    get decisionGate() { return decisionGate; },
    get decisionResume() { return decisionResume; },
    get decisionSeqGen() { return decisionSeqGen; },

    // 仅这两个字段允许直接赋值（mainSessionId 由 SessionStart 记；decisionGate 由 decision 模块托放）
    set mainSessionId(v) { mainSessionId = v; },
    set decisionGate(v) { decisionGate = v; },

    bumpSessionSeq() { sessionSeq += 1; return sessionSeq; }, // 返回自增后的值，供调用方直接用
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
