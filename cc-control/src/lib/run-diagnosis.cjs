'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIAGNOSIS_PATH = ['.awf', 'logs', 'run-diagnosis.json'];
const DIAGNOSIS_TIMEOUT_MS = 5 * 60 * 1000;

function diagnosisFile(projectRoot) {
  return path.join(projectRoot, ...DIAGNOSIS_PATH);
}

function readDiagnosis(projectRoot) {
  try {
    return JSON.parse(fs.readFileSync(diagnosisFile(projectRoot), 'utf8'));
  } catch {
    return null;
  }
}

function writeDiagnosis(projectRoot, value) {
  const file = diagnosisFile(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return value;
}

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

function diagnoseWithClaude(prompt, projectRoot) {
  return new Promise((resolve) => {
    // 诊断是独立、只读的模型调用，必须隔离项目 hooks，避免它被误认为新的主会话。
    const proc = spawn('claude', ['-p', '--safe-mode', '--no-session-persistence', prompt], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
      timeout: DIAGNOSIS_TIMEOUT_MS,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (error) => resolve({ ok: false, error: error.message }));
    proc.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false, error: stderr.trim() || `claude -p exited ${code}` });
      try {
        resolve({ ok: true, diagnosis: parseDiagnosis(stdout) });
      } catch (error) {
        resolve({ ok: false, error: `无法解析 AI 诊断结果：${error.message}` });
      }
    });
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
