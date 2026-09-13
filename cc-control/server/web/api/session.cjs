'use strict';
/**
 * api/session.cjs — 会话域：会话态读取 + 会话注入 + 决策入口
 *
 * 职责：把「给 CC 一句话 / 打断 / 挂起与应答决策 / 查会话态」这些对人机对话面的操作，
 * 转成对 rt.channel / rt.session / ctx.tmux / ctx.logger 的调用。
 *
 * 路由（method + path）：
 *   GET  /status                 会话态快照（无 sid=项目级；?sid=该槽；?snapshot 抓屏）
 *   GET  /probe                  w-monitor 外部侦查（会话在不在 + ready/busy + 抓取时刻；MCP awf_session_status 的服务端实现）
 *   POST /choice                 AI 挂起一个「选择」决策（校验后置 decisionPending）
 *   POST /ask                    AI 挂起一个「自由输入」决策
 *   POST /send                   注入一段文本（等就绪 → 标 busy → 抓基线 → 注文本）
 *   POST /cmd                    注入本地 slash 命令（如 /clear）
 *   POST /intervene              w-monitor 温和介入（要求 mode=pause）
 *   POST /intervene/interrupt    升级介入：Ctrl-C 打断 + 兜底定时器
 *   POST /stop                   直接打断（不要求 pause）
 *   POST /respond                回应 pending 决策
 *
 * 约定：`handle(req, res, url, rt, deps)` 返回 boolean —— true=本域已处理（响应已发）；
 * false=不是本域路由，交下一个。deps 由入口注入（{ registry, stopServer }），/status 取 registry 列项目。
 */

const interact = require('../interact.cjs');
const { READY_TIMEOUT_MS, LOCAL_CMD_FALLBACK_MS, DECISION_FALLBACK_MS, ENTER_DELAY_MS } = require('../../config.cjs');
const { readJson, send, requirePaused, noSession } = require('./util.cjs');

async function handle(req, res, url, rt, deps) {
  const pathname = url.pathname;
  const { ctx, session } = rt;

  // ── status ──
  // GET /status：无 sid → 项目级会话态（CLI 的 server 发现入口，也是读类 boot 兜底的典型）；
  //              带 sid → 该 sid 槽的内存态（多 run 观测）
  if (req.method === 'GET' && pathname === '/status') {
    const statusSid = url.searchParams.get('sid');
    if (statusSid) {
      const s = rt.sessionFor(statusSid);
      send(res, 200, {
        ok: true, sid: statusSid, state: s?.state ?? 'ready',
        decisionPending: s?.decisionPending ?? null, projectRoot: ctx.projectRoot,
      });
      return true;
    }
    const out = {
      ok: true, state: session.state, session: ctx.tmux.hasSession(), projectRoot: ctx.projectRoot,
      decisionPending: session.decisionPending, contextReady: session.contextReady,
      decisionGate: session.decisionGate, decisionResume: session.decisionResume,
      mainSessionId: session.mainSessionId, sessionSeq: session.sessionSeq,
      activeAgents: rt.observability.activeAgentCount(),
    };
    if (!url.searchParams.get('p')) out.projects = deps.registry.list();     // 无 ?p 视为「概览请求」，附带项目清单
    if (url.searchParams.get('snapshot')) {
      try { out.snapshot = ctx.tmux.capture(); } catch { out.snapshot = null; } // 可选抓屏（默认不抓，有开销）
    }
    send(res, 200, out);
    return true;
  }

  // ── probe（w-monitor 外部侦查）──
  // GET /probe：会话在不在 + ready/busy + 抓取时刻。这是 MCP `awf_session_status` 的服务端实现。
  // 刻意**不套** noSession 的 503：侦查没有失败态（probe 的 ok 恒为 true，信息不足由
  // state='unknown' 表达）—— 监控要靠它判断「会话是否正常」，它自己先报错就无从判断。
  if (req.method === 'GET' && pathname === '/probe') {
    send(res, 200, await rt.probe.inspect());
    return true;
  }

  // ── AI 通知：需要人做选择 / 自由输入 ──
  // 校验决策模型 → 置会话的 decisionPending（等待人经 /respond 回应）
  if (req.method === 'POST' && pathname === '/choice') {
    const body = await readJson(req);
    const v = interact.validateDecisionRequest('choice', body);
    if (!v.ok) { send(res, 400, { ok: false, error: v.error }); return true; }
    session.setDecision(v.decision);
    console.log(`[choice] ${v.decision.question}`);
    send(res, 200, { ok: true, decisionPending: session.decisionPending });
    return true;
  }
  if (req.method === 'POST' && pathname === '/ask') {
    const body = await readJson(req);
    const v = interact.validateDecisionRequest('text', body);
    if (!v.ok) { send(res, 400, { ok: false, error: v.error }); return true; }
    session.setDecision(v.decision);
    console.log(`[ask] ${v.decision.question}`);
    send(res, 200, { ok: true, decisionPending: session.decisionPending });
    return true;
  }

  // ── 会话注入：/send /cmd /intervene /stop /respond ──
  // /send：等就绪 → 标 busy → 抓 transcript 基线 → 记日志 → 注文本。这是最常用的「给 CC 一句话」入口。
  if (req.method === 'POST' && pathname === '/send') {
    const body = await readJson(req);
    if (!body || typeof body.text !== 'string' || body.text.length === 0) {
      send(res, 400, { ok: false, error: 'body must be {text: non-empty string}' });
      return true;
    }
    if (!ctx.tmux.hasSession()) { noSession(res, rt); return true; }
    const ok = await session.waitReady(READY_TIMEOUT_MS);
    if (!ok) { send(res, 409, { ok: false, error: 'still busy (ready timeout)' }); return true; } // 忙 → 409，不排队
    ctx.logger.captureFromTranscript();
    session.setBusy();
    ctx.logger.logPrompt(body.text);
    await submitRaw(rt, body.text);
    send(res, 200, { ok: true, sent: body.text });
    return true;
  }
  // /cmd：注入本地 slash 命令（如 /clear）；走 channel.sendLocalCmd（内含无 Stop hook 的兜底）
  if (req.method === 'POST' && pathname === '/cmd') {
    const body = await readJson(req);
    if (!body || typeof body.cmd !== 'string' || body.cmd.length === 0) {
      send(res, 400, { ok: false, error: 'body must be {cmd: non-empty string}' });
      return true;
    }
    if (!ctx.tmux.hasSession()) { noSession(res, rt); return true; }
    const ok = await rt.channel.sendLocalCmd(body.cmd);
    if (!ok) { send(res, 409, { ok: false, error: 'still busy (ready timeout)' }); return true; }
    send(res, 200, { ok: true, sent: body.cmd });
    return true;
  }
  // /intervene：w-monitor 的温和介入（仅在 pause 生效后）；记 reason + 注入修复提示
  if (req.method === 'POST' && pathname === '/intervene') {
    const body = await readJson(req);
    if (!body || typeof body.text !== 'string' || body.text.length === 0) {
      send(res, 400, { ok: false, error: 'body must be {text: non-empty string, reason?: string}' });
      return true;
    }
    if (!requirePaused(rt, res)) return true;
    if (!ctx.tmux.hasSession()) { noSession(res, rt); return true; }
    ctx.logger.logPrompt(`[w-monitor intervention] ${body.reason || 'unspecified'}\n${body.text}`);
    session.setBusy();
    await submitRaw(rt, body.text);
    send(res, 200, { ok: true, sent: body.text, intervention: true });
    return true;
  }
  // /intervene/interrupt：升级介入 —— 直接 Ctrl-C 打断当前响应，并起兜底定时器防卡 busy
  if (req.method === 'POST' && pathname === '/intervene/interrupt') {
    const body = (await readJson(req)) || {};
    if (!requirePaused(rt, res)) return true;
    if (!ctx.tmux.hasSession()) { noSession(res, rt); return true; }
    ctx.tmux.sendCtrlC();
    session.clearDecision();
    session.clearFallbackTimer();
    session.setFallbackTimer(setTimeout(() => {
      if (session.state === 'busy') session.setReady(); // Ctrl-C 后可能没有 Stop hook，兜底放回 ready
    }, LOCAL_CMD_FALLBACK_MS));
    send(res, 200, { ok: true, interrupted: true, reason: body.reason || null });
    return true;
  }
  // /stop：直接打断（不要求 pause —— 停是安全操作）；同样起兜底
  if (req.method === 'POST' && pathname === '/stop') {
    if (!ctx.tmux.hasSession()) { noSession(res, rt); return true; }
    ctx.tmux.sendCtrlC();
    session.clearDecision();
    session.clearFallbackTimer();
    session.setFallbackTimer(setTimeout(() => {
      if (session.state === 'busy') session.setReady();
    }, LOCAL_CMD_FALLBACK_MS));
    send(res, 200, { ok: true, stopped: true });
    return true;
  }
  // /respond：回应一个 pending 决策（注入人给的答案）。
  // 决策应答与普通发送共用「busy + 兜底」骨架，差别在兜底时长（人思考久 → DECISION_FALLBACK_MS）。
  if (req.method === 'POST' && pathname === '/respond') {
    const body = await readJson(req);
    if (!body || typeof body.value !== 'string' || body.value.length === 0) {
      session.clearDecision(); // 非法体也要清 pending，避免会话卡在等应答
      send(res, 400, { ok: false, error: 'body must be {value: non-empty string}' });
      return true;
    }
    if (!ctx.tmux.hasSession()) {
      session.clearDecision();
      noSession(res, rt);
      return true;
    }
    // 无 pending 决策时按普通发送处理：先等就绪（有 pending 则视为已在等，不额外等）
    if (!session.decisionPending) {
      const ok = await session.waitReady(READY_TIMEOUT_MS);
      if (!ok) { send(res, 409, { ok: false, error: 'still busy (ready timeout)' }); return true; }
    }
    const hadDecision = !!session.decisionPending;
    const question = session.decisionPending ? session.decisionPending.question : null;
    session.setBusy();
    if (hadDecision) ctx.logger.logChoice(question, body.value); // 只在实际应答决策时记 choice 日志
    session.clearDecision();
    await submitRaw(rt, body.value);
    const fallbackMs = hadDecision ? DECISION_FALLBACK_MS : LOCAL_CMD_FALLBACK_MS; // 应答决策给人更长兜底
    session.clearFallbackTimer();
    session.setFallbackTimer(setTimeout(() => {
      if (session.state === 'busy') session.setReady();
    }, fallbackMs));
    send(res, 200, { ok: true, sent: body.value });
    return true;
  }

  return false;
}

/** 直接注入文本（不等待收尾）—— /send 与 /intervene 用 */
async function submitRaw(rt, text) {
  rt.ctx.tmux.sendText(text);
  await new Promise((r) => setTimeout(r, ENTER_DELAY_MS)); // 文本与回车分两次发，中间留节奏
  rt.ctx.tmux.sendEnter();
}

module.exports = { handle };
