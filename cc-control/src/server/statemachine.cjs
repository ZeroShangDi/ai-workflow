'use strict';
/**
 * statemachine.cjs — run 会话状态机（单槽 → 按 sid 实例）
 *
 * 现行 server.cjs 用一组全局单槽（ready/busy/deciding/pause 等）描述正在跑的 run 会话；
 * 多 run（sid）后需每 run 独立状态。本模块提供：
 *   createStateMachine(sid)：单实例状态机（state/get/set/can + change 通知）
 *   createStateMachineRegistry()：sid → 实例 注册表（缺省 null sid 承载单 run 现状）
 *
 * 状态与迁移矩阵为现行语义的脚手架近似，最终精确迁移矩阵（含 hook 事件触发、pause 闩锁）
 * 由 W1-071「server /hook 按 sid 路由 + 状态机隔离」任务接现有实现定稿。本模块纯内存、不改写现状。
 */

const STATES = ['idle', 'ready', 'busy', 'deciding', 'paused', 'error'];

/** 允许迁移表（脚手架近似：busy/deciding/paused 之间可按事件回退；error 可恢复 ready） */
const TRANSITIONS = {
  idle: ['ready'],
  ready: ['busy', 'paused'],
  busy: ['ready', 'deciding', 'paused', 'error'],
  deciding: ['ready', 'busy', 'paused', 'error'],
  paused: ['ready'],
  error: ['ready'],
};

function assertState(s) {
  if (!STATES.includes(s)) throw new Error(`statemachine: 未知状态 ${s}`);
}

/**
 * @param {{ sid?: string, initialState?: string, onChange?: (state, prev, machine) => void }} opts
 */
function createStateMachine({ sid = null, initialState = 'idle', onChange } = {}) {
  assertState(initialState);
  let state = initialState;

  function can(next) {
    assertState(next);
    return TRANSITIONS[state].includes(next);
  }

  /** 允许迁移则置状态并触发 onChange；不允许抛错 */
  function set(next, { by } = {}) {
    assertState(next);
    if (!can(next)) {
      throw new Error(`statemachine[${sid}]: 非法迁移 ${state} → ${next}`);
    }
    const prev = state;
    state = next;
    onChange?.(state, prev, machine);
    return { from: prev, to: state, by: by || null };
  }

  /** 强制置状态（紧急/兜底，不查迁移表） */
  function force(next, { by } = {}) {
    assertState(next);
    const prev = state;
    state = next;
    onChange?.(state, prev, machine);
    return { from: prev, to: state, by: by || null };
  }

  const machine = {
    sid,
    get state() { return state; },
    value: () => state,
    can,
    set,
    force,
  };
  return machine;
}

/**
 * 按 sid 的实例注册表（单 run 现状用 sid=null）。
 *   get(sid, { autoCreate=true })：惰性建实例并共享 registry onChange
 *   list() / delete(sid) / onChange 全局订阅
 */
function createStateMachineRegistry({ onChange } = {}) {
  const machines = new Map();

  function get(sid, { autoCreate = true } = {}) {
    const key = sid ?? null;
    let m = machines.get(key);
    if (!m && autoCreate) {
      m = createStateMachine({ sid: key, initialState: 'idle', onChange: onChange || (() => {}) });
      machines.set(key, m);
    }
    return m;
  }

  function list() {
    return [...machines.entries()].map(([sid, m]) => ({ sid, state: m.state }));
  }

  function remove(sid) {
    machines.delete(sid ?? null);
  }

  return { get, list, remove, has: (sid) => machines.has(sid ?? null) };
}

module.exports = { STATES, TRANSITIONS, createStateMachine, createStateMachineRegistry };
