'use strict';
/**
 * run-slot.cjs — per-run 内存状态机（T1-071：ready/busy/decision 按 sid 隔离，不串 run）
 *
 * server.cjs 现状用一组模块级单槽变量描述正在跑的 run 会话（ready/busy/decisionPending/
 * contextReady/waiters…），多 run 后每 run 需独立内存态。本模块把一个 run 槽的内存态
 * 收敛为可独立持有的对象（createRunSlot(sid)），语义镜像 server 单槽（setBusy/setReady/
 * waitReady/setDecision/clearDecision/snapshot/reset），供 /hook 按 sid 路由后操作对应槽。
 * 仅内存态隔离；落盘/落账仍走 server store。
 */

function createRunSlot(sid) {
  let state = 'ready'; // 'ready' | 'busy'
  let decisionPending = null; // null | { type, question, options?, multiSelect?, header?, source?, answer?, answered? }
  let contextReady = false; // awf_context_ready 置位（CLI 一次性消费）
  let waiters = []; // waitReady 等待者

  function setReady() {
    state = 'ready';
    const pending = waiters;
    waiters = [];
    for (const fn of pending) fn();
  }

  function setBusy() {
    state = 'busy';
  }

  /** 等待该槽 ready；超时 false */
  function waitReady(timeout) {
    if (state === 'ready') return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        waiters = waiters.filter((w) => w !== fn);
        resolve(false);
      }, timeout);
      const fn = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(true);
      };
      waiters.push(fn);
    });
  }

  function setDecision(d) { decisionPending = d; }
  function clearDecision() { decisionPending = null; }
  function setContextReady(v) { contextReady = !!v; }

  function snapshot() {
    return {
      sid: sid ?? null,
      state,
      decisionPending,
      contextReady,
      activeWaiters: waiters.length,
    };
  }

  function reset() {
    state = 'ready';
    decisionPending = null;
    contextReady = false;
    waiters = [];
  }

  return {
    sid: sid ?? null,
    get state() { return state; },
    value: () => state,
    get decisionPending() { return decisionPending; },
    get contextReady() { return contextReady; },
    setReady,
    setBusy,
    waitReady,
    setDecision,
    clearDecision,
    setContextReady,
    snapshot,
    reset,
  };
}

module.exports = { createRunSlot };
