import fs from 'node:fs/promises';
import path from 'node:path';
import pluginAssets from './plugin-assets.cjs';

/**
 * prompts.js — 提示词模板解析（server 侧，唯一实现）
 *
 * ## 模板归属（T-P1-04：模板与平台参数分离）
 * | 类别 | 例子 | 模板放哪 | 为什么 |
 * |---|---|---|---|
 * | **编排模板** | task-wrapup / task-settle / context-check / batch-* / subagent-* / gate-fix | `server/templates/prompts.json` | 它们是 AWF 编排协议的正文，随 server 走；换平台要改的是**参数**，不是协议 |
 * | **入口模板** | plan-start / plan-resume / plan-default | `plugin/plugin-code/prompts.json` | 它们直接引用插件的 slash 命令命名空间，属插件资产 |
 * | **平台参数** | worker-agent-type / worker-spawn / \*skill 名 | `plugin/plugin-code/prompts.json` 的 `platform-vars`（+ `platform-vars-<平台>` 按平台覆盖） | 名称与**工具措辞**都由插件/市场决定（换平台可能变），作为变量填进编排模板 |
 *
 * 因此：「插件改动，本模块零感知」仍然成立 —— 插件改**参数**不用动 server 模板；
 * 而编排协议正文的修订不再散在插件里。两条边界各自单源。
 *
 * ## 失败语义（U6 明确失败）
 * - key 不存在 → 抛 `prompt template not found: <key>`（宁可失败也不发空提示词）。
 * - 编排模板需要 `platform-vars` 但插件未声明 → 抛错（不静默填空串，否则会发出残缺指令）。
 *
 * 所有导出函数都返回 Promise<string>（文件读取是异步的）。
 */

const CODE_PLUGIN = 'ai-workflow-code';

/**
 * 编排模板 key —— 决定「从 server 模板读」还是「从插件读」。
 * 新增编排提示词时**必须**同时加到这里，否则会被当成插件入口模板去读而找不到。
 */
const ADAPTER_DEFAULT = 'cc';
const ORCHESTRATION_KEYS = new Set([
  'task-wrapup', 'task-settle', 'context-check',
  'batch-dispatch', 'batch-reconcile',
  'subagent-dispatch', 'subagent-resend', 'subagent-redispatch',
  'gate-fix',
]);

/** 插件声明文件：入口提示词 + 平台参数（唯一来源，按 key 组织） */
function promptsPath() {
  return pluginAssets.pluginAssetPath(CODE_PLUGIN, 'prompts.json');
}

/** 编排模板文件：随 server 分发（`server/templates/` 是项目工作区形状的读取口，本文件是提示词的） */
function orchestrationPromptsPath() {
  return path.join(pluginAssets.pkgRoot(), 'server', 'templates', 'prompts.json');
}

/** 状态模板文件：core 插件的 mcp/awf-state/state.template.json（awf init 播种 state.json 用） */
export function stateTemplatePath() {
  return pluginAssets.stateTemplatePath(); // 插件内布局单源在 plugin-assets
}

/** 读一份模板注册表（JSON） */
async function readRegistry(file) {
  return JSON.parse(await fs.readFile(file, 'utf-8'));
}

/**
 * 填 {var} 占位符。用 split/join 而非 RegExp：变量值里的 `$`、`\` 等不会被当成替换模式
 * （避免注入与转义坑）。值 null/undefined → 空串（占位符被清掉，不留字面量）。
 * @param {string} text 模板原文
 * @param {Record<string,string>} vars 变量表
 * @returns {string}
 */
function fill(text, vars) {
  let out = text;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v ?? '');
  return out;
}

/**
 * 读插件声明的平台参数（kebab-case → camelCase，供 `{camelCase}` 占位符使用）。
 *
 * **按平台**：缺省表 `platform-vars` 是 cc 的值；`platform-vars-<平台>`（如 `platform-vars-dsh`）
 * 覆盖其中同名项。为什么要这样：编排模板里含**平台工具措辞**（派生工具名与参数、提问工具、
 * 回话工具），cc 是 `Agent 工具（subagent_type…）`/`AskUserQuestion`，DSH 是 `subagent 工具`/
 * `ask_user_question` —— 同一份模板填上各自的措辞，才不用把模板按平台分叉（模板仍然只有一份）。
 * @param {string} [adapter] 平台名（缺省 'cc'）；未知平台取缺省表（解析错误在别处显式报）
 * @returns {Promise<Record<string,string>>}
 * @throws {Error} 插件未声明 platform-vars（编排模板会因此发不出去，明确失败优于静默残缺）
 */
async function platformVars(adapter = ADAPTER_DEFAULT) {
  const registry = await readRegistry(promptsPath());
  const raw = registry['platform-vars'];
  if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) {
    throw new Error('prompts: 插件未声明 platform-vars（编排模板的平台参数单一来源）');
  }
  const overrides = registry[`platform-vars-${adapter}`];
  const merged = overrides && typeof overrides === 'object' ? { ...raw, ...overrides } : raw;
  const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return Object.fromEntries(Object.entries(merged).map(([k, v]) => [camel(k), String(v)]));
}

/**
 * 读取模板并填充占位符（编排模板自动并入插件声明的平台参数）。
 * @param {string} key - 模板 key，如 'plan-start' / 'task-settle'
 * @param {Record<string,string>} [vars] - 占位符变量，如 { desc: '需求' }
 * @returns {Promise<string>} 填充后的完整提示词
 * @throws {Error} key 不存在、该项无 prompt 字段、或编排模板缺平台参数
 */
export async function resolvePrompt(key, vars = {}, { adapter = ADAPTER_DEFAULT } = {}) {
  const isOrchestration = ORCHESTRATION_KEYS.has(key);
  const registry = await readRegistry(isOrchestration ? orchestrationPromptsPath() : promptsPath());
  const entry = registry[key];
  if (!entry?.prompt) throw new Error(`prompt template not found: ${key}`);
  const base = isOrchestration ? await platformVars(adapter) : {};
  // 两遍填：平台参数的值**可以引用别的平台参数**（如 `worker-spawn` 里嵌 `{workerAgentType}`），
  // 第二遍只拿平台参数表再走一次，调用方传进来的业务值（任务正文等）不会被二次改写 —— 除非它
  // 恰好含 `{architectureSkill}` 这类平台占位符字面量，那本来也该被填掉。
  return fill(fill(entry.prompt, { ...base, ...vars }), base);
}

/**
 * awf plan 入口提示词 — 由插件的 prompts.json 模板 + 场景选 key 组装
 * 场景优先级：resume 优先于 description（恢复会话时忽略新描述），两者都无 → plan-default。
 * @param {string} [description] - 需求描述
 * @param {boolean} [resume] - 是否恢复上次规划会话
 * @returns {Promise<string>}
 */
export async function planEntry(description, resume, { adapter = ADAPTER_DEFAULT } = {}) {
  // 平台没有斜杠命令注册机制时（DSH 未注册插件命令，C29），发 `/ai-workflow-code:w-plan …`
  // 只会让模型看到一串它无法解释的命令字面量（实测：模型把整个需求当成「命令的参数被截断」）。
  // 这时把**命令正文**展开成指令，需求原文附在后面 —— 对平台零假设。
  const inline = (await platformVars(adapter)).planEntryMode === 'inline';
  if (inline) {
    // DSH 没有斜杠命令执行（slash command 只在网页输入框触发，`awf plan` 走 API 注入，平台不调 handler）。
    // 但 DSH 有**技能系统**（`skill` 工具 + <available_skills> 目录）：`awf plugin install` 已把
    // plugin 里的 SKILL.md 链接进 `$DSH_HOME/skills/`，所以入口只需点名叫模型加载，不必内联 18KB。
    const head = resume
      ? '这是**恢复**上次规划会话：先问用户上次进行到哪一步，再从中断处继续；不要从头重问一遍。'
      : '';
    const ask = description
      ? description
      : '(用户未提供描述：先用 ask_user_question 问清「要做什么、给谁用、核心功能期望」，拿到完整需求再开始)';
    return [
      '这是 AWF 的规划任务：把一句需求转成「范围 + WBS + 任务列表」，最后用 awf-state 工具**一次性**写入 state.json。',
      '',
      '## 硬性产出',
      '1. 范围：inScope / outOfScope 都显式列出，100% 敲定，不留 openQuestions。',
      '2. WBS：逐级拆到叶子，每个叶子有可独立验证的 done 条件；id 用「前缀+序号」。',
      '3. tasks：每个任务带 wbsRef / deps / acceptance / prompt；在 dev 任务后插入 review、test 门禁任务。',
      '',
      '## 流程约束',
      '- 规划过程中只写临时文件，**最后一步**才用 awf-state 写 state.json。',
      '- 技术选型在 plan 阶段只定到 60-70%（方向、关键约束），实现细节不强求。',
      '- 若本平台有 `skill` 工具且能加载 awf-plan-*（norm/wbs/tasks/prompt）或 code-context-onboard，先加载它们获取更细规范再开始；加载不到就按本指令执行。',
      head ? `\n${head}\n` : '',
      '## 需求原文（必须完整使用，不得截断或改写）',
      '',
      ask,
    ].join('\n');
  }
  if (resume) return resolvePrompt('plan-resume', {}, { adapter });
  if (description) return resolvePrompt('plan-start', { desc: description }, { adapter });
  return resolvePrompt('plan-default', {}, { adapter });
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
 * 任务前上下文检查 prompt — 引导 AI 按上下文交接技能判断是否需要压缩
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
 * 门禁修复任务 prompt — 命令与结构由模板声明（dev 命令是平台参数），server 只填任务 ID 与修复目标
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
export function batchDispatch({ batchId, tasks, adapter }) {
  const tasksText = Array.isArray(tasks)
    ? tasks.map((t) => `- ${t.taskId} [${t.kind}] ${t.title}\n  提示词：${t.prompt}`).join('\n')
    : tasks;
  return resolvePrompt('batch-dispatch', { batchId, tasks: tasksText }, { adapter });
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
export function subagentDispatch({ taskId, taskTitle = '', taskPrompt, adapter }) {
  return resolvePrompt('subagent-dispatch', { taskId, taskTitle, taskPrompt }, { adapter });
}

/**
 * 派发未生效时的重派 prompt — 主会话收下了上一条派发指令、回合也正常结束，却没有派生任何子 Agent。
 * 与 subagentDispatch 的差别：点明「上一回合没起子 Agent」这一事实并要求立刻补救，堵掉
 * 「已有派发记录 / 被拒绝 / 暂不派发」这类不派发的借口。
 * @param {{ taskId: string, taskPrompt: string }} params
 * @returns {Promise<string>}
 */
export function subagentRedispatch({ taskId, taskPrompt, adapter }) {
  return resolvePrompt('subagent-redispatch', { taskId, taskPrompt }, { adapter });
}

/**
 * 子 Agent 落账补发 prompt — RESULT 输出无效时，要求主 Agent 恢复该子 Agent 补齐 RESULT（不重做任务）
 * @param {{ agentId: string, reason: string }} params reason=为何要补发（如「RESULT 缺失/格式非法」）
 * @returns {Promise<string>}
 */
export function subagentResend({ agentId, reason, adapter }) {
  return resolvePrompt('subagent-resend', { agentId, reason }, { adapter });
}
