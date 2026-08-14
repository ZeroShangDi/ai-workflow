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
 * 任务收尾 prompt — 任务未标记 done 时补发，强制 AI 标记 + 记录结果
 * @param {string} taskId - 任务 ID，如 'T1'
 * @returns {Promise<string>}
 */
export function taskWrapup(taskId) {
  return resolvePrompt('task-wrapup', { taskId });
}
