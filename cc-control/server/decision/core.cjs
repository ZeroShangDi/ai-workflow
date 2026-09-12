'use strict';
/**
 * decision.cjs — 决策结果解析与轻量校验（src/server/）
 *
 * 协议资产：plugin/decision/decision/PROTOCOL.md + schemas/decision-result.schema.json。
 * 模型在决策模式把 Decision Result 以 <AWF_DECISION_RESULT>…</AWF_DECISION_RESULT> 包裹作为回合最后输出。
 *
 * 必填集合与 schema 的 required 对齐：schema 需 decision_id + 下列 6 字段；
 * decision_id 由 server（DW）在捕获落盘时赋值，不在模型输出侧校验，故此处校验这 6 个模型侧字段：
 *   answer / type / finality / real_question / decisive_factors / reconsider_when
 * 轻量校验（不引 ajv）：字符串字段非空、数组字段必须是数组（可空数组视为已提供）。
 */
const MARKER_RE = /<\s*AWF_DECISION_RESULT\s*>([\s\S]*?)<\s*\/\s*AWF_DECISION_RESULT\s*>/;

const REQUIRED_FIELDS = ['answer', 'type', 'finality', 'real_question', 'decisive_factors', 'reconsider_when'];
const ARRAY_FIELDS = ['decisive_factors', 'reconsider_when'];

/**
 * 校验决策结果对象是否满足必填（轻量，不引 ajv）。
 * @param {object} data
 * @returns {{ valid: boolean, missing?: string[] }} valid=false 时 missing 列出缺失/非法字段
 */
function validateDecisionResult(data) {
  const missing = [];
  for (const f of REQUIRED_FIELDS) {
    const v = data?.[f];
    if (ARRAY_FIELDS.includes(f)) {
      if (!Array.isArray(v)) missing.push(f);
    } else if (typeof v !== 'string' || v.trim() === '') {
      missing.push(f);
    }
  }
  return missing.length ? { valid: false, missing } : { valid: true };
}

/**
 * 从最后一条消息解析 Decision Result。
 * @param {string} lastMessage - Stop hook 的 last_assistant_message
 * @returns {{ valid: true, result: object } | { valid: false, error: 'no_marker'|'invalid_json'|'missing_required', missing?: string[] }}
 */
function parseDecisionResult(lastMessage) {
  const text = typeof lastMessage === 'string' ? lastMessage : '';
  const m = text.match(MARKER_RE);
  if (!m) return { valid: false, error: 'no_marker' };

  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return { valid: false, error: 'invalid_json' };
  }

  const check = validateDecisionResult(data);
  if (!check.valid) return { valid: false, error: 'missing_required', missing: check.missing };
  return { valid: true, result: data };
}

module.exports = { parseDecisionResult, validateDecisionResult, REQUIRED_FIELDS, MARKER_RE };
