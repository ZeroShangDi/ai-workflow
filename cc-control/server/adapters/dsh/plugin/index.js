/**
 * awf-dsh — AWF 的 DSH 插件（host 半侧）
 *
 * 职责：把 AWF 发来的指令落到 DSH 运行时（建/找会话、派发、打断、快照、一次性调用、装配），
 * 并把平台事件回传给 AWF。**调度判断不在这一侧**（任务挑选、阶段链、门禁归 AWF 宿主）。
 *
 * 装配形态（Cordis）：ESM，具名导出 `name` / `inject` / `apply`。
 *   - `inject` 只列真正必需的服务；其余按 op 用 `ctx.get(name)` 惰性取，
 *     这样缺某个能力时是**该 op 显式失败**，而不是整个插件装不起来。
 *   - 通道启动放进 `ctx.effect(...)`：卸载时自动断开（不留野连接）。
 *
 * 配置（profile 的 patch 行 `config`，或环境变量）：
 *   awfBase   AWF server 基址（也读 `AWF_DSH_BASE`）—— 缺它则插件不启动通道并**明确告警**
 *   webUrl    打开页面用的基址（缺省按 webPort 拼）
 *   provider / model  一次性调用用的模型（缺省走平台默认）
 *
 * 见 docs/discuss/dsh-adapter-execution.md §2.7 与 §2.5（U16 批准策略的正确接线）。
 */

import { createBridgeClient } from './lib/bridge-client.js';
import { createOps, lastAssistantText } from './lib/ops.js';

export const name = 'awf-dsh';

/** 只依赖 timer（重连退避用）；其余服务按需 `ctx.get`，缺失时对应 op 显式失败 */
export const inject = ['timer'];

/** 插件版本（握手时带给 AWF，供其版本可识别） */
const PLUGIN_VERSION = '0.0.1';

export function apply(ctx, config = {}) {
  const log = (level, msg) => {
    const line = `[awf-dsh][${level}] ${msg}`;
    if (level === 'info') console.log(line); else console.error(line);
  };

  const awfBase = config.awfBase || process.env.AWF_DSH_BASE;
  if (!awfBase) {
    // 明确告警而不是静默：没配 AWF 地址，插件装上了也驱动不了任何东西
    log('warn', '未配置 awfBase（config.awfBase 或 AWF_DSH_BASE）—— 指令通道不启动');
    return;
  }

  // client 后建、ops 先用：事件上报经闭包取 client（避免构造循环）
  let client = null;
  const { dispatch, noteApproval, createdByAwf, inFlight } = createOps({
    ctx,
    config,
    log,
    onEvent: (event, facts) => client?.emitEvent(event, facts),
  });
  client = createBridgeClient({
    awfBase,
    pluginVersion: PLUGIN_VERSION,
    dispatch,
    log,
  });

  // ── U16 批准策略：**先只记录 + 委派**，不自动批准 ──
  // 理由：在实测搞清「workspace-write 预设下到底什么操作会请求批准」之前，自动批准可能把沙箱边界一起放开。
  // 平台应答者缝见 docs/discuss/dsh-adapter-execution.md §2.5：返回 'allowed-once' 即认领，`next()` 委派给
  // 下一个应答者（UI/人工；无应答者时平台 fail closed = 拒绝）。
  ctx.on('approval/request', (req, next) => {
    const sessionId = req?.agent?.session?.header?.id ?? null;
    const ours = sessionId !== null && createdByAwf.has(sessionId);
    noteApproval(req, { sessionId, ours });
    client?.emitEvent({
      type: 'approval.requested',
      sessionId,
      ours,
      toolName: req?.toolName ?? null,
      reason: req?.reason ?? null,
    });
    log('info', `批准请求（${ours ? 'AWF 会话' : '非 AWF 会话'}）：tool=${req?.toolName ?? '?'} reason=${String(req?.reason ?? '').slice(0, 120)}`);
    return next();
  });

  // ── 回合边界 → AWF（订阅会话事件 firehose）──
  ctx.on('session/event', createTurnReporter({
    createdByAwf,
    inFlight,
    emit: (event, facts) => client?.emitEvent(event, facts),
  }));

  ctx.effect(() => {
    client.start();
    log('info', `指令通道启动：${awfBase}（profile=${process.env.DSH_HOME || '?'}）`);
    return () => {
      client.stop();
      log('info', '指令通道已停止');
    };
  }, 'awf-dsh: bridge client');

  // ── C29（命令发现）：把 /w-plan 注册成 DSH 原生命令 ──
  // 作用范围说明：DSH 的 slash command 只在**网页输入框**触发（API 注入的 prompt 不走
  // commands.execute），所以它服务于「人在网页里手敲 /w-plan …」，`awf plan` 走的是
  // server 侧注入的同形指令（见 server/shared/prompts.js）。两者共享同一条规划方法。
  ctx.effect(() => {
    // 服务必须经 ctx.get 取（属性访问会触发 Cordis 的 inject 校验，没声明就抛错）
    const commands = ctx.get?.('commands');
    if (!commands?.register) { log('warn', 'commands 服务不可用 —— 不注册 /w-plan'); return; }
    return commands.register({
      name: 'w-plan',
      description: 'AWF 规划：从需求到 范围+WBS+任务列表，最后写入 state.json',
      input: { hint: '<需求描述>' },
      handler: async (invocation) => {
        const desc = String(invocation?.rawInput ?? '').trim();
        const text = [
          '这是 AWF 的规划任务，产出 = 范围（inScope/outOfScope，100% 敲定）+ WBS + 任务列表（插入门禁任务），最后用 awf-state 工具一次性写入 state.json。',
          '先用 skill 工具按需加载：awf-plan-norm → awf-plan-wbs → awf-plan-tasks → awf-plan-prompt；上下文不足时加载 code-context-onboard。规划只写临时文件，最后才写 state.json。',
          '## 需求原文（必须完整使用，不得截断或改写）',
          '',
          desc || '(未提供描述：先用 ask_user_question 问清「要做什么、给谁用、核心功能期望」)',
        ].join('\n');
        try {
          const llm = await import('@deepseek-ai/dsh-llm');
          invocation.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
          return { kind: 'success', text: '已注入 AWF 规划指令' };
        } catch (err) {
          return { kind: 'error', text: `无法注入规划指令：${err.message}` };
        }
      },
    });
  }, 'awf-dsh: register /w-plan command');

}

/**
 * 会话事件 → AWF 事件的翻译器（可单测的纯逻辑）。
 *
 * 两类会话，口径不同：
 *  ① **AWF 自己创建的主会话**（`createdByAwf`）—— 报会话态：
 *     turn/start → `turn.started`（平台开始跑这一轮）
 *     turn/end   → `session.ready`（这一轮结束；AWF 的 busy→ready 靠这条）
 *  ② **主会话派生的子 Agent 会话**（`header.parentSession` 指向 AWF 会话）—— 报生命周期：
 *     turn/start → `agent.started`（AWF 建基线；没有基线就不会结算它的结果）
 *     turn/end   → `agent.stopped` + **末条 assistant 文本**（RESULT/NEEDS_INPUT 写在那里，
 *                  AWF 侧的平台无关处理器据此落账 —— 多 agent 的「结果归属」靠这条，T-P3-01）
 * 子会话不进 `inFlight`：那是主会话的 busy/ready 语义，子 Agent 在跑不代表主会话忙。
 * 「平台受理回执」（prompt 的 accepted）与「回合结束」是两件事，分开上报。
 * @param {{createdByAwf: Set<string>, inFlight: Set<string>, emit: Function,
 *          lastText?: Function, log?: Function}} deps
 *   lastText(session) → {text} 取末条 assistant 文本；缺省用 ops 的同一份提取实现
 * @returns {(session: object, event: object) => void}
 */
export function createTurnReporter({ createdByAwf, inFlight, emit, lastText = lastAssistantText, log = () => {} }) {
  return (session, event) => {
    const sessionId = session?.header?.id ?? null;
    if (!sessionId) return;
    const cwd = session?.header?.cwd ?? null;

    // ② 子 Agent：只认「父会话是 AWF 会话」的那些（别把用户自己的子会话算进来）
    const parentSessionId = session?.header?.parentSession ?? null;
    if (parentSessionId && createdByAwf.has(parentSessionId)) {
      if (event?.type === 'turn/start') {
        emit({ type: 'agent.started', agentId: sessionId, parentSessionId, cwd }, { sessionExists: true, cwd });
        return;
      }
      if (event?.type === 'turn/end') {
        let text = null;
        try { text = lastText(session)?.text ?? null; } catch (err) { log('warn', `取子 Agent 末条文本失败：${err.message}`); }
        emit(
          {
            type: 'agent.stopped',
            agentId: sessionId,
            parentSessionId,
            cwd,
            lastAssistantMessage: text,
            reason: event?.data?.reason ?? null,
          },
          { sessionExists: true, cwd },
        );
        return;
      }
      log('info', `忽略子会话事件 ${event?.type}`);
      return;
    }

    if (!createdByAwf.has(sessionId)) return; // 非 AWF 会话：不碰它的状态
    if (event?.type === 'turn/start') {
      inFlight.add(sessionId);
      emit({ type: 'turn.started', sessionId, cwd }, { ready: false, sessionExists: true, sessionId, cwd });
      return;
    }
    if (event?.type === 'turn/end') {
      inFlight.delete(sessionId);
      let text = null;
      try { text = lastText(session)?.text ?? null; } catch (err) { log('warn', `取末条文本失败：${err.message}`); }
      emit(
        // lastAssistantMessage：回合末门阀（决策）在 DSH 侧唯一能看到的「这一轮说了什么」——
        // cc 的等价物是 Stop hook 的 body.last_assistant_message
        { type: 'session.ready', sessionId, cwd, lastAssistantMessage: text, reason: event?.data?.reason ?? null },
        { ready: true, sessionExists: true, sessionId, cwd },
      );
      return;
    }
    log('info', `忽略会话事件 ${event?.type}`);
  };
}

/** 供测试/诊断：不做装配，只暴露客户端工厂 */
export { createBridgeClient };
