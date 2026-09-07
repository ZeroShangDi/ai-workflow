'use strict';
/**
 * events.cjs — 进程内事件总线 + 首批领域事件类型定义（run/task/agent/hook 映射锚点）
 *
 * 供 W3-003/004（hook→事件翻译、api 推送、persist-pipeline 落盘）消费。事件归一化形态：
 *   { type, at, runId?, payload }
 * EVENT_DEFS 记录首批类型及其必需载荷键与「映射锚点」：
 *   - source      来自哪（claude hook / run driver / scheduler…）——hook 翻译接缝(→W1-031/046)
 *   - persist     落到 persist-pipeline 的哪个 sink 类型（T1-024 的 dispatchEvent type；无则 -
 * 总线为进程内同步：on(type|'*', fn) 订阅、emit 依注册顺序调用，单个 handler 异常被吞（日志）保证总线韧性。
 * 本模块纯内存、不改写任何现有逻辑。
 */

/** 事件类型目录：type → { source, persist?, payloadKeys } */
const EVENT_DEFS = {
  // run 生命周期（run driver / statemachine；runId 走顶层字段，非 payload 键）
  'run.started': { source: 'run.driver', persist: 'log.append', payloadKeys: [] },
  'run.stopped': { source: 'run.driver', persist: 'log.append', payloadKeys: [] },
  'run.phase': { source: 'run.driver', payloadKeys: ['phase'] },
  // task 生命周期（scheduler / awf-state / settle）
  'task.started': { source: 'scheduler', payloadKeys: ['taskId'] },
  'task.done': { source: 'settle', persist: 'meta.patch', payloadKeys: ['taskId'] },
  'task.blocked': { source: 'settle', persist: 'meta.patch', payloadKeys: ['taskId'] },
  // agent 生命周期（SubagentStart/Stop hook）
  'agent.started': { source: 'hook.subagent_start', payloadKeys: ['agentId'] },
  'agent.stopped': { source: 'hook.subagent_stop', payloadKeys: ['agentId', 'taskId'] },
  // usage / metrics / decision 快照（persist-pipeline 直接消费）
  'usage.snapshot': { source: 'statusline/context-usage', persist: 'usage.snapshot', payloadKeys: [] },
  'metrics.snapshot': { source: 'run.metrics', persist: 'metrics.snapshot', payloadKeys: [] },
  'decision.record': { source: 'decision.gate', persist: 'decision.record', payloadKeys: ['decisionId'] },
};

/** hook → 事件映射锚点（供 W1-031/046 hook 翻译接缝引用） */
const HOOK_EVENT_MAP = {
  SessionStart: 'run.started',
  Stop: 'run.stopped',
  SubagentStart: 'agent.started',
  SubagentStop: 'agent.stopped',
  PreToolUse: null, // 由 decision/权限判断决定是否成事件
  PostToolUse: null,
  UserPromptSubmit: 'run.phase',
};

/** 事件类型集合（供校验/订阅参考） */
const EVENT_TYPES = Object.keys(EVENT_DEFS);

/** 归一化事件：补 at/runId；缺必需载荷键抛错 */
function createEvent(type, payload = {}, runId) {
  const def = EVENT_DEFS[type];
  if (!def) throw new Error(`events: 未知事件类型 ${type}`);
  for (const k of def.payloadKeys) {
    if (payload[k] === undefined) throw new Error(`events: ${type} 缺少必需载荷键 ${k}`);
  }
  return { type, at: new Date().toISOString(), runId: runId ?? null, payload };
}

/** 事件 → persist-pipeline sink type（无 → null） */
function persistSinkFor(type) {
  const def = EVENT_DEFS[type];
  return def?.persist || null;
}

/**
 * 进程内事件总线。
 *   on(type|'*', fn) → off()  ；emit(event) → 命中 handler 数；单 handler 异常被吞。
 */
function createEventBus() {
  const typeHandlers = new Map(); // type → Set<fn>
  let wildcards = [];

  function on(type, fn) {
    if (typeof fn !== 'function') throw new Error('events.on: fn 须为函数');
    if (type === '*') {
      wildcards.push(fn);
      return () => { wildcards = wildcards.filter((f) => f !== fn); };
    }
    if (!typeHandlers.has(type)) typeHandlers.set(type, new Set());
    typeHandlers.get(type).add(fn);
    return () => { typeHandlers.get(type)?.delete(fn); };
  }

  function emit(event) {
    const { type } = event;
    const set = typeHandlers.get(type);
    let handled = 0;
    const run = (fn) => {
      handled += 1; // 计数尝试调用的 handler（异常被吞仍算已调用）
      try { fn(event); } catch (err) { console.error(`[events] handler error on ${type}: ${err.message}`); }
    };
    set?.forEach(run);
    for (const w of wildcards) run(w);
    return handled;
  }

  return { on, emit, types: () => [...typeHandlers.keys()] };
}

/** 便捷：把 persist-pipeline sinks 接到总线上（按事件 persist 锚点分发；无锚点事件忽略） */
function wirePersist(bus, sinks, { dispatch } = {}) {
  return bus.on('*', (event) => {
    const sinkType = persistSinkFor(event.type);
    if (!sinkType) return;
    const payload = event.payload || {};
    dispatch({ type: sinkType, payload });
  });
}

module.exports = { EVENT_DEFS, HOOK_EVENT_MAP, EVENT_TYPES, createEvent, persistSinkFor, createEventBus, wirePersist };
