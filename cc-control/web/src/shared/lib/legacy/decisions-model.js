// web/src/views/decisions-model.js — Decisions 视图模型（纯函数）。
// T1-088：决策列表 / Review / override 展示逻辑迁到 web（可单测）。

/** 归一决策条目（记录字段差异容忍：decision_id / decisionId / event 等） */
export function normalizeDecision(entry = {}) {
  const id = entry.decision_id || entry.decisionId || null;
  const override = entry.event === 'decision_overridden';
  return {
    id,
    runStamp: entry.runStamp || null,
    event: entry.event || (entry.answer !== undefined ? 'decision_completed' : null),
    answer: entry.answer ?? null,
    type: entry.type ?? null,
    finality: entry.finality ?? null,
    fallback: !!entry.fallback,
    instruction: entry.instruction ?? null,
    at: entry.at ?? null,
    override,
    overridable: !!id && !override && entry.answer !== undefined,
  };
}

/** 归一 Decisions 响应 { total, decisions:[...] } */
export function toDecisionsModel(resp = {}) {
  const list = Array.isArray(resp.decisions) ? resp.decisions : [];
  return {
    total: resp.total ?? list.length,
    decisions: list.map(normalizeDecision),
  };
}

/** 决策摘要文本（展示用） */
export function decisionSummary(d) {
  if (!d.id) return '(无 decision_id)';
  const head = `${d.id}${d.fallback ? '（兜底）' : ''}`;
  if (d.answer !== null) return `${head} → ${String(d.answer).slice(0, 80)}`;
  return head;
}
