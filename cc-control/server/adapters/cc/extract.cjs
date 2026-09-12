'use strict';
/**
 * extract.cjs — cc 产物提取迁入（RESULT / NEEDS_INPUT / transcript）
 *
 * 把散在 server.cjs（parseSubagentResult/parseSubagentNeedsInput）、run-logger
 * （transcript 行解析/渲染）的提取逻辑收敛为单一模块，避免各实现重复 JSON/正则细节；
 * usage/metrics 聚合仍驻 run-metrics.cjs（计数语义复杂，见 W1-024 管道），本模块负责
 * 行级/消息级提取原语。
 */

/** RESULT: {json} 提取（末条 assistant message 内） */
const RESULT_RE = /RESULT:\s*(\{[\s\S]*\})/;
const RESULT_STATUSES = ['done', 'blocked', 'failed', 'fail'];

/** NEEDS_INPUT: {json} 提取（末条 assistant message 内） */
const NEEDS_INPUT_RE = /NEEDS_INPUT:\s*(\{[\s\S]*\})/;

/**
 * 解析子 Agent RESULT 文本（RESULT: {…}）。
 * @param {string} text - last_assistant_message
 * @returns {object|null} { taskId, status, result?, files?, verdict?, architecture?, commits? }
 */
function parseSubagentResult(text) {
  const msg = text || '';
  const m = msg.match(RESULT_RE);
  if (!m) return null;
  try {
    const r = JSON.parse(m[1]);
    if (r && typeof r.taskId === 'string' && RESULT_STATUSES.includes(r.status)) return r;
  } catch { /* 解析失败 */ }
  return null;
}

/**
 * 解析子 Agent NEEDS_INPUT 文本。
 * @returns {{ taskId, question, options?, context? } | null}
 */
function parseNeedsInput(text) {
  const msg = text || '';
  const m = msg.match(NEEDS_INPUT_RE);
  if (!m) return null;
  try {
    const r = JSON.parse(m[1]);
    if (r && typeof r.taskId === 'string' && typeof r.question === 'string') return r;
  } catch { /* 解析失败 */ }
  return null;
}

/** 解析一行 transcript JSONL → entry（含 type/message/timestamp）；坏行 null */
function parseTranscriptLine(line) {
  if (!line || !line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * 取 entry 的可读文本/工具调用片段。
 * @returns {{ role: string, parts: string[], time?: string }} role: 回答|提示词|工具
 */
function entryParts(entry) {
  if (!entry) return null;
  const role = entry.type === 'assistant' ? '回答' : entry.type === 'user' ? '提示词' : null;
  if (!role) return null;
  const content = entry.message?.content;
  const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];
  const parts = [];
  for (const block of blocks) {
    if (block?.type === 'text' && block.text) parts.push(block.text);
    if (block?.type === 'tool_use') parts.push(`调用工具: ${block.name}\n${JSON.stringify(block.input || {}, null, 2)}`);
  }
  if (parts.length === 0) return null;
  const time = typeof entry.timestamp === 'string' ? entry.timestamp.slice(11, 19) : '--:--:--';
  return { role, parts, time };
}

/** 渲染一份 transcript 源文本（逐行 JSONL → 人读日志文本），run-logger agent 转录用 */
function renderTranscriptText(sourceText) {
  const records = [];
  for (const line of String(sourceText).split('\n')) {
    const entry = parseTranscriptLine(line);
    const e = entryParts(entry);
    if (!e) continue;
    records.push(`[${e.time}] ${e.role}\n${e.parts.join('\n')}\n`);
  }
  return records.join('\n');
}

module.exports = {
  RESULT_RE,
  NEEDS_INPUT_RE,
  parseSubagentResult,
  parseNeedsInput,
  parseTranscriptLine,
  entryParts,
  renderTranscriptText,
};
