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
 *
 * 边界：本文件是**纯翻译 + 上抛**，不做任何副作用（不写 state、不调度）。事件类型的定义与必需载荷键
 * 定义在 observability/events.cjs（HOOK_EVENT_MAP / EVENT_DEFS），真正的语义由事件消费者决定。
 * 因此这里对「哪些 hook 产出事件」的取舍，必须与 HOOK_EVENT_MAP 保持一致（见 translateHook）。
 */

// HOOK_EVENT_MAP：hook_event_name → 领域事件 type（值为 null 表示该 hook 不产出事件）
// createEvent：把 (type, payload) 归一化为 { type, at, runId, payload }，缺必需载荷键会抛错
const { HOOK_EVENT_MAP, createEvent } = require('../../observability/events.cjs');

/**
 * 事件所需的载荷字段最小映射（hook 字段 → 事件 payload 键）；缺省给默认占位。
 * key = hook 事件名，value = (payload) => 事件额外载荷。
 * 为什么每个都要给默认值：createEvent 对 EVENT_DEFS 里声明的必需键做「undefined 即抛错」校验，
 * 兜底占位是为了「hook 载荷不全时也不让事件翻译崩掉」（宁可事件载荷弱一点，也不能阻断 hook 链路）。
 */
const FIELD_ANCHORS = {
  SessionStart: () => ({}), // run.started 无必需载荷键
  Stop: () => ({}),         // run.stopped 无必需载荷键
  // agent.started 必需 agentId：优先用 transcript 路径（每个子 agent 唯一），
  // 退而用 session_id，最后硬编码 'agent' —— 三级兜底，确保 agentId 永不为空
  SubagentStart: (p) => ({ agentId: p.agent_transcript_path ? String(p.agent_transcript_path) : (p.session_id || 'agent') }),
  // agent.stopped 必需 agentId + taskId；taskId 允许 null（无法关联到任务时）
  SubagentStop: (p) => ({ agentId: p.session_id || 'agent', taskId: p.task_id || null }),
  // run.phase 必需 phase；UserPromptSubmit 表示用户提交了输入 → 会话进入忙碌
  UserPromptSubmit: (p) => ({ phase: 'BUSY' }),
};

/**
 * cc payload 需要透传的字段集（hook payload 的 cc 细节段归本 adapter 收口）。
 * 这些是下游消费者（决策门阀 / 落账 / 状态机 / 诊断）会用到的 cc 细节；在这里一次性摘出附到事件
 * payload.cc 上，消费者就不必再接触 hook 原始载荷、也不必知道 cc 的字段名（cc 改名只改这份清单）。
 */
const CC_FIELDS = [
  'session_id',             // cc 会话标识（多 run 时用于路由）
  'agent_id',               // 子 agent 标识
  'agent_transcript_path',  // 子 agent transcript 落点（SubagentStart 拿它当 agentId）
  'task_id',                // 子 agent 关联的 awf 任务 id
  'stop_hook_active',       // Stop hook 防重入标志（避免 block→再触发 的死循环）
  'tool_name',              // PreToolUse/PostToolUse：被调用的工具名
  'tool_input',             // 工具入参（决策门阀判断是否放行时看）
  'last_assistant_message', // 末条助手消息（RESULT/NEEDS_INPUT 的提取来源）
  'permission',             // 权限诉求相关字段
];

/** 抽取 payload 中出现的 cc 字段（仅保留定义过的键）：白名单机制，未知字段不进入事件 */
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
  if (!type) return []; // 映射为 null/未定义者（PreToolUse/PostToolUse/未知 hook）→ 不产出事件

  // 取该事件的载荷锚点；FIELD_ANCHORS 里没有的事件（当前不会发生，因映射表是子集）退化为空载荷
  const anchor = FIELD_ANCHORS[eventName] || (() => ({}));
  let eventPayload;
  try {
    eventPayload = anchor(payload);
  } catch {
    // 锚点函数抛错时降级为空载荷：hook 链路不能因为个别字段异常而整条断掉
    eventPayload = {};
  }
  // cc 细节整段透传（与业务键并列放在 payload.cc，见 CC_FIELDS 注释）
  eventPayload.cc = pickCc(payload);
  return [createEvent(type, eventPayload)];
}

/**
 * hook 适配器：.hook(payload,{runId}) 翻译并 emit 领域事件。
 * @param {{ emit: Function }} deps  emit 即事件总线的 emit（缺失直接抛错，是接线错误而非运行期噪声）
 * @returns {{ hook(payload, ctx?): number }}  hook() 返回本次 emit 的事件条数（0 表示该 hook 不产出事件）
 */
function createHookAdapter({ emit }) {
  if (typeof emit !== 'function') throw new Error('hook-adapter: emit 须为函数');
  return {
    hook(payload, { runId } = {}) {
      const events = translateHook(payload);
      for (const event of events) {
        // runId 归一到顶层字段（缺省 null），与 events.cjs 的事件归一化形态一致
        emit({ ...event, runId: runId ?? null });
      }
      return events.length;
    },
  };
}

// translateHook/pickCc/FIELD_ANCHORS/CC_FIELDS 一并导出，供单测直接验证翻译细节（不必起总线）
module.exports = { translateHook, createHookAdapter, FIELD_ANCHORS, CC_FIELDS, pickCc };
