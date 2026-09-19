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
 * | **入口模板** | plan-start / plan-resume / plan-default（cc）；plan-entry（dsh） | 各平台**自己的插件包**的 `prompts.json` | 它们直接引用该平台的命令命名空间与措辞，属插件资产 |
 * | **平台参数** | worker-agent-type / worker-spawn / \*skill 名 | 各平台**自己的插件包**的 `prompts.json` 的 `platform-vars` | 名称与**工具措辞**由各平台插件决定；缺项报错，不回落 cc |
 * | **命令正文** | `commands/*.md` | 各平台**自己的插件包** | expand-command 模式下入口正文直接取自这里，本模块不内联 |
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
 * 读某平台的平台参数表（kebab-case → camelCase，供 `{camelCase}` 占位符使用）。
 *
 * **住在哪**：**各平台自己的插件包里** —— cc 在 `cc/plugin/plugin-code/prompts.json`
 * 的 `platform-vars`，DSH 在 `dsh/plugin/prompts.json` 的同名段。位置对称，内容各写各的。
 *
 * 为什么不再用「cc 表 + `platform-vars-<平台>` 覆盖」：那让 DSH 的工具措辞住在 cc 的目录里
 * （包不自包含），且缺项会**静默回落成 cc 口径**（发出 `Agent 工具` 这种 DSH 没有的东西）。
 * 现在缺项直接报错，列出缺了哪些键。
 * @param {string} [adapter] 平台名（缺省 'cc'）
 * @returns {Promise<Record<string,string>>}
 * @throws {Error} 该平台未声明 platform-vars，或比 cc 的键集少了项
 */
async function platformVars(adapter = ADAPTER_DEFAULT) {
  const raw = await platformVarsTable(adapter);
  const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [camel(k), String(v)]));
}

/** 原始（未 camel 化）平台参数表 —— 供需要按 kebab 键读的地方（如 plan-entry-mode）复用 */
async function platformVarsTable(adapter) {
  const base = (await readRegistry(promptsPath()))['platform-vars'];
  if (!base || typeof base !== 'object' || Object.keys(base).length === 0) {
    throw new Error('prompts: cc 插件未声明 platform-vars（编排模板的平台参数单一来源）');
  }
  if (adapter === ADAPTER_DEFAULT) return base;

  // 非 cc：读该平台自己插件包里的那份，**不回落** cc
  let own;
  try {
    own = await readRegistry(pluginAssets.adapterAssetPath(adapter, 'prompts.json'));
  } catch (err) {
    throw new Error(`prompts: 适配器 ${adapter} 的插件包里没有 prompts.json（${pluginAssets.adapterAssetPath(adapter, 'prompts.json')}）：${err.message}`);
  }
  const table = own['platform-vars'];
  if (!table || typeof table !== 'object' || Object.keys(table).length === 0) {
    throw new Error(`prompts: 适配器 ${adapter} 未声明 platform-vars（平台参数必须自带完整一份，不回落 cc）`);
  }
  const missing = Object.keys(base).filter((k) => !(k in table));
  if (missing.length > 0) {
    throw new Error(`prompts: 适配器 ${adapter} 的 platform-vars 缺项：${missing.join(', ')}（不回落 cc —— 回落会发出 cc 口径的指令）`);
  }
  return table;
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
 * 去掉 markdown 的 frontmatter —— 入口注入的是**正文**，YAML 头对模型是噪音。
 * 只做最朴素的切分（与本仓资产的实际写法一致）；没有 frontmatter 就原样返回。
 */
function stripFrontmatter(text) {
  if (!text.startsWith('---\n')) return text;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return text;
  const afterClose = text.indexOf('\n', end + 1);
  return afterClose === -1 ? '' : text.slice(afterClose + 1).replace(/^\n+/, '');
}

/** 读某平台的 plan 入口模板（`plan-entry` 段：命令名 + 恢复/缺描述/输入框三段措辞） */
async function planEntryTemplate(adapter) {
  const cfg = await readRegistry(pluginAssets.adapterAssetPath(adapter, 'prompts.json'));
  const entry = cfg['plan-entry'];
  if (!entry?.command) {
    throw new Error(`prompts: 适配器 ${adapter} 的 prompts.json 缺 plan-entry.command（expand-command 模式下入口正文取自该命令的 md）`);
  }
  return entry;
}

/**
 * awf plan 入口提示词。
 *
 * 两种平台：
 *   - `plan-entry-mode: 'command'`（cc）：平台自己能展开斜杠命令，发 `/<命名空间>:w-plan {desc}` 即可，
 *     用插件 prompts.json 的 plan-start / plan-resume / plan-default 模板。
 *   - `plan-entry-mode: 'expand-command'`（DSH）：平台的 commands.execute **只在网页输入框触发**，
 *     API 注入的 prompt 不走 handler（实测），发命令字面量只会让模型把需求当成「被截断的参数」。
 *     这时把**插件命令 md 的正文**展开注入 —— 正文是单源，本模块**不内联**一份缩水版
 *     （内联的那份命令改了不会跟着变，就是两份真值）。
 * @param {string} [description] - 需求描述
 * @param {boolean} [resume] - 是否恢复上次规划会话
 * @param {{adapter?: string}} [opts]
 * @returns {Promise<string>}
 */
export async function planEntry(description, resume, { adapter = ADAPTER_DEFAULT } = {}) {
  const mode = (await platformVarsTable(adapter))['plan-entry-mode'];
  if (mode !== 'expand-command') {
    if (resume) return resolvePrompt('plan-resume', {}, { adapter });
    if (description) return resolvePrompt('plan-start', { desc: description }, { adapter });
    return resolvePrompt('plan-default', {}, { adapter });
  }

  const entry = await planEntryTemplate(adapter);
  const body = stripFrontmatter(pluginAssets.readAdapterAsset(adapter, 'commands', `${entry.command}.md`)).trim();
  const parts = [body];
  if (resume) parts.push('', entry.resume);
  parts.push('', entry.inputHeader, '', description ? String(description) : entry.missingDesc);
  return parts.join('\n');
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
