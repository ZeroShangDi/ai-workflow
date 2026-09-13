'use strict';
/**
 * monitor/diagnosis.cjs — 诊断的**实现件**：提示词拼装 + 一次隔离的 claude -p + 快照读写
 *
 * 归属：monitor feature（不是 observability）。诊断会拉起独立 claude 进程、写快照、
 *       并在重启后改 session.mainSessionId —— 那是编排动作，observability 的边界是「只读地观察」。
 *       协议（互斥 / 两拍写 / 上限 / 后效对齐）在 ./index.cjs，本文件只提供机制。
 *
 * 职责：把当前运行指标 + 任务状态拼成提示词，交给一次**独立、只读**的 `claude -p` 分析，
 *       产出 { severity, summary, findings[], dataGaps[] } 落成 run-diagnosis.json 快照。
 * 边界：
 *   - 诊断调用必须隔离项目自身的 hooks 与会话（--safe-mode --no-session-persistence）——
 *     否则诊断进程会被本项目的 hook 反过来影响/污染。这是安全约束，不是性能优化。
 *   - 只喂「指标 + mode/currentState + 任务的必要字段」，不喂整份 state，避免把无关内容带进模型。
 * 快照的消费方：./index.cjs（status==='running' 时用它重建会话 id / 订正 run-meta）与 /awf 诊断页。
 */

const fs = require('fs');
const path = require('path');
const { logsDir } = require('../../shared/project-paths.cjs'); // .awf 布局单源（目录归它，文件名归本产物）
// claude -p 收口到 oneshot 端口（R-cc：外部源码零 claude 字面）。
// **端口由调用方注入**（T1-117）：lib 是地基，不应该反向依赖 adapters 的具体实现 ——
// 装配根（server.cjs）从 ports.cjs 取端口后传进来。

const DIAGNOSIS_FILE = 'run-diagnosis.json'; // 目录由 project-paths 给，文件名归本产物
const DIAGNOSIS_TIMEOUT_MS = 5 * 60 * 1000; // 单次诊断上限 5 分钟（模型分析 + 网络波动留足余量）

/** 诊断快照绝对路径（<root>/.awf/logs/run-diagnosis.json） */
function diagnosisFile(projectRoot) {
  return path.join(logsDir(projectRoot), DIAGNOSIS_FILE);
}

/** 读诊断快照；缺失 / 坏 JSON → null（调用方据此判断「有无诊断」） */
function readDiagnosis(projectRoot) {
  try {
    return JSON.parse(fs.readFileSync(diagnosisFile(projectRoot), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 写诊断快照（直接 writeFileSync，非原子）。
 * 快照是观测产物、单写者，容忍半截；调用方在写前会先写一份 status:'running' 占位，
 * 完成后用最终结果覆盖同一文件。
 */
function writeDiagnosis(projectRoot, value) {
  const file = diagnosisFile(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return value;
}

/**
 * 拼诊断提示词：约束模型「只依据给定数据、只输出 JSON」，并把输出 schema 写死；
 * 再附上运行指标全文与任务状态摘要（mode/currentState + 每个任务的关键字段）。
 */
function buildDiagnosisPrompt(metrics, state) {
  return `你是一次 AI 工作流运行诊断助手。仅依据下面提供的数据诊断本次运行；不要臆测未提供的事实，不要修改文件，不要执行命令。

请只输出 JSON，不要使用 Markdown。格式：
{
  "severity": "healthy|watch|attention",
  "summary": "一句话结论",
  "findings": [{ "title": "问题或观察", "evidence": "数据证据", "impact": "可能影响", "recommendation": "下一步建议" }],
  "dataGaps": ["无法确认的原因或缺少的数据"]
}

运行指标：
${JSON.stringify(metrics, null, 2)}

任务状态：
${JSON.stringify({
  mode: state.mode || null,
  currentState: state.currentState || null,
  tasks: (state.tasks || []).map((task) => ({
    id: task.id,
    title: task.title || task.desc || null,
    status: task.status,
    startedAt: task.exec?.startedAt || null,
    completedAt: task.exec?.completedAt || null,
  })),
}, null, 2)}`;
}

/**
 * 解析模型输出为结构化诊断。
 *   - 容忍 ```json 代码围栏（模型常不听「不要 Markdown」的话）；
 *   - 结构不符（无 summary / findings 非数组）直接抛错，由上层落成 status:'failed'；
 *   - 字段归一化：severity 白名单外回落 'watch'，findings/dataGaps 截断到 6 条，
 *     缺失字段填默认文案 —— 保证前端拿到的结构永远完整。
 * @throws {Error} 结构不符时
 */
function parseDiagnosis(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const result = JSON.parse(candidate);
  if (!result || typeof result.summary !== 'string' || !Array.isArray(result.findings)) {
    throw new Error('diagnosis response is not the expected JSON structure');
  }
  return {
    severity: ['healthy', 'watch', 'attention'].includes(result.severity) ? result.severity : 'watch',
    summary: result.summary,
    findings: result.findings.slice(0, 6).map((item) => ({
      title: String(item.title || '观察'),
      evidence: String(item.evidence || '未提供'),
      impact: String(item.impact || '待确认'),
      recommendation: String(item.recommendation || '继续观察'),
    })),
    dataGaps: Array.isArray(result.dataGaps) ? result.dataGaps.map(String).slice(0, 6) : [],
  };
}

/**
 * 跑一次诊断调用。oneshot 端口**由装配根注入**（见文件头），本模块只声明依赖、不反向依赖 adapters。
 * @param {string} prompt 提示词（buildDiagnosisPrompt 产物）
 * @param {string} projectRoot 诊断进程的 cwd
 * @param {{ oneshot: object }} deps 必需：需含 spawnClaudeP
 * @returns {Promise<{ ok: true, diagnosis: object } | { ok: false, error: string }>} 永不 reject
 */
function diagnoseWithClaude(prompt, projectRoot, { oneshot } = {}) {
  if (!oneshot || typeof oneshot.spawnClaudeP !== 'function') {
    throw new Error('diagnoseWithClaude: 需注入 oneshot 端口（{ oneshot } 来自 adapters/ports.cjs）');
  }
  // 诊断是独立、只读的模型调用，必须隔离项目 hooks；claude -p 经 oneshot 端口（safe-mode + 无会话持久化）
  return oneshot.spawnClaudeP({
    prompt,
    cwd: projectRoot,
    args: ['--safe-mode', '--no-session-persistence'],
    timeoutMs: DIAGNOSIS_TIMEOUT_MS,
  }).then((r) => {
    if (r.error) return { ok: false, error: r.error };
    if (!r.ok) return { ok: false, error: r.stderr.trim() || `claude -p exited ${r.code}` };
    try {
      return { ok: true, diagnosis: parseDiagnosis(r.stdout) };
    } catch (error) {
      return { ok: false, error: `无法解析 AI 诊断结果：${error.message}` };
    }
  });
}

module.exports = {
  buildDiagnosisPrompt,
  diagnoseWithClaude,
  diagnosisFile,
  parseDiagnosis,
  readDiagnosis,
  writeDiagnosis,
};
