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
 * ⚠️ 遗留/疑似死代码（2026-09 复查，只记录不删）：本文件是 `src/server/run-slot.cjs` 的副本，
 *   文件名（run-slot.cjs）与路径（server/session/slot.cjs）不符，且全仓**零引用**——
 *   grep `session/slot` / `createRunSlot` 只在本文件自身命中；测试 import 的是
 *   `src/server/run-slot.cjs`，生产 require 的也是 `./run-slot.cjs`。
 *   per-sid 隔离能力已由 `session/index.cjs` 的 `createSession({ sid })` 在新 runtime 里承接
 *   （runtime.sessionFor 懒建 sid 槽）。若无明确复活计划，本文件应从树中移除（删前再确认一次引用）。
 *
 * 没有 `contextReady`（issue 004-2）：槽里曾有一个同名字段 + `setContextReady()`，但全仓零调用 ——
 * `/status?sid` 因此返回一个**永假值**，而真正的上下文快照标记是**项目级**的 `pcx.contextReady`
 * （经 `/context-ready` 置位与一次性消费）。同名的两个东西里死掉的那个已摘除（宁缺勿假）；
 * 若将来上下文压缩要按 run 隔离，应把项目级标记整体搬进来，而不是再挂一个没人置位的影子字段。
 */

/**
 * 建一个 run 槽内存态。
 * @param {string} sid run 标签（仅用于快照展示）
 * @returns 槽对象：私有状态 + 访问器 + ready/busy/decision 方法
 */
function createRunSlot(sid) {
  let state = 'ready'; // 'ready' | 'busy'
  let decisionPending = null; // null | { type, question, options?, multiSelect?, header?, source?, answer?, answered? }
  let waiters = []; // waitReady 等待者

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

  /** 等待该槽 ready；超时 false */
  function waitReady(timeout) {
    if (state === 'ready') return Promise.resolve(true); // 快路径：已就绪
    return new Promise((resolve) => {
      let done = false; // 防就绪/超时双重结算
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

  /** 内存态快照（观测/测试用） */
  function snapshot() {
    return {
      sid: sid ?? null,
      state,
      decisionPending,
      activeWaiters: waiters.length,
    };
  }

  /** 全量复位到初始态 */
  function reset() {
    state = 'ready';
    decisionPending = null;
    waiters = [];
  }

  return {
    sid: sid ?? null,
    get state() { return state; },
    value: () => state, // 冗余于 getter state，历史遗留（调用方可能用 value()）
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
