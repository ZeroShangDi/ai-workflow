'use strict';
/**
 * extract.cjs — cc 产物提取迁入（RESULT / NEEDS_INPUT / transcript）
 *
 * 把散在 server.cjs（parseSubagentResult/parseSubagentNeedsInput）、run-logger
 * （transcript 行解析/渲染）的提取逻辑收敛为单一模块，避免各实现重复 JSON/正则细节；
 * usage/metrics 聚合仍驻 run-metrics.cjs（计数语义复杂，见 W1-024 管道），本模块负责
 * 行级/消息级提取原语。
 */

// 子 Agent 与主会话之间的**结构化回话协议**：子 Agent 把结果写在这一行（awf-worker.md 定义输出协议）。
// 用「RESULT: {json}」前缀 + 贪婪匹配到最后一个 } —— 子 Agent 输出里可能夹带别的花括号文本，
// 靠前缀锚点先把 JSON 段框出来，再由 JSON.parse 兜底判真伪。
/** RESULT: {json} 提取（末条 assistant message 内） */
const RESULT_RE = /RESULT:\s*(\{[\s\S]*\})/;
// 允许的终态：done/blocked/failed/fail（fail 与 failed 都收，容错模型用词不一）
const RESULT_STATUSES = ['done', 'blocked', 'failed', 'fail'];

/** NEEDS_INPUT: {json} 提取（末条 assistant message 内）—— 子 Agent 上抛「需要决策」的通道 */
const NEEDS_INPUT_RE = /NEEDS_INPUT:\s*(\{[\s\S]*\})/;

/**
 * 解析子 Agent RESULT 文本（RESULT: {…}）。
 * 双重校验：先正则框出 JSON 段，再要求 taskId 为字符串且 status 在白名单内 ——
 * 模型可能把「RESULT:」当普通文字提及，只有形状完整才认，避免误采。
 * @param {string} text - last_assistant_message
 * @returns {object|null} { taskId, status, result?, files?, verdict?, architecture?, commits? }；不合法 → null
 */
function parseSubagentResult(text) {
  const msg = text || '';
  const m = msg.match(RESULT_RE);
  if (!m) return null;
  try {
    const r = JSON.parse(m[1]);
    if (r && typeof r.taskId === 'string' && RESULT_STATUSES.includes(r.status)) return r;
  } catch { /* 解析失败：非法 JSON 视为无结果 */ }
  return null;
}

/**
 * 解析子 Agent NEEDS_INPUT 文本。
 * 判据：taskId + question 均为字符串（question 为空则不算有效求援）。
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

/** 解析一行 transcript JSONL → entry（含 type/message/timestamp）；坏行/空行 → null（不抛出） */
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
 * 只认 assistant/user 两类（转成中文角色名），其余（system 等）→ null 由调用方跳过。
 * @returns {{ role: string, parts: string[], time?: string }} role: 回答|提示词|工具
 *   parts 为该条消息的文本段与「调用工具: <名>\n<入参>」段，按出现顺序
 */
function entryParts(entry) {
  if (!entry) return null;
  const role = entry.type === 'assistant' ? '回答' : entry.type === 'user' ? '提示词' : null;
  if (!role) return null;
  const content = entry.message?.content;
  // content 可能是块数组（新版）也可能是裸字符串（兼容旧格式）
  const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];
  const parts = [];
  for (const block of blocks) {
    if (block?.type === 'text' && block.text) parts.push(block.text);
    // 工具调用渲染成人类可读两段文本（名称 + 缩进 JSON 入参）
    if (block?.type === 'tool_use') parts.push(`调用工具: ${block.name}\n${JSON.stringify(block.input || {}, null, 2)}`);
  }
  if (parts.length === 0) return null; // 空消息（如仅心跳）不产出记录
  // 时间戳只取 "HH:MM:SS"（ISO 串的第 11–19 位）；缺失给占位，保持列对齐
  const time = typeof entry.timestamp === 'string' ? entry.timestamp.slice(11, 19) : '--:--:--';
  return { role, parts, time };
}

/** 渲染一份 transcript 源文本（逐行 JSONL → 人读日志文本），run-logger agent 转录用 */
function renderTranscriptText(sourceText) {
  const records = [];
  for (const line of String(sourceText).split('\n')) {
    const entry = parseTranscriptLine(line);
    const e = entryParts(entry);
    if (!e) continue; // 坏行/非对话条目静默跳过
    records.push(`[${e.time}] ${e.role}\n${e.parts.join('\n')}\n`);
  }
  return records.join('\n');
}

// 两个正则一并导出，供单测直接验证「框取」行为；其余为解析/渲染原语
module.exports = {
  RESULT_RE,
  NEEDS_INPUT_RE,
  parseSubagentResult,
  parseNeedsInput,
  parseTranscriptLine,
  entryParts,
  renderTranscriptText,
};
