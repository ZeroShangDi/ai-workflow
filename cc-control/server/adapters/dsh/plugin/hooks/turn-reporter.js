/**
 * turn-reporter.js — 会话事件 → AWF 事件的翻译器（cc 侧 5 个 hook 的 DSH 等价物）
 *
 * cc 靠 5 个 hook 点（SessionStart / UserPromptSubmit / Stop / SubagentStart / SubagentStop）
 * 把运行态告诉 AWF；DSH 没有 hook 机制，等价物是 **会话事件火线** `ctx.on('session/event')`
 * —— 一条订阅覆盖这 5 个点（映射见同目录 hooks.json）。
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
 *
 * AWF 侧消费：`server/adapters/dsh/index.cjs` 的 `DSH_EVENT_MAP`（落成平台无关事件）。
 */

import { lastAssistantText } from '../lib/ops.js';

/**
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
