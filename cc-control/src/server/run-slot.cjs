'use strict';
/**
 * run-slot.cjs — per-run 内存状态机（T1-071：ready/busy/decision 按 sid 隔离，不串 run）
 *
 * server.cjs 现状用一组模块级单槽变量描述正在跑的 run 会话（ready/busy/decisionPending/waiters…），
 * 多 run 后每 run 需独立内存态。本模块把一个 run 槽的内存态收敛为可独立持有的对象
 * （createRunSlot(sid)），语义镜像 server 单槽（setBusy/setReady/waitReady/setDecision/
 * clearDecision/snapshot/reset），供 /hook 按 sid 路由后操作对应槽。
 * 仅内存态隔离；落盘/落账仍走 server store。
 *
 * 没有 `contextReady`（issue 004-2）：槽里曾有一个同名字段 + `setContextReady()`，但全仓零调用 ——
 * `/status?sid` 因此返回一个**永假值**，而真正的上下文快照标记是**项目级**的 `pcx.contextReady`
 * （经 `/context-ready` 置位与一次性消费）。同名的两个东西里死掉的那个已摘除（宁缺勿假）；
 * 若将来上下文压缩要按 run 隔离，应把项目级标记整体搬进来，而不是再挂一个没人置位的影子字段。
 */

function createRunSlot(sid) {
  let state = 'ready'; // 'ready' | 'busy'
  let decisionPending = null; // null | { type, question, options?, multiSelect?, header?, source?, answer?, answered? }
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

  function snapshot() {
    return {
      sid: sid ?? null,
      state,
      decisionPending,
      activeWaiters: waiters.length,
    };
  }

  function reset() {
    state = 'ready';
    decisionPending = null;
    waiters = [];
  }

  return {
    sid: sid ?? null,
    get state() { return state; },
    value: () => state,
    get decisionPending() { return decisionPending; },
    setReady,
    setBusy,
    waitReady,
    setDecision,
    clearDecision,
    snapshot,
    reset,
  };
}

module.exports = { createRunSlot };
