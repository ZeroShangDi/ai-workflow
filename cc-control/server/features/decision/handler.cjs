'use strict';
/**
 * decision/handler.cjs — 决策流程编排（Stop 闸门 / AskUserQuestion 决策化 / 落盘 / 纠偏任务）
 *
 * 抽象动机：原 server.cjs 把「决策事件怎么分流、结果怎么落盘、续跑怎么置位」写死在文件中间，
 * 与 ready/busy 状态机、路由分发混在一起。这里收敛成**一个 handler**，它显式声明自己需要什么
 * （会话态 + 落盘 + 日志 + 决策存储 + 上报事件），不再穿透整个 pcx。
 *
 * 边界：
 *   - 判定规则（什么算失败、什么算决策入口）在 gate.cjs；本模块只做**编排**。
 *   - 决策内容（answer 本身）由 DC（decision-core 技能）产出，本模块不解释其语义。
 *   - `persist` 只负责「记录 + 置续跑位」，不驱动执行 —— 续跑的注入由 run 域在就绪时消费。
 */

const gateRules = require('./gate.cjs');
const { parseDecisionResult } = require('./core.cjs');
const decisionInstruction = require('./instruction.cjs');
const { ccShapes } = require('../../adapters/ports.cjs');

/**
 * @param {object} deps
 * @param {object} deps.session            会话内存态（decisionGate / decisionResume / setDecision / clearDecision / setReady）
 * @param {object} deps.logger             运行日志（logDecision / captureFromTranscript）
 * @param {Function} deps.newDecisionStore 决策追加式存储工厂
 * @param {Function} deps.decisionEnabled  决策闸门是否开启（读配置）
 * @param {Function} deps.publishEvent     上报领域事件（host 事件环）
 * @param {object} deps.stores             state store（纠偏任务要写任务图；见返回面的 appendDecisionReviewTask）
 */
function createDecisionHandler({
  session, logger, newDecisionStore, decisionEnabled, publishEvent = () => {}, stores,
}) {
  /** 下一个决策 id（序号由会话持有，保证同一会话内单调） */
  function nextId() {
    return session.decisionSeqGen.nextId();
  }

  /** 无有效结果时的兜底模板（构造归 gate） */
  function fallbackResult() {
    return gateRules.deferredFallbackResult();
  }

  /**
   * 捕获落盘 + 置续跑位；返回 decisionId。
   * 顺序有意固定：先 append（幂等，重复完成不会二次落盘）→ 记日志 → 置续跑位 → 上报事件。
   * 续跑位（decisionResume）只是「待消费的答复」，不驱动执行；真正注入由 run 域在就绪时读取，
   * 从而决策与执行解耦（本模块不持有执行权）。
   */
  function persist(result, source) {
    const decisionId = nextId();
    const createdAt = new Date().toISOString();
    const record = gateRules.buildCompletedRecord({ decisionId, result, source, createdAt });
    const appended = newDecisionStore().append(record);
    if (!appended.appended) console.log(`[decision-gate] append skipped for ${decisionId}`);
    logger.logDecision({
      at: createdAt,
      decisionId,
      event: 'decision_completed',
      detail: result.fallback === true ? `fallback type=${result.type}` : `resolved type=${result.type}`,
    });
    session.setDecisionResume({
      decision_id: decisionId,
      answer: result.answer,
      type: result.type,
      finality: result.finality,
      fallback: result.fallback === true,
    });
    publishEvent('decision.record', {
      decisionId,
      answer: result.answer ?? null,
      type: result.type ?? null,
      finality: result.finality ?? null,
      fallback: result.fallback === true,
    });
    return decisionId;
  }

  /**
   * AskUserQuestion 的 PreToolUse 决策化。
   * 这是决策门阀的**第二条入口**（第一条是 Stop 的文本标记）：闸门关时只「捕获」不改写控制流，
   * 把待决问题存进会话（供 Review/记忆），返回 null 表示不干预，提问工具照常工作。
   * @returns {object|null} 需回给 cc 的 ccOutput 片段（null = 不干预）
   */
  function onAskUserQuestion(body) {
    const questions = body?.tool_input?.questions;
    if (!questions || questions.length === 0) return null;

    const deciding = session.decisionGate?.phase === 'deciding';
    const action = gateRules.classifyAskQuestion({ enabled: decisionEnabled(), deciding, questions });

    if (action.kind === 'capture') {
      const q = action.question || questions[0];
      // 捕获即落记录（复盘要求）：不问「谁来答」，先记下「它发生了」——
      // 走人/AI/自动哪条路由是之后的事，记录必须都在。此前只存内存，决策一旦答完就无迹可查。
      const decisionId = nextId();
      const pending = {
        decisionId,
        // 归一成决策内核认识的形状：多选 → multiSelect，单选 → choice；选项只留 label。
        type: q.multiSelect ? 'multiSelect' : 'choice',
        multiSelect: !!q.multiSelect,
        question: q.question,
        options: (q.options || []).map((o) => o.label),
        header: q.header || null,
        source: 'AskUserQuestion',
      };
      session.setDecision(pending);
      recordAsked(pending);
      console.log(`[hook] AskUserQuestion detected (PreToolUse): ${q.question}`);
      return null;
    }
    if (action.kind === 'deny_deciding') {
      console.log('[hook] AskUserQuestion denied (deciding): 决策闭合前禁再问');
      return action.output;
    }
    console.log('[hook] AskUserQuestion denied (gate on): 改以决策标签收尾');
    return action.output;
  }

  /**
   * Stop 统一闸门。
   * 按 gateRules.classifyStop 给的三分支分派：deciding=拦截并注入指令；resolve=解析落盘并放行；
   * complete=清态放行。三种分支都以「本回合结束后的会话态」为准做清理，避免残留 deciding 标记。
   * @returns {object|null} 需回给 cc 的 ccOutput（null = 放行）
   */
  function onStop(body) {
    const text = typeof body?.last_assistant_message === 'string' ? body.last_assistant_message : '';
    const deciding = session.decisionGate?.phase === 'deciding';
    const branch = gateRules.classifyStop({
      enabled: decisionEnabled(),
      text,
      deciding,
      stopHookActive: body?.stop_hook_active,
    });

    if (branch.branch === 'deciding') {
      const startedAt = new Date().toISOString();
      // 首次进入：落 deciding 相位并把上一轮残留的续跑位清空（本次决策尚未产出答复）。
      session.decisionGate = { phase: 'deciding', startedAt };
      session.setDecisionResume(null);
      logger.logDecision({
        at: startedAt,
        decisionId: null,
        event: 'decision_started',
        detail: '决策入口（<AWF_DECISION_REQUIRED>）',
      });
      let instruction;
      try {
        instruction = decisionInstruction.readDecisionInstruction();
      } catch {
        // 指令文件缺失（如部署布局里没有 decision 插件）不能让闸门卡死：用一句话兜底文案继续。
        instruction = '决策模式：请产出 <AWF_DECISION_RESULT> 包裹的 Decision Result。';
      }
      return ccShapes.blockDecision(instruction);
    }

    if (branch.branch === 'resolve') {
      const parsed = parseDecisionResult(text);
      // 解析失败不悬空：用 deferred fallback 走同一条落盘链路（见 gate.deferredFallbackResult）。
      if (!parsed.valid) console.log(`[decision-gate] no valid result (${parsed.error}); deferred fallback`);
      persist(parsed.valid ? parsed.result : fallbackResult(), 'text');
      session.decisionGate = null;
      session.clearDecision();
      session.setReady();
      logger.captureFromTranscript();
      return null;
    }

    // complete：闸门关或普通回合收尾——清掉一切决策态后放行（放行 = 返回 null）。
    session.clearDecision();
    session.decisionGate = null;
    session.setDecisionResume(null);
    session.setReady();
    logger.captureFromTranscript();
    return null;
  }

  /**
   * 决策「被问出」落记录（复盘要求）：先记「它发生了」，不关心之后谁来答。
   * 与 persist 的 decision_completed 同属决策生命周期事件，落在同一个 DecisionStore 里，
   * 于是「问过什么 / 谁答的 / 答了什么」在 `/awf/decisions` 与前端决策页可一并复盘。
   */
  function recordAsked(pending) {
    const appended = newDecisionStore().append({
      event: 'decision_requested',
      decision_id: pending.decisionId,
      status: 'awaiting_human',
      source: 'AskUserQuestion',
      created_at: new Date().toISOString(),
      subject: { capability: 'decision_gate' },
      request: {
        decision_id: pending.decisionId,
        question: pending.question,
        options: pending.options,
        type: pending.type,
        multi_select: pending.multiSelect,
      },
    });
    if (!appended?.appended) console.log(`[decision] request append skipped for ${pending.decisionId}`);
    return appended;
  }

  /**
   * 决策「被答」落记录：`answeredBy` 标明走了哪条路由，复盘时据此区分人答的、AI 判的、还是自动选的第一项。
   * @param {{ decisionId: string, value: string, answeredBy?: 'human'|'auto'|'ai' }} input
   */
  function recordAnswered({ decisionId, value, answeredBy = 'human' }) {
    if (!decisionId) return null;
    return newDecisionStore().append({
      event: 'decision_answered',
      decision_id: decisionId,
      status: 'answered',
      source: answeredBy,
      answered_by: answeredBy,
      created_at: new Date().toISOString(),
      value,
    });
  }

  // 纠偏任务写入：由本实例面透出（web 层一律经 rt 取能力，不直连本模块文件）。
  // 注：函数本体仍单独导出 —— 它是「任务图写入」不是「决策流程」，模块外的复用面不变。
  return {
    nextId, fallbackResult, persist, onAskUserQuestion, onStop,
    recordAnswered,
    appendDecisionReviewTask: (input) => appendDecisionReviewTask(stores, input),
  };
}

/**
 * override → 向任务列表追加纠偏任务（kind=dev / source=decision_review）。
 *
 * 与 handler 分开导出：它是「任务图写入」，不是「决策流程」，消费方是 decisions 路由。
 * 幂等：任务 id 固定为 `<decision_id>-REV`，同一决策重复 override 只保留一条纠偏任务
 * （updateSync 返回 false = 不改写 state，existing 标记告知调用方已存在）。
 * @returns {{ ok: boolean, taskId?: string, existing?: boolean, error?: string }}
 */
function appendDecisionReviewTask(stores, { decision_id, instruction, original_answer }) {
  let out;
  stores.state.updateSync((s) => {
    if (!s) { out = { ok: false, error: 'state.json unreadable' }; return false; }
    const id = `${decision_id}-REV`;
    const existing = (s.tasks || []).find((t) => t.id === id);
    if (existing) { out = { ok: true, taskId: id, existing: true }; return false; }

    s.tasks = s.tasks || [];
    s.tasks.push({
      id,
      kind: 'dev',
      status: 'pending',
      title: `决策纠偏：${instruction.length > 28 ? `${instruction.slice(0, 28)}…` : instruction}`,
      source: 'decision_review',
      prompt: `决策纠偏（decision ${decision_id}）：人工 override 指令——${instruction}。原决策 answer：${original_answer || '(无)'}。请据此对受影响产物执行修正并落账。`,
      deps: [],
      plannedFiles: [],
      constraints: [],
      acceptance: `按 override 指令完成 ${decision_id} 的纠偏`,
      exec: { decision_id, instruction, original_answer: original_answer || null },
    });
    s.lastUpdated = new Date().toISOString();
    out = { ok: true, taskId: id };
    return true;
  });
  return out;
}

module.exports = { createDecisionHandler, appendDecisionReviewTask };
