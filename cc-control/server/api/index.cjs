'use strict';
/**
 * api/index.cjs — 对外 HTTP 面（32 条路由的注册与分发）
 *
 * 本层只做三件事：**解析请求 → 调对应能力 → 回响应**。所有业务动作经 runtime（能力装配）完成，
 * 因此这里不出现任何 `session.state = ...` 这类状态写入 —— 那是能力自己的接口。
 *
 * 两条入口规则（原有语义，别改）：
 *   - 写类端点缺 `?p` → 400，**绝不**兜底到 boot 项目（2026-09-10 真机事故：手工 curl 缺 ?p
 *     静默暂停了在跑的 run 四小时）。唯一例外 `/shutdown`。
 *   - 读类保留 boot 兜底（`GET /status` 是 CLI 的 server 发现入口）。
 */

const path = require('node:path');
const fs = require('node:fs');
const { createStaticHost } = require('../static.cjs');
const interact = require('../interact.cjs');
const { encodeTextFrame, upgrade: wsUpgrade } = require('../ws.cjs');
const { READY_TIMEOUT_MS, LOCAL_CMD_FALLBACK_MS, DECISION_FALLBACK_MS, ENTER_DELAY_MS } = require('../config.cjs');
const { oneshot: oneshotPort } = require('../adapters/ports.cjs');
const { appendDecisionReviewTask } = require('../decision/handler.cjs');
const { readDiagnosis } = require('../observability/diagnosis.cjs');
const { resetRunMeta, updateRunMeta } = require('../observability/metrics.cjs');

/**
 * @param {object} deps
 * @param {object} deps.registry         项目注册表（resolveRuntime / list / all / bootRoot）
 * @param {Function} deps.stopServer     优雅关闭（/shutdown 用）
 */
function createApi({ registry, stopServer }) {
  // ── 静态托管 ──
  const WEB_PUBLIC_DEFAULT = path.join(__dirname, '..', 'public');
  const webPublicRoot = () => process.env.CC_WEB_PUBLIC || WEB_PUBLIC_DEFAULT;
  const webIndexHtml = () => {
    try { return fs.readFileSync(path.join(webPublicRoot(), 'index.html')); } catch { return null; }
  };
  const PAGE_PATHS = new Set([
    '/', '/dashboard', '/dashboard.html', '/diagnostics', '/diagnostics.html', '/decisions', '/decisions.html',
  ]);
  function webHostInstance() {
    if (!webIndexHtml()) return null;
    return createStaticHost({ root: webPublicRoot(), aliases: { '/': 'index.html' }, spa: 'index.html' });
  }

  // ── plumbing ──
  function readJson(req) {
    return new Promise((resolve) => {
      let raw = '';
      // 必须显式 utf8：不设编码时 data 是 Buffer，逐块 `raw += Buffer` 会对**每个 chunk 单独** toString
      // —— 多字节字符跨 chunk 边界即被切成 U+FFFD（state 请求体几百 KB 中文必中）。
      req.setEncoding('utf8');
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        if (!raw) return resolve({});
        try { resolve(JSON.parse(raw)); } catch { resolve(null); }
      });
    });
  }

  function send(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  /** 自动介入只允许在 CLI pause 闩锁已生效后执行 */
  function requirePaused(rt, res) {
    const s = rt.ctx.stores.state.readSync();
    if (s?.mode === 'pause') return true;
    send(res, 409, { ok: false, error: `intervention requires mode=pause (current: ${s?.mode || 'unknown'})` });
    return false;
  }

  const PROJECT_AGNOSTIC_WRITES = new Set(['/shutdown']);
  function writeNeedsProject(method, pathname) {
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
    return !PROJECT_AGNOSTIC_WRITES.has(pathname);
  }

  /** tmux 缺席时的统一响应 */
  function noSession(res, rt) {
    return send(res, 503, { ok: false, error: `tmux session '${rt.ctx.tmux.SESSION}' not found; run bootstrap.sh` });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    touch();
    return handleInner(req, res, url);
  }

  /** 供 bootstrap 注入「活动刷新」（空闲回收计时） */
  let touch = () => {};
  function setTouch(fn) { touch = fn; }

  async function handleInner(req, res, url) {
    const pathname = url.pathname;

    // 写类端点缺 ?p → 400，绝不兜底到 boot
    if (writeNeedsProject(req.method, pathname) && !url.searchParams.get('p')) {
      console.warn(`[hook] 拒绝写请求 ${req.method} ${pathname}：缺 ?p（来源 ${req.socket?.remoteAddress || '?'}）。`
        + '若这是 /hook，说明 hook 网关没拿到 CC_PROJECT（bootstrap 注入缺失）');
      return send(res, 400, {
        ok: false,
        error: `写类端点缺 ?p：拒绝兜底到 boot 项目（${registry.bootRoot}）。请显式带 ?p=<projectRoot>；`
          + 'hook 网关 / CLI / MCP 会自动带上。',
        endpoint: pathname,
      });
    }

    // /shutdown 不读任何项目 state，先处理
    if (req.method === 'POST' && pathname === '/shutdown') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, shutting: true }));
      setTimeout(() => { stopServer().then(() => { if (require.main === module) process.exit(0); }); }, 60);
      return;
    }

    const rt = registry.resolveRuntime({ p: url.searchParams.get('p') });
    const { ctx, session } = rt;

    // ── 前端页面：只由 web 构建产物承载；缺产物明确告警 ──
    if (req.method === 'GET' && PAGE_PATHS.has(pathname)) {
      const idx = webIndexHtml();
      if (idx) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(idx);
      }
      const expected = path.join(webPublicRoot(), 'index.html');
      console.warn(`[web] 前端产物缺失：${expected} —— 请运行 npm run build（会构建 web/ → server/public）`);
      return send(res, 503, { ok: false, error: '前端产物缺失：请运行 npm run build', expected });
    }

    // ── hook callback ──
    if (req.method === 'POST' && pathname === '/hook') {
      return handleHook(req, res, url, rt);
    }

    // ── state / metrics / diagnostics / planning / decisions 读 ──
    if (req.method === 'GET' && pathname === '/awf/state') {
      const sid = url.searchParams.get('sid');
      const s = sid ? ctx.storeCore.readJsonSync(ctx.runStateFile(sid)) : ctx.stores.state.readSync();
      if (s == null) return send(res, 404, { ok: false, error: `state.json not found${sid ? ` for run ${sid}` : ''}` });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(s, null, 2));
    }
    if (req.method === 'GET' && pathname === '/awf/metrics') {
      return send(res, 200, { ok: true, metrics: rt.observability.metricsSnapshot() });
    }
    if (req.method === 'GET' && pathname === '/awf/diagnostics') {
      return send(res, 200, { ok: true, diagnosis: readDiagnosis(ctx.projectRoot) });
    }
    if (req.method === 'GET' && pathname === '/awf/dynamic-planning/proposals') {
      const proposalId = url.searchParams.get('proposalId');
      const service = rt.dynamicPlanning();
      if (proposalId) {
        const proposal = service.get(proposalId);
        return proposal
          ? send(res, 200, { ok: true, proposal })
          : send(res, 404, { ok: false, error: `dynamic planning proposal not found: ${proposalId}` });
      }
      return send(res, 200, { ok: true, proposals: service.list() });
    }
    if (req.method === 'POST' && pathname === '/awf/diagnostics') {
      const result = await rt.observability.startDiagnosis();
      return send(res, result.ok ? 202 : 409, result);
    }
    if (req.method === 'GET' && pathname === '/awf/decisions') {
      const decisions = ctx.newDecisionStore().listAll();
      return send(res, 200, { ok: true, total: decisions.length, decisions });
    }
    const decisionResolve = pathname.match(/^\/awf\/decisions\/([^/]+)\/resolve$/);
    if (req.method === 'POST' && decisionResolve) {
      const decisionId = decodeURIComponent(decisionResolve[1]);
      const body = (await readJson(req)) || {};
      try {
        return send(res, 200, { ok: true, ...rt.dynamicPlanning().resolveDecision(decisionId, body) });
      } catch (error) {
        return send(res, 409, { ok: false, error: error.message });
      }
    }
    if (req.method === 'POST' && pathname.startsWith('/awf/decisions/') && pathname.endsWith('/override')) {
      return handleOverride(req, res, pathname, rt);
    }

    // ── status ──
    if (req.method === 'GET' && pathname === '/status') {
      const statusSid = url.searchParams.get('sid');
      if (statusSid) {
        const s = rt.sessionFor(statusSid);
        return send(res, 200, {
          ok: true, sid: statusSid, state: s?.state ?? 'ready',
          decisionPending: s?.decisionPending ?? null, projectRoot: ctx.projectRoot,
        });
      }
      const out = {
        ok: true, state: session.state, session: ctx.tmux.hasSession(), projectRoot: ctx.projectRoot,
        decisionPending: session.decisionPending, contextReady: session.contextReady,
        decisionGate: session.decisionGate, decisionResume: session.decisionResume,
        mainSessionId: session.mainSessionId, sessionSeq: session.sessionSeq,
        activeAgents: rt.observability.activeAgentCount(),
      };
      if (!url.searchParams.get('p')) out.projects = registry.list();
      if (url.searchParams.get('snapshot')) {
        try { out.snapshot = ctx.tmux.capture(); } catch { out.snapshot = null; }
      }
      return send(res, 200, out);
    }

    // ── 上下文快照就绪标记 ──
    if (req.method === 'POST' && pathname === '/context-ready') {
      session.setContextReady();
      console.log('[context-ready] 快照就绪，待 CLI /clear');
      return send(res, 200, { ok: true, contextReady: session.contextReady });
    }
    if (req.method === 'GET' && pathname === '/context-ready') {
      return send(res, 200, { ok: true, ready: session.consumeContextReady() });
    }

    // ── AI 通知：需要人做选择 / 自由输入 ──
    if (req.method === 'POST' && pathname === '/choice') {
      const body = await readJson(req);
      const v = interact.validateDecisionRequest('choice', body);
      if (!v.ok) return send(res, 400, { ok: false, error: v.error });
      session.setDecision(v.decision);
      console.log(`[choice] ${v.decision.question}`);
      return send(res, 200, { ok: true, decisionPending: session.decisionPending });
    }
    if (req.method === 'POST' && pathname === '/ask') {
      const body = await readJson(req);
      const v = interact.validateDecisionRequest('text', body);
      if (!v.ok) return send(res, 400, { ok: false, error: v.error });
      session.setDecision(v.decision);
      console.log(`[ask] ${v.decision.question}`);
      return send(res, 200, { ok: true, decisionPending: session.decisionPending });
    }

    // ── 会话注入：/send /cmd /intervene /stop /respond ──
    if (req.method === 'POST' && pathname === '/send') {
      const body = await readJson(req);
      if (!body || typeof body.text !== 'string' || body.text.length === 0) {
        return send(res, 400, { ok: false, error: 'body must be {text: non-empty string}' });
      }
      if (!ctx.tmux.hasSession()) return noSession(res, rt);
      const ok = await session.waitReady(READY_TIMEOUT_MS);
      if (!ok) return send(res, 409, { ok: false, error: 'still busy (ready timeout)' });
      ctx.logger.captureFromTranscript();
      session.setBusy();
      ctx.logger.logPrompt(body.text);
      await submitRaw(rt, body.text);
      return send(res, 200, { ok: true, sent: body.text });
    }
    if (req.method === 'POST' && pathname === '/cmd') {
      const body = await readJson(req);
      if (!body || typeof body.cmd !== 'string' || body.cmd.length === 0) {
        return send(res, 400, { ok: false, error: 'body must be {cmd: non-empty string}' });
      }
      if (!ctx.tmux.hasSession()) return noSession(res, rt);
      const ok = await rt.channel.sendLocalCmd(body.cmd);
      if (!ok) return send(res, 409, { ok: false, error: 'still busy (ready timeout)' });
      return send(res, 200, { ok: true, sent: body.cmd });
    }
    if (req.method === 'POST' && pathname === '/intervene') {
      const body = await readJson(req);
      if (!body || typeof body.text !== 'string' || body.text.length === 0) {
        return send(res, 400, { ok: false, error: 'body must be {text: non-empty string, reason?: string}' });
      }
      if (!requirePaused(rt, res)) return;
      if (!ctx.tmux.hasSession()) return noSession(res, rt);
      ctx.logger.logPrompt(`[w-monitor intervention] ${body.reason || 'unspecified'}\n${body.text}`);
      session.setBusy();
      await submitRaw(rt, body.text);
      return send(res, 200, { ok: true, sent: body.text, intervention: true });
    }
    if (req.method === 'POST' && pathname === '/intervene/interrupt') {
      const body = (await readJson(req)) || {};
      if (!requirePaused(rt, res)) return;
      if (!ctx.tmux.hasSession()) return noSession(res, rt);
      ctx.tmux.sendCtrlC();
      session.clearDecision();
      session.clearFallbackTimer();
      session.setFallbackTimer(setTimeout(() => {
        if (session.state === 'busy') session.setReady();
      }, LOCAL_CMD_FALLBACK_MS));
      return send(res, 200, { ok: true, interrupted: true, reason: body.reason || null });
    }
    if (req.method === 'POST' && pathname === '/stop') {
      if (!ctx.tmux.hasSession()) return noSession(res, rt);
      ctx.tmux.sendCtrlC();
      session.clearDecision();
      session.clearFallbackTimer();
      session.setFallbackTimer(setTimeout(() => {
        if (session.state === 'busy') session.setReady();
      }, LOCAL_CMD_FALLBACK_MS));
      return send(res, 200, { ok: true, stopped: true });
    }
    if (req.method === 'POST' && pathname === '/respond') {
      const body = await readJson(req);
      if (!body || typeof body.value !== 'string' || body.value.length === 0) {
        session.clearDecision();
        return send(res, 400, { ok: false, error: 'body must be {value: non-empty string}' });
      }
      if (!ctx.tmux.hasSession()) {
        session.clearDecision();
        return noSession(res, rt);
      }
      if (!session.decisionPending) {
        const ok = await session.waitReady(READY_TIMEOUT_MS);
        if (!ok) return send(res, 409, { ok: false, error: 'still busy (ready timeout)' });
      }
      const hadDecision = !!session.decisionPending;
      const question = session.decisionPending ? session.decisionPending.question : null;
      session.setBusy();
      if (hadDecision) ctx.logger.logChoice(question, body.value);
      session.clearDecision();
      await submitRaw(rt, body.value);
      const fallbackMs = hadDecision ? DECISION_FALLBACK_MS : LOCAL_CMD_FALLBACK_MS;
      session.clearFallbackTimer();
      session.setFallbackTimer(setTimeout(() => {
        if (session.state === 'busy') session.setReady();
      }, fallbackMs));
      return send(res, 200, { ok: true, sent: body.value });
    }

    // ── run host ──
    if (req.method === 'POST' && pathname === '/run/submit') {
      const body = (await readJson(req)) || {};
      await rt.ensureRunHost();
      if (!rt.runHost) return send(res, 503, { ok: false, error: `run host 未就绪: ${rt.runHostBootErr?.message || 'unknown'}` });
      const runId = typeof body.runId === 'string' && body.runId.length > 0 ? body.runId : undefined;
      const mode = body.mode === 'single' || body.mode === 'batch' ? body.mode : undefined;
      const r = rt.runHost.submitRun({ runId, mode });
      if (!r.ok) return send(res, 409, { ok: false, error: r.error, runId: r.runId });
      return send(res, 202, { ok: true, runId: r.runId, mode: r.mode });
    }
    if (req.method === 'GET' && pathname === '/run/status') {
      await rt.ensureRunHost();
      if (!rt.runHost) return send(res, 503, { ok: false, error: `run host 未就绪: ${rt.runHostBootErr?.message || 'unknown'}` });
      return send(res, 200, rt.runHost.snapshot(url.searchParams.get('runId') || undefined));
    }
    if (req.method === 'GET' && pathname === '/run/events') {
      await rt.ensureRunHost();
      if (!rt.runHost) return send(res, 503, { ok: false, error: `run host 未就绪: ${rt.runHostBootErr?.message || 'unknown'}` });
      const afterSeq = Number(url.searchParams.get('afterSeq'));
      return send(res, 200, rt.runHost.pollEvents({
        afterSeq: Number.isInteger(afterSeq) && afterSeq >= 0 ? afterSeq : 0,
        runId: url.searchParams.get('runId') || undefined,
        limit: Number(url.searchParams.get('limit')) || undefined,
      }));
    }

    // ── 动态规划写端 ──
    if (req.method === 'POST' && pathname === '/run/dynamic-planning/proposals') {
      const body = (await readJson(req)) || {};
      try {
        const proposal = rt.dynamicPlanning().propose(body);
        const applied = proposal.status === 'applied_review_pending';
        return send(res, applied ? 200 : 202, { ok: true, applied, proposal });
      } catch (e) {
        return send(res, 409, { ok: false, error: e.message });
      }
    }
    const dynamicAction = pathname.match(/^\/run\/dynamic-planning\/proposals\/([^/]+)\/(approve|reject)$/);
    if (req.method === 'POST' && dynamicAction) {
      const proposalId = decodeURIComponent(dynamicAction[1]);
      const body = (await readJson(req)) || {};
      try {
        const service = rt.dynamicPlanning();
        const proposal = dynamicAction[2] === 'approve'
          ? service.approve(proposalId, body)
          : service.reject(proposalId, body);
        return send(res, 200, { ok: true, proposal });
      } catch (e) {
        return send(res, 409, { ok: false, error: e.message });
      }
    }

    // ── state 写端点 ──
    if (req.method === 'POST' && pathname === '/run/state/mode') {
      const body = (await readJson(req)) || {};
      if (!body || typeof body.mode !== 'string' || !['run', 'idle', 'pause'].includes(body.mode)) {
        return send(res, 400, { ok: false, error: 'body must be {mode: run|idle|pause}' });
      }
      await rt.ensureRunStateApi();
      if (!rt.runStateApi) return send(res, 503, { ok: false, error: 'state api 未就绪' });
      return send(res, 200, { ok: !!rt.runStateApi.setWorkflowMode(ctx.projectRoot, body.mode), mode: body.mode });
    }
    if (req.method === 'POST' && pathname === '/run/state/task/active') {
      const body = (await readJson(req)) || {};
      if (!body || typeof body.taskId !== 'string' || body.taskId.length === 0) {
        return send(res, 400, { ok: false, error: 'body must be {taskId: non-empty string}' });
      }
      await rt.ensureRunStateApi();
      if (!rt.runStateApi) return send(res, 503, { ok: false, error: 'state api 未就绪' });
      return send(res, 200, { ok: !!rt.runStateApi.markTaskActive(ctx.projectRoot, body.taskId), taskId: body.taskId });
    }
    if (req.method === 'POST' && pathname === '/run/state/gate') {
      const body = (await readJson(req)) || {};
      if (!body || typeof body.taskId !== 'string' || body.taskId.length === 0) {
        return send(res, 400, { ok: false, error: 'body must be {taskId: non-empty string}' });
      }
      const s = ctx.stores.state.readSync();
      const task = s?.tasks?.find((x) => x.id === body.taskId) || null;
      if (!task) return send(res, 200, { ok: true, applied: false, reason: 'task not found' });
      const gf = await import('../run/gate-fix.js');
      await gf.handleGateCompletion(ctx.projectRoot, body.taskId, task);
      return send(res, 200, { ok: true, applied: true, taskId: body.taskId });
    }
    if (req.method === 'POST' && pathname === '/run/state/backup') {
      await rt.ensureRunStateApi();
      if (!rt.runStateApi) return send(res, 503, { ok: false, error: 'state api 未就绪' });
      rt.runStateApi.backupState(ctx.projectRoot);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/run/state/apply') {
      return handleStateApply(req, res, url, rt);
    }

    // ── oneshot ──
    if (req.method === 'POST' && pathname === '/oneshot') {
      const body = (await readJson(req)) || {};
      if (!body || typeof body.prompt !== 'string' || body.prompt.length === 0) {
        return send(res, 400, { ok: false, error: 'body must be {prompt: non-empty string}' });
      }
      const r = await oneshotPort
        .runOneShot({ prompt: body.prompt, cwd: typeof body.cwd === 'string' ? body.cwd : undefined, timeoutMs: 300000 })
        .catch((e) => ({ ok: false, error: e.message }));
      return send(res, 200, r);
    }

    // ── 静态托管 ──
    if (req.method === 'GET') {
      const host = webHostInstance();
      if (host && host.serve(req, res, pathname)) return;
    }

    return send(res, 404, { ok: false, error: 'not found' });
  }

  /** 直接注入文本（不等待收尾）—— /send 与 /intervene 用 */
  async function submitRaw(rt, text) {
    rt.ctx.tmux.sendText(text);
    await new Promise((r) => setTimeout(r, ENTER_DELAY_MS));
    rt.ctx.tmux.sendEnter();
  }

  /** POST /awf/decisions/:id/override */
  async function handleOverride(req, res, pathname, rt) {
    const decisionId = decodeURIComponent(pathname.slice('/awf/decisions/'.length, -'/override'.length));
    const body = (await readJson(req)) || {};
    const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
    if (!instruction) return send(res, 400, { ok: false, error: 'override 需要非空 instruction' });
    try {
      const store = rt.ctx.newDecisionStore();
      const r = store.override(decisionId, {
        instruction,
        original_answer: typeof body.original_answer === 'string' ? body.original_answer : null,
      });
      rt.ctx.logger.logDecision({
        at: new Date().toISOString(),
        decisionId,
        event: 'decision_overridden',
        detail: `instruction=${instruction.slice(0, 40)}`,
      });
      const task = appendDecisionReviewTask(rt.ctx.stores, {
        decision_id: decisionId,
        instruction,
        original_answer: typeof body.original_answer === 'string' ? body.original_answer : null,
      });
      if (!task.ok) {
        return send(res, 500, { ok: false, error: `override 已记录但纠偏任务追加失败：${task.error}`, decision_id: decisionId });
      }
      return send(res, 200, { ok: true, decision_id: decisionId, runStamp: r.runStamp, reviewTaskId: task.taskId });
    } catch (e) {
      return send(res, 404, { ok: false, error: e.message });
    }
  }

  /** POST /run/state/apply（含 CAS） */
  async function handleStateApply(req, res, url, rt) {
    const body = (await readJson(req)) || {};
    const state = body?.state;
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return send(res, 400, { ok: false, error: 'body must be {state: object}' });
    }
    await rt.ensureRunStateApi();
    const sid = url.searchParams.get('sid');
    const ctx = rt.ctx;
    try {
      if (sid) {
        ctx.writeRunStateSid(sid, state);
      } else {
        if (!rt.runStateApi) return send(res, 503, { ok: false, error: 'state api 未就绪' });
        if (Object.prototype.hasOwnProperty.call(body, 'expectedLastUpdated')) {
          if (!rt.runStateApi.replaceStateIfUnchanged) {
            return send(res, 503, { ok: false, error: 'state CAS api 未就绪' });
          }
          if (typeof body.expectedStateFingerprint !== 'string' || !body.expectedStateFingerprint) {
            return send(res, 400, { ok: false, error: 'CAS apply requires expectedStateFingerprint' });
          }
          const applied = rt.runStateApi.replaceStateIfUnchanged(
            ctx.projectRoot, state, body.expectedLastUpdated, body.expectedStateFingerprint,
          );
          if (applied?.conflict) {
            return send(res, 409, { ...applied, error: 'state 已被其他写者更新，请重新读取后重试' });
          }
          return send(res, 200, applied);
        }
        rt.runStateApi.saveState(ctx.projectRoot, state);
      }
      return send(res, 200, { ok: true });
    } catch (e) {
      return send(res, 500, { ok: false, error: `state 落盘失败: ${e.message}` });
    }
  }

  /** POST /hook —— CCS hooks 回调总入口 */
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
        if (event === 'SessionStart') slot.setReady();
        else if (event === 'UserPromptSubmit') slot.setBusy();
        else if (event === 'Stop') { if (!ctx.decisionEnabled()) slot.clearDecision(); slot.setReady(); }
        else if (event === 'PreToolUse' && body?.tool_name === 'AskUserQuestion') {
          const q = Array.isArray(body?.tool_input?.questions) ? body.tool_input.questions[0] : null;
          if (q && !ctx.decisionEnabled()) {
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
      if (rt.observability.diagnosisInFlight && body.session_id && body.session_id !== session.mainSessionId) {
        console.log(`[diagnosis] ignored isolated SessionStart ${body.session_id}`);
        return send(res, 200, { ok: true, event, state: session.state });
      }
      if (body.session_id && body.session_id !== session.mainSessionId) {
        rt.subagent.reset();
        resetRunMeta(ctx.projectRoot);
        rt.observability.metricsCache = { at: 0, value: null };
      }
      if (body.session_id) session.mainSessionId = body.session_id;
      session.bumpSessionSeq();
      hookUpdateMeta(ctx, session, body);
      session.setReady();
      ctx.logger.resetTranscript();
    } else if (event === 'UserPromptSubmit') {
      if (isMainSession(session, body)) session.setBusy();
    } else if (event === 'Stop') {
      if (isMainSession(session, body)) {
        const out = rt.decision.onStop(body);
        if (out) hookCcOutput = out.ccOutput;
      }
    } else if (event === 'SubagentStart') {
      rt.subagent.logEvent(event, body);
      if (session.mainSessionId && body.session_id && body.session_id !== session.mainSessionId) {
        console.log(`[subagent-start] skip external session ${body.session_id}`);
      } else {
        const key = body.agent_id || body.session_id || 'unknown';
        rt.observability.trackAgent(key, { sessionId: body.session_id || null, status: 'running', startedAt: Date.now() });
        hookUpdateSubagentMeta(ctx, key, body, 'running');
      }
    } else if (event === 'SubagentStop') {
      handleSubagentStop(rt, body);
    }

    if (event === 'PreToolUse' && body.tool_name === 'AskUserQuestion') {
      const out = rt.decision.onAskUserQuestion(body);
      if (out) hookCcOutput = out.ccOutput;
    }
    if (event === 'PostToolUse' && body.tool_name === 'AskUserQuestion') {
      const prev = session.decisionPending;
      const resp = body.tool_response;
      console.log(`[hook] AskUserQuestion answered, raw: ${JSON.stringify(resp).slice(0, 300)}`);
      if (prev && prev.source === 'AskUserQuestion') {
        let answer = '';
        if (typeof resp === 'string') answer = resp;
        else if (resp?.answers && typeof resp.answers === 'object') answer = Object.values(resp.answers).join(', ');
        else if (resp?.answer) answer = String(resp.answer);
        else answer = JSON.stringify(resp);
        session.setDecision({ ...prev, answer, answered: true });
      }
    }

    console.log(`[hook] ${event} -> ${session.state}`);
    const hookResp = { ok: true, event: event || null, state: session.state };
    if (hookCcOutput) hookResp.ccOutput = hookCcOutput;
    return send(res, 200, hookResp);
  }

  function isMainSession(session, body) {
    return !session.mainSessionId || !body?.session_id || body.session_id === session.mainSessionId;
  }

  function hookUpdateMeta(ctx, session, body) {
    updateRunMeta(ctx.projectRoot, (meta) => ({
      ...meta,
      projectRoot: ctx.projectRoot,
      startedAt: meta.startedAt || new Date().toISOString(),
      endedAt: null,
      mainSessionId: body.session_id || meta.mainSessionId || null,
      updatedAt: new Date().toISOString(),
    }));
  }

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
          startedAt: ((meta.subagents || {})[key] || {}).startedAt || new Date().toISOString(),
          stoppedAt: status === 'stopped' ? new Date().toISOString() : null,
          transcriptPath: body.agent_transcript_path || ((meta.subagents || {})[key] || {}).transcriptPath || null,
        },
      },
      updatedAt: new Date().toISOString(),
    }));
  }

  function handleSubagentStop(rt, body) {
    const { ctx } = rt;
    const key = body.agent_id || body.session_id || 'unknown';
    rt.subagent.logEvent('SubagentStop', body);
    if (ctx.mainSessionId && body.session_id && body.session_id !== ctx.mainSessionId) return;
    const agent = rt.observability.agents.get(key);
    if (agent) agent.status = 'stopped';
    hookUpdateSubagentMeta(ctx, key, body, 'stopped');
    if (!agent) {
      console.log(`[subagent-stop] skip untracked agent ${key} (no SubagentStart)`);
      return;
    }
    const needs = rt.subagent.parseNeedsInput(body);
    const result = needs ? null : rt.subagent.parseResult(body);
    ctx.logger.captureSubagentTranscript(body, needs?.taskId || result?.taskId, key);
    if (needs) {
      rt.subagent.logNeedsInput(body, needs);
      console.log(`[subagent-needs] ${needs.taskId}: ${needs.question.slice(0, 40)}`);
    } else {
      const settled = rt.subagent.settle(body);
      if (!settled.ok) {
        console.log(`[subagent-settle] ${settled.reason} (agent ${key})`);
        if (settled.recoverable !== false) rt.subagent.logFailure(body, settled);
      } else {
        console.log(`[subagent-settle] ${settled.taskId} -> ${settled.status}`);
      }
    }
  }

  /** WebSocket 升级：/run/events 实时事件推送 */
  function handleUpgrade(req, socket) {
    let pathname = '/';
    try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch { /* 保持默认 */ }
    if (pathname !== '/run/events') {
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }
    const rt = (() => {
      try { return registry.resolveRuntime({ p: new URL(req.url, 'http://localhost').searchParams.get('p') }); } catch { return registry.runtimeFor(registry.bootRoot); }
    })();
    rt.ensureRunHost()
      .then(() => {
        if (!rt.runHost) { try { socket.destroy(); } catch { /* ignore */ } return; }
        const unsub = rt.runHost.subscribe((event) => {
          try {
            if (socket.writable) socket.write(encodeTextFrame(JSON.stringify(event)));
          } catch { /* ignore */ }
        });
        wsUpgrade(req, socket, { onClose: unsub, onError: unsub });
      })
      .catch(() => { try { socket.destroy(); } catch { /* ignore */ } });
  }

  return { handle, handleUpgrade, setTouch, webPublicRoot };
}

module.exports = { createApi };
