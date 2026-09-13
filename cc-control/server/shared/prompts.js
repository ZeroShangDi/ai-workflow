import fs from 'node:fs/promises';
import pluginAssets from './plugin-assets.cjs';

/**
 * prompts.js — 读插件声明的提示词模板（server 侧）
 *
 * 职责：从 plugin/plugin-code/prompts.json 按 key 取模板，填充 {var} 占位符，返回最终提示词。
 * 「规范：插件改动，本模块零感知」——提示词由插件声明（plugin/plugin-code/prompts.json），
 * 这里只做读取与占位符填充，**不写死任何插件命令字符串**（命名空间只存在于插件模板里）。
 *
 * 与 cli 侧的同名能力是**两份实现**：server 与 cli 隔离、不共享代码（用户裁定），
 * 各自从包根定位 plugin/。改插件提示词时两边都读同一份 prompts.json，因此不会漂移。
 *
 * 边界：本模块只负责「取模板 + 填值」，不校验模板内容、不做多语言；模板 key 不存在即抛错
 * （宁可失败也不要静默发出空提示词）。所有导出函数都返回 Promise<string>（文件读取是异步的）。
 */
// 插件目录由注册表（plugin/config.json 的 marketplace）决定，不写死目录名 ——
// 定位经 shared/plugin-assets.cjs（外部形状只有一个地方知道），本模块只管「读哪个 key」。
const CODE_PLUGIN = 'ai-workflow-code';
const CORE_PLUGIN = 'ai-workflow-core';

/** 插件声明文件：plugin-code 插件的 prompts.json（提示词唯一来源，按 key 组织） */
function promptsPath() {
  return pluginAssets.pluginAssetPath(CODE_PLUGIN, 'prompts.json');
}

/** 状态模板文件：core 插件的 mcp/awf-state/state.template.json（awf init 播种 state.json 用） */
export function stateTemplatePath() {
  return pluginAssets.pluginAssetPath(CORE_PLUGIN, 'mcp', 'awf-state', 'state.template.json');
}

/**
 * 读取插件 prompt 模板并填充 {var} 占位符
 * @param {string} key - prompts.json 中的模板 key，如 'plan-start'
 * @param {Record<string,string>} [vars] - 占位符变量，如 { desc: '需求' }
 * @returns {Promise<string>} 填充后的完整提示词
 * @throws {Error} key 不存在或该项无 prompt 字段（`prompt template not found`）
 */
export async function resolvePrompt(key, vars = {}) {
  const raw = await fs.readFile(promptsPath(), 'utf-8');
  const registry = JSON.parse(raw);
  const entry = registry[key];
  if (!entry?.prompt) throw new Error(`prompt template not found: ${key}`);
  let text = entry.prompt;
  for (const [k, v] of Object.entries(vars)) {
    // 用 split/join 而非 RegExp：变量值里的 $、\ 等字符不会被当成替换模式，避免注入与转义坑。
    // v 为 null/undefined → 空串（模板占位符仍会被清掉，不留 {var} 字面量）。
    text = text.split(`{${k}}`).join(v ?? '');
  }
  return text;
}

/**
 * awf plan 入口提示词 — 由插件的 prompts.json 模板 + 场景选 key 组装
 * 场景优先级：resume 优先于 description（恢复会话时忽略新描述），两者都无 → plan-default。
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
 * 与 taskWrapup 的差别：更强制、要求显式表态，用于收尾协商的追问轮次（最多 3 轮）。
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
 *   无实测时为「未知（statusline 未配置，请自行估算）」），填充模板 {usage} 占位符。
 *   注意：省略该参数时模板里的 {usage} 会被清成空串，调用方应显式传入「未知…」文案而非省略。
 * @returns {Promise<string>}
 */
export function contextCheck(usage) {
  return resolvePrompt('context-check', { usage });
}

/**
 * 门禁修复任务 prompt — 由插件模板声明命令与结构，CLI 只填充任务 ID 与修复目标
 * （命令字符串活在模板里，本模块不硬编码，遵守「插件改动，本模块零感知」）。
 * @param {{ fixId: string, fixTarget: string }} params - fixId 如 'R1-F1'；fixTarget 为具体修复目标描述
 *   注意 fixId 须与 features/gate/closure.js 的 gateFixMeta 派生的一致（调用方先取 meta 再生成 prompt），本函数只填值不生成 id。
 * @returns {Promise<string>}
 */
export function gateFixPrompt({ fixId, fixTarget }) {
  return resolvePrompt('gate-fix', { fixId, fixTarget });
}

/**
 * 批次派发 prompt — 主 Agent 并行派生子 Agent 执行一个任务批次
 * tasks 为对象数组时渲染成「- <id> [kind] <title>\n  提示词：<prompt>」的多行清单后填模板；
 * 已是字符串则原样透传（便于调用方自行排版）。
 * @param {{ batchId: string, tasks: Array<{ taskId: string, title: string, kind: string, prompt: string }> | string }} opts
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
 * @param {{ taskId: string, taskTitle?: string, taskPrompt: string }} opts taskTitle 缺省 ''（模板里可用可不用）
 * @returns {Promise<string>}
 */
export function subagentDispatch({ taskId, taskTitle = '', taskPrompt }) {
  return resolvePrompt('subagent-dispatch', { taskId, taskTitle, taskPrompt });
}

/**
 * 子 Agent 落账补发 prompt — RESULT 输出无效时，要求主 Agent 恢复该子 Agent 补齐 RESULT（不重做任务）
 * @param {{ agentId: string, reason: string }} params reason=为何要补发（如「RESULT 缺失/格式非法」）
 * @returns {Promise<string>}
 */
export function subagentResend({ agentId, reason }) {
  return resolvePrompt('subagent-resend', { agentId, reason });
}
