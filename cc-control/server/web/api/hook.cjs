'use strict';
/**
 * api/hook.cjs — hook 域：CC hooks 回调总入口（/hook）
 *
 * 路由（method + path）：
 *   POST /hook（可选 ?sid、?event）  SessionStart / UserPromptSubmit / Stop / Subagent(Start|Stop)
 *                                    + AskUserQuestion 的 Pre/Post 决策门阀挂点
 *
 * 两条路：
 *   - 带 ?sid：早路路由到该 sid 的会话槽，只改槽内存态，**不碰主槽**（多 run 隔离）。
 *   - 无 sid：走主槽，并在 AskUserQuestion 的 Pre/Post 上接决策门阀。
 * 返回值可带 ccOutput（决策门阀要求 CC 回吐的行）。
 *
 * 约定：`handle(req, res, url, rt, deps)` 返回 boolean —— true=本域已处理（响应已发）；
 * false=不是本域路由，交下一个。deps 由入口注入（本域暂不使用）。
 */

const { resetRunMeta, updateRunMeta } = require('../../observability/metrics.cjs');
const { readJson, send } = require('./util.cjs');

async function handle(req, res, url, rt, deps) {
  const pathname = url.pathname;
  if (req.method === 'POST' && pathname === '/hook') {
    await handleHook(req, res, url, rt);
    return true;
  }
  return false;
}

/**
 * POST /hook —— CCS hooks 回调总入口。
 * 两条路：
 *   - 带 ?sid：早路路由到该 sid 的会话槽，只改槽内存态，**不碰主槽**（多 run 隔离）。
 *   - 无 sid：走主槽，处理 SessionStart / UserPromptSubmit / Stop / Subagent(Start|Stop)，
 *     并在 AskUserQuestion 的 Pre/Post 上接决策门阀。
 * 返回值可带 ccOutput（决策门阀要求 CC 回吐的行）。
 */
async function handleHook(req, res, url, rt) {
  const body = (await readJson(req)) || {};
  const event = body.event || url.searchParams.get('event');
  const { ctx, session } = rt;
  let hookCcOutput = null;

  // 带 sid 的 hook → 路由到该 sid 的会话槽
  const hookSid = url.searchParams.get('sid');
  if (hookSid) {
    const slot = rt.sessionFor(hookSid);
    console.log(`[hook:${hookSid}] ${event} -> ${slot?.state}`);
    if (slot) {
      // 与主槽同款状态机，但只影响本槽：开始→ready、提交→busy、停止→清理并 ready
      if (event === 'SessionStart') slot.setReady();
      else if (event === 'UserPromptSubmit') slot.setBusy();
      else if (event === 'Stop') { if (!ctx.decisionEnabled()) slot.clearDecision(); slot.setReady(); }
      else if (event === 'PreToolUse' && body?.tool_name === 'AskUserQuestion') {
        const q = Array.isArray(body?.tool_input?.questions) ? body.tool_input.questions[0] : null;
        if (q && !ctx.decisionEnabled()) {
          // 只取第一问；把 CC 的问题形状归一成决策模型
          slot.setDecision({
            type: q.multiSelect ? 'multiSelect' : 'choice',
            multiSelect: !!q.multiSelect,
            question: q.question,
            options: (q.options || []).map((o) => o.label),
            header: q.header || null,
          });
        }
      }
    }
    return send(res, 200, { ok: true, event: event || null, state: slot?.state ?? 'ready' });
  }

  if (event === 'SessionStart') {
    // 诊断重启期间，忽略隔离会话的 SessionStart（否则会把诊断快照的会话误当主会话）
    if (rt.observability.diagnosisInFlight && body.session_id && body.session_id !== session.mainSessionId) {
      console.log(`[diagnosis] ignored isolated SessionStart ${body.session_id}`);
      return send(res, 200, { ok: true, event, state: session.state });
    }
    // 换了会话 id（新会话）→ 复位子 agent 记录与运行元数据（旧会话的一切作废）
    if (body.session_id && body.session_id !== session.mainSessionId) {
      rt.subagent.reset();
      resetRunMeta(ctx.projectRoot);
      rt.observability.metricsCache = { at: 0, value: null }; // 清指标缓存，强制重算
    }
    if (body.session_id) session.mainSessionId = body.session_id;
    session.bumpSessionSeq(); // 会话启动序号 +1（CLI 据此判「本次会话已就绪」）
    hookUpdateMeta(ctx, session, body);
    session.setReady();
    ctx.logger.resetTranscript();
  } else if (event === 'UserPromptSubmit') {
    if (isMainSession(session, body)) session.setBusy(); // 只有主会话的提交才算「忙」
  } else if (event === 'Stop') {
    if (isMainSession(session, body)) {
      const out = rt.decision.onStop(body); // 决策门阀：在 Stop 上判定是否需要决策
      if (out) hookCcOutput = out.ccOutput;
    }
  } else if (event === 'SubagentStart') {
    rt.subagent.logEvent(event, body);
    // 主会话已知且这是外部会话 → 跳过（不是本项目派发的子 agent）
    if (session.mainSessionId && body.session_id && body.session_id !== session.mainSessionId) {
      console.log(`[subagent-start] skip external session ${body.session_id}`);
    } else {
      const key = body.agent_id || body.session_id || 'unknown';
      rt.observability.trackAgent(key, { sessionId: body.session_id || null, status: 'running', startedAt: Date.now() });
      hookUpdateSubagentMeta(ctx, key, body, 'running');
    }
  } else if (event === 'SubagentStop') {
    handleSubagentStop(rt, body); // 解析 RESULT/NEEDS_INPUT 并原子落账
  }

  // 决策门阀的两个挂点（在主槽路径上）
  if (event === 'PreToolUse' && body.tool_name === 'AskUserQuestion') {
    const out = rt.decision.onAskUserQuestion(body); // 决策模式下：拦下提问、自行决策
    if (out) hookCcOutput = out.ccOutput;
  }
  if (event === 'PostToolUse' && body.tool_name === 'AskUserQuestion') {
    // AskUserQuestion 被回答 → 把回答回填进 decisionPending（带上 answered 标记）
    const prev = session.decisionPending;
    const resp = body.tool_response;
    console.log(`[hook] AskUserQuestion answered, raw: ${JSON.stringify(resp).slice(0, 300)}`);
    if (prev && prev.source === 'AskUserQuestion') {
      let answer = '';
      // 回答形状多样（字符串 / {answers:{...}} / {answer} / 其他）—— 逐种兜底归一成字符串
      if (typeof resp === 'string') answer = resp;
      else if (resp?.answers && typeof resp.answers === 'object') answer = Object.values(resp.answers).join(', ');
      else if (resp?.answer) answer = String(resp.answer);
      else answer = JSON.stringify(resp);
      session.setDecision({ ...prev, answer, answered: true });
    }
  }

  console.log(`[hook] ${event} -> ${session.state}`);
  const hookResp = { ok: true, event: event || null, state: session.state };
  if (hookCcOutput) hookResp.ccOutput = hookCcOutput; // 决策门阀要求 CC 回吐的内容
  return send(res, 200, hookResp);
}

/** 判断 hook 是否来自主会话（无主会话 id 或 hook 未带 session_id 时一律视为是） */
function isMainSession(session, body) {
  return !session.mainSessionId || !body?.session_id || body.session_id === session.mainSessionId;
}

/** 更新 run-meta 的会话级字段（SessionStart 时记 projectRoot / mainSessionId / startedAt） */
function hookUpdateMeta(ctx, session, body) {
  updateRunMeta(ctx.projectRoot, (meta) => ({
    ...meta,
    projectRoot: ctx.projectRoot,
    startedAt: meta.startedAt || new Date().toISOString(), // 首次设置后保持不变
    endedAt: null,                                          // 新会话开始 → 清结束时间
    mainSessionId: body.session_id || meta.mainSessionId || null,
    updatedAt: new Date().toISOString(),
  }));
}

/** 更新 run-meta 里某子 agent 的条目（SubagentStart/Stop 都调，按 status 区分） */
function hookUpdateSubagentMeta(ctx, key, body, status) {
  updateRunMeta(ctx.projectRoot, (meta) => ({
    ...meta,
    projectRoot: ctx.projectRoot,
    subagents: {
      ...(meta.subagents || {}),
      [key]: {
        ...(meta.subagents || {})[key],
        agentId: key,
        sessionId: body.session_id || ((meta.subagents || {})[key] || {}).sessionId || null,
        status,
        startedAt: ((meta.subagents || {})[key] || {}).startedAt || new Date().toISOString(), // 保留首次开始时间
        stoppedAt: status === 'stopped' ? new Date().toISOString() : null,
        transcriptPath: body.agent_transcript_path || ((meta.subagents || {})[key] || {}).transcriptPath || null,
      },
    },
    updatedAt: new Date().toISOString(),
  }));
}

/**
 * SubagentStop：解析子 agent 输出并落账。
 * 子 agent 只输出 RESULT（正常完成）或 NEEDS_INPUT（需人工）最后一行，宿主/hook 负责把它落进 state。
 * 谓词优先级：needs（需人工）优先于 result；两者都没有则不可结算（可能 recoverable）。
 */
function handleSubagentStop(rt, body) {
  const { ctx } = rt;
  const key = body.agent_id || body.session_id || 'unknown';
  rt.subagent.logEvent('SubagentStop', body);
  // 外部会话的 SubagentStop 直接忽略
  if (ctx.mainSessionId && body.session_id && body.session_id !== ctx.mainSessionId) return;
  const agent = rt.observability.agents.get(key);
  if (agent) agent.status = 'stopped';
  hookUpdateSubagentMeta(ctx, key, body, 'stopped');
  if (!agent) {
    // 没记过 SubagentStart → 无基线，跳过（否则可能误结算别的 agent 的任务）
    console.log(`[subagent-stop] skip untracked agent ${key} (no SubagentStart)`);
    return;
  }
  const needs = rt.subagent.parseNeedsInput(body);
  const result = needs ? null : rt.subagent.parseResult(body); // 有 needs 就不再解析 result
  ctx.logger.captureSubagentTranscript(body, needs?.taskId || result?.taskId, key);
  if (needs) {
    rt.subagent.logNeedsInput(body, needs);
    console.log(`[subagent-needs] ${needs.taskId}: ${needs.question.slice(0, 40)}`);
  } else {
    const settled = rt.subagent.settle(body); // 原子落账（awf_task_complete）
    if (!settled.ok) {
      // 不可结算：记失败（除非明确标记 recoverable===false —— 那就只是丢弃，不算失败）
      console.log(`[subagent-settle] ${settled.reason} (agent ${key})`);
      if (settled.recoverable !== false) rt.subagent.logFailure(body, settled);
    } else {
      console.log(`[subagent-settle] ${settled.taskId} -> ${settled.status}`);
    }
  }
}

module.exports = { handle };
