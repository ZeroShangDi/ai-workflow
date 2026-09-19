/**
 * commands.js — 把包内的 `commands/*.md` 注册成 DSH 原生命令
 *
 * 为什么必须有这一层：DSH **没有**命令目录发现（全树只有 `dsh-skill-filesystem`
 * 会扫文件系统，命令只能经 `ctx.commands.register()` 声明）。所以 cc 侧「放个 md
 * 平台自己读」的形态在 DSH 不成立 —— md 在这里是**数据**，本模块负责把它翻成注册调用。
 *
 * 与 cc 的差异（都是平台机制差异，不是业务差异）：
 *   - 命令名：DSH 正则 `^[a-z][a-z0-9_-]*$` 禁冒号，故用扁平名（`w-plan`），
 *     不带 cc 的 `ai-workflow-code:` 命名空间；
 *   - `description` / `hint`：cc 从 md 推导，DSH 必须显式给 → 由 md 的 frontmatter 提供。
 *
 * 触发范围：DSH 的 slash command 只在**网页输入框**触发；经 API 注入的 prompt 不走
 * commands.execute。所以本模块服务「人在网页里手敲 /w-plan …」；`awf plan` 走的是
 * server 侧注入的同形指令（见 server/shared/prompts.js），两者共用同一份命令正文。
 */

import { listCommands } from './assets.js';

/**
 * 注册包内全部命令。
 * @param {object} ctx Cordis 根 ctx
 * @param {{log: Function, loadLlm?: Function}} deps
 * @returns {{registered: string[], skipped: string[]}}
 */
export function registerCommands(ctx, { log = () => {}, loadLlm = () => import('@deepseek-ai/dsh-llm') } = {}) {
  // 服务必须经 ctx.get 取：属性访问会触发 Cordis 的 inject 校验，没声明就抛错
  const commands = typeof ctx?.get === 'function' ? ctx.get('commands') : undefined;
  if (!commands?.register) {
    log('warn', 'commands 服务不可用 —— 不注册任何 /w-* 命令');
    return { registered: [], skipped: listCommands().map((c) => c.name) };
  }

  const registered = [];
  const skipped = [];
  for (const cmd of listCommands()) {
    try {
      ctx.effect(() => commands.register({
        name: cmd.name,
        description: cmd.description,
        ...(cmd.hint ? { input: { hint: cmd.hint } } : {}),
        handler: (invocation) => handleCommand(cmd, invocation, { log, loadLlm }),
      }), `awf-dsh: command ${cmd.name}`);
      registered.push(cmd.name);
    } catch (err) {
      // 单条注册失败不拖垮其余命令，但必须留痕（不静默少一条命令）
      log('warn', `命令 /${cmd.name} 注册失败：${err.message}`);
      skipped.push(cmd.name);
    }
  }
  log('info', `已注册 ${registered.length} 条命令：${registered.join(', ')}`);
  return { registered, skipped };
}

/**
 * 命令处理器：把「命令正文 + 本次输入」作为一条用户消息注入当前会话。
 *
 * 注入正文而不是把正文塞进工具返回：命令正文是**给模型的完整方法论文本**，
 * 走 followup 才等价于 cc 里敲 slash command 的效果。
 * @param {object} cmd assets.listCommands() 的条目
 * @param {object} invocation DSH 的 {commandId, agent, rawInput, attachments, signal}
 * @param {{log: Function, loadLlm: Function}} deps
 * @returns {Promise<{kind: 'success'|'error', text: string}>}
 */
async function handleCommand(cmd, invocation, { log, loadLlm }) {
  const raw = String(invocation?.rawInput ?? '').trim();
  const text = composeInjection(cmd, raw);
  try {
    const llm = await loadLlm();
    invocation.agent.followup(llm.createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }));
    return { kind: 'success', text: raw ? `已注入 /${cmd.name} 指令` : `已注入 /${cmd.name} 指令（未带输入）` };
  } catch (err) {
    log('warn', `命令 /${cmd.name} 注入失败：${err.message}`);
    return { kind: 'error', text: `无法注入 /${cmd.name} 指令：${err.message}` };
  }
}

/** 正文 + 输入段（纯函数，便于单测） */
export function composeInjection(cmd, rawInput) {
  const parts = [cmd.body];
  if (rawInput) {
    parts.push('', '## 本次输入', '', rawInput);
  } else if (cmd.emptyInput) {
    // 命令自己声明了「没输入时该怎么办」——不替它猜（如 w-plan 要先问清需求）
    parts.push('', cmd.emptyInput);
  }
  return parts.join('\n');
}
