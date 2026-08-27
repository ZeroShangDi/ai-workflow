import path from 'node:path';
import fs from 'node:fs/promises';
import { getPaths } from './paths.js';

/**
 * 插件边界唯一模块 — cli 与插件的全部耦合落在此处
 *
 * 规范：插件改动，CLI 零感知。
 * 提示词由插件声明（plugin/plugin-code/prompts.json），本模块只做读取与占位符填充，
 * 不写死任何插件命令字符串（命名空间只存在于插件模板里）。
 */

/** 插件声明文件：plugin/plugin-code/prompts.json */
function promptsPath() {
  return path.join(getPaths().projectRoot, 'plugin', 'plugin-code', 'prompts.json');
}

/** 状态模板文件：plugin/core/mcp/awf-state/state.template.json（awf init 播种 state.json 用） */
export function stateTemplatePath() {
  return path.join(getPaths().projectRoot, 'plugin', 'core', 'mcp', 'awf-state', 'state.template.json');
}

/**
 * 读取插件 prompt 模板并填充 {var} 占位符
 * @param {string} key - prompts.json 中的模板 key，如 'plan-start'
 * @param {Record<string,string>} [vars] - 占位符变量，如 { desc: '需求' }
 * @returns {Promise<string>} 填充后的完整提示词
 */
export async function resolvePrompt(key, vars = {}) {
  const raw = await fs.readFile(promptsPath(), 'utf-8');
  const registry = JSON.parse(raw);
  const entry = registry[key];
  if (!entry?.prompt) throw new Error(`prompt template not found: ${key}`);
  let text = entry.prompt;
  for (const [k, v] of Object.entries(vars)) {
    text = text.split(`{${k}}`).join(v ?? '');
  }
  return text;
}

/**
 * awf plan 入口提示词 — 由插件的 prompts.json 模板 + 场景选 key 组装
 * @param {string} [description] - 需求描述
 * @param {boolean} [resume] - 是否恢复上次规划会话
 * @returns {Promise<string>}
 */
export function planEntry(description, resume) {
  if (resume) return resolvePrompt('plan-resume');
  if (description) return resolvePrompt('plan-start', { desc: description });
  return resolvePrompt('plan-default');
}

/**
 * 任务收尾 prompt — 任务未标记 done 时补发，让 AI 按真实状态收尾（完成才标 done）
 * @param {string} taskId - 任务 ID，如 'T1'
 * @returns {Promise<string>}
 */
export function taskWrapup(taskId) {
  return resolvePrompt('task-wrapup', { taskId });
}

/**
 * 任务收尾追问 prompt — wrapup 未生效时，让 AI 明确三选一（完成 / 继续 / 卡住）
 * @param {string} taskId - 任务 ID，如 'T1'
 * @returns {Promise<string>}
 */
export function taskSettle(taskId) {
  return resolvePrompt('task-settle', { taskId });
}

/**
 * 任务前上下文检查 prompt — 引导 AI 按 code-context-onboard 判断是否需要压缩
 * 输出协议：AWF_CONTEXT_OK（无需压缩）| AWF_CONTEXT_READY（已写快照并通知 CLI）
 * @param {string} [usage] - statusline 实测上下文占用描述（如「已用约 62%（statusline 实测）」；
 *   无实测时为「未知（statusline 未配置，请自行估算）」），填充模板 {usage} 占位符
 * @returns {Promise<string>}
 */
export function contextCheck(usage) {
  return resolvePrompt('context-check', { usage });
}

/**
 * 批次派发 prompt — 主 Agent 并行派生子 Agent 执行一个任务批次
 * @param {{ batchId: string, tasks: Array<{ taskId: string, title: string, kind: string, prompt: string }> }} opts
 * @returns {Promise<string>}
 */
export function batchDispatch({ batchId, tasks }) {
  const tasksText = Array.isArray(tasks)
    ? tasks.map((t) => `- ${t.taskId} [${t.kind}] ${t.title}\n  提示词：${t.prompt}`).join('\n')
    : tasks;
  return resolvePrompt('batch-dispatch', { batchId, tasks: tasksText });
}

/**
 * 批次收尾 reconcile prompt — 主 Agent 补落账未完成任务，不重做
 * @param {string} batchId - 批次 ID，如 'B1'
 * @returns {Promise<string>}
 */
export function batchReconcile(batchId) {
  return resolvePrompt('batch-reconcile', { batchId });
}

/**
 * 滑动窗口单任务派发 prompt — 主 Agent 派生后台子 Agent 执行一个任务
 * @param {{ taskId: string, taskPrompt: string }} opts
 * @returns {Promise<string>}
 */
export function subagentDispatch({ taskId, taskPrompt }) {
  return resolvePrompt('subagent-dispatch', { taskId, taskPrompt });
}
