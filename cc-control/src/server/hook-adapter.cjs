'use strict';
/**
 * hook-adapter.cjs — hook→领域事件翻译接缝（/hook 收口为 adapter.hook + 事件上抛）
 *
 * 现状：server.cjs /hook 直接按事件分流到状态/决策/落账逻辑（单槽）。多 run 分层后，
 * /hook 应收口为 adapter.hook(payload) → 领域事件上抛（events 总线），cc（Claude Code）
 * 细节在此接缝最小承接、由事件消费者（状态机/api/persist）处理。
 *
 * translateHook(payload) 把 claude hook payload 译为领域事件数组：
 *   - hook_event_name → HOOK_EVENT_MAP（SessionStart/Stop/SubagentStart/SubagentStop/UserPromptSubmit）
 *   - 提取最小 cc 细节：session_id / ts / hook_event_name
 * createHookAdapter({ emit }) 提供 .hook(payload, { runId })：翻译后逐事件 emit；
 *   PreToolUse/PostToolUse 及未知 hook → 不产出（当前决策/权限判断不在此接缝）。
 *
 * cc 载荷字段（agent id、subagent RESULT 等）的完整提取归 W1-046「hook payload→领域事件翻译完整」；
 * 本接缝保持最小、可被 046 扩展。
 */

const { HOOK_EVENT_MAP, createEvent } = require('../lib/events.cjs');

/** 事件所需的载荷字段最小映射（hook 字段 → 事件 payload 键）；缺省给默认占位 */
const FIELD_ANCHORS = {
  SessionStart: () => ({}),
  Stop: () => ({}),
  SubagentStart: (p) => ({ agentId: p.agent_transcript_path ? String(p.agent_transcript_path) : (p.session_id || 'agent') }),
  SubagentStop: (p) => ({ agentId: p.session_id || 'agent', taskId: p.task_id || null }),
  UserPromptSubmit: (p) => ({ phase: 'BUSY' }),
};

/** cc payload 需要透传的字段集（hook payload 的 cc 细节段归本 adapter 收口） */
const CC_FIELDS = [
  'session_id',
  'agent_id',
  'agent_transcript_path',
  'task_id',
  'stop_hook_active',
  'tool_name',
  'tool_input',
  'last_assistant_message',
  'permission',
];

/** 抽取 payload 中出现的 cc 字段（仅保留定义过的键） */
function pickCc(payload) {
  const cc = {};
  for (const k of CC_FIELDS) {
    if (payload[k] !== undefined) cc[k] = payload[k];
  }
  return cc;
}

/**
 * 把 claude hook payload 译为领域事件数组（供 events 总线消费）。
 * 事件 payload 除业务键外附 cc（透传的 cc 细节字段段），供后续消费者（状态机/api/persist）
 * 无需再碰 hook 原始载荷。
 * @param {object} payload claude hook payload（含 hook_event_name）
 * @returns {Array<{ type: string, at: string, runId: null, payload: object }>}
 */
function translateHook(payload) {
  const eventName = payload?.hook_event_name;
  const type = HOOK_EVENT_MAP[eventName];
  if (!type) return []; // PreToolUse/PostToolUse/未知 → 不产出

  const anchor = FIELD_ANCHORS[eventName] || (() => ({}));
  let eventPayload;
  try {
    eventPayload = anchor(payload);
  } catch {
    eventPayload = {};
  }
  eventPayload.cc = pickCc(payload);
  return [createEvent(type, eventPayload)];
}

/**
 * hook 适配器：.hook(payload,{runId}) 翻译并 emit 领域事件。
 * @param {{ emit: Function }} deps
 */
function createHookAdapter({ emit }) {
  if (typeof emit !== 'function') throw new Error('hook-adapter: emit 须为函数');
  return {
    hook(payload, { runId } = {}) {
      const events = translateHook(payload);
      for (const event of events) {
        emit({ ...event, runId: runId ?? null });
      }
      return events.length;
    },
  };
}

module.exports = { translateHook, createHookAdapter, FIELD_ANCHORS, CC_FIELDS, pickCc };
