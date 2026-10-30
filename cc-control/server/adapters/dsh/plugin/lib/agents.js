/**
 * agents.js — 把包内的 `agents/*.md` 装配成 DSH 的**命名子 Agent**
 *
 * 两平台的形状差异（业务身份一致，机制不同）：
 *   - cc：`agents/awf-worker.md` 是一份带 frontmatter 的**声明**，主会话用
 *     `Agent 工具（subagent_type: ai-workflow-core:awf-worker）` 按名字引用它；
 *     平台保证 `tools:` 白名单生效、正文进子 Agent 的系统提示词。
 *   - DSH：**没有 subagent_type 注册表**（`dsh-tool-workflow` 甚至显式拒绝 `agentType`）。
 *     命名身份靠「调哪个工具」表达 —— 一个 `dsh-tool-subagent` 实例 = 一个工具名。
 *     这正是 `standard/agent.cordis.yml` 自己的用法（`subagent` / `subagent_fork` 各一行）。
 *
 * 所以本模块把每个 `agents/<name>.md` 装配成一个独立实例：
 *   toolName  ← 名字（kebab → snake：awf_worker）
 *   persona   ← 正文（原样，不缩写：正文里的 RESULT/NEEDS_INPUT 协议、verdict 旁挂字段、
 *               architecture 要求都必须在，否则门禁闭环与结果归属会失效 —— 审计 A10 的教训）
 *   toolFilter← frontmatter 的 `tools:` 白名单（映射成 DSH 工具名）
 *   maxDepth  ← 0（这些身份都不允许再派生）
 *
 * 白名单**不猜**：映射后逐个在真实工具面上核验（`tools.restrict` 试挂再摘），
 * 核不上的剔除并留痕。宁可少给一个权限，也不要某次平台改名让整条派发静默失败。
 */

import { listAgents, mapToolNames } from './assets.js';

/**
 * 递归深度兜底值 —— **md 的 frontmatter 应该显式写 `max-depth`**（三份资产都写了 0），
 * 这里只是它缺失时的保守兜底：宁可少给「继续派生」的能力，也不要缺省放开。
 */
const DEFAULT_MAX_DEPTH = 0;

/**
 * 装配全部子 Agent 工具实例。
 * @param {object} agentCtx setup 窗口里的 agent 作用域 ctx
 * @param {{log: Function, loadToolSubagent?: Function}} deps
 * @returns {Promise<{mounted: string[], details: Array<object>}>}
 */
export async function mountSubagentTools(agentCtx, {
  log = () => {},
  loadToolSubagent = () => import('@deepseek-ai/dsh-tool-subagent'),
} = {}) {
  let ToolSubagent;
  try {
    ToolSubagent = await loadToolSubagent();
  } catch (err) {
    log('warn', `无法加载 dsh-tool-subagent —— 本会话没有命名子 Agent：${err.message}`);
    return { mounted: [], details: [] };
  }

  const mounted = [];
  const details = [];
  for (const agent of listAgents()) {
    const { allow, dropped, probed } = resolveToolFilter(agentCtx, agent, log);
    const config = {
      provider: 'spawn',
      toolName: agent.toolName,
      persona: agent.persona,
      maxDepth: agent.maxDepth ?? DEFAULT_MAX_DEPTH,
      ...(allow ? { toolFilter: { allow } } : {}),
    };
    try {
      agentCtx.plugin(ToolSubagent, config);
      mounted.push(agent.toolName);
      details.push({ toolName: agent.toolName, source: agent.name, filter: allow, dropped, probed });
    } catch (err) {
      // 挂不上就是「派发面缺一个身份」，必须显式失败在日志里，而不是等 run 卡住
      log('error', `子 Agent ${agent.name}（工具名 ${agent.toolName}）装配失败：${err.message}`);
      details.push({ toolName: agent.toolName, source: agent.name, error: err.message });
    }
  }
  if (mounted.length) log('info', `已装配命名子 Agent：${mounted.join(', ')}`);
  return { mounted, details };
}

/**
 * cc 的 `tools:` 白名单 → DSH 的 `toolFilter.allow`，并在真实工具面上核验。
 *
 * 核验手法：`tools.restrict({allow:[name]})` 对未知名字**必然抛错**（平台语义：
 * 「unknown names fail startup」），拿到 disposer 就立刻摘掉 —— 同一 tick 内完成，
 * 不会有 agent 跑在这段瞬时限制里。这不是猜名字，是问平台。
 *
 * 核验不可用时（无 scoped ctx 等服务语义变化）**不降级成猜测**：原样放行并留痕，
 * 由日志提示「白名单未经核验」。
 * @returns {{allow: string[]|null, dropped: Array<{name: string, reason: string}>, probed: boolean}}
 */
export function resolveToolFilter(agentCtx, agent, log = () => {}) {
  if (!agent.allowTools || agent.allowTools.length === 0) return { allow: null, dropped: [], probed: false };

  const { mapped, unmapped } = mapToolNames(agent.allowTools);
  const candidates = [...mapped, ...unmapped];
  const tools = agentCtx?.tools;

  if (typeof tools?.restrict !== 'function') {
    log('warn', `${agent.name} 的工具白名单未经核验（agentCtx.tools.restrict 不可用）：${candidates.join(', ')}`);
    return { allow: candidates, dropped: [], probed: false };
  }

  const allow = [];
  const dropped = [];
  let probingSupported = true;
  for (const name of candidates) {
    if (!probingSupported) { allow.push(name); continue; }
    try {
      const lift = tools.restrict({ allow: [name] });
      if (typeof lift === 'function') lift();
      allow.push(name);
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (msg.includes('unknown global tool')) {
        dropped.push({ name, reason: '该会话工具面里没有这个名字' });
      } else {
        // 不是「名字不存在」，而是「核验手段本身不可用」—— 停止核验，余下原样放行
        probingSupported = false;
        log('warn', `${agent.name} 的工具白名单核验中止（${msg}），余下名字未经核验`);
        allow.push(name);
      }
    }
  }
  if (dropped.length) {
    log('warn', `${agent.name} 的工具白名单剔除 ${dropped.length} 项：${dropped.map((d) => d.name).join(', ')}`);
  }
  return { allow: allow.length ? allow : null, dropped, probed: probingSupported };
}
