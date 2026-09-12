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
 *
 * 请求 → 项目 runtime 的寻址：路径里的 `?p=<projectRoot>` 经 registry.resolveRuntime 解析；
 * 缺省落 boot（只对读类成立，见上）。**同一个 server 进程服务多项目**，靠的就是这一条。
 *
 * 路由分组（按 handleInner 里的出现顺序）：
 *   [基础设施]  /shutdown · 前端页面 · 静态托管（GET 兜底）
 *   [hook]      /hook（含 ?sid 早路）
 *   [读]        /awf/state · /awf/metrics · /awf/diagnostics · /awf/dynamic-planning/proposals · /awf/decisions
 *   [决策写]    /awf/decisions/:id/resolve · /awf/decisions/:id/override
 *   [会话状态]  /status · /context-ready
 *   [决策入口]  /choice · /ask
 *   [会话注入]  /send · /cmd · /intervene · /intervene/interrupt · /stop · /respond
 *   [run host]  /run/submit · /run/status · /run/events（+ WebSocket 升级）
 *   [动态规划]  /run/dynamic-planning/proposals(/approve|/reject)
 *   [state 写]  /run/state/mode · task/active · gate · backup · apply
 *   [oneshot]   /oneshot
 *
 * 约定：所有响应都是 JSON（除前端页面与静态资源）；错误统一形如 `{ ok:false, error }`。
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
 * 建 api：把 registry 与 stopServer 作为依赖注入，返回 handler 集合。
 * 闭包内不持有任何项目运行态 —— 一切按请求现取 runtime（`registry.resolveRuntime`），
 * 这是「一个 api 实例服务多项目」的前提。
 * @param {object} deps
 * @param {object} deps.registry         项目注册表（resolveRuntime / list / all / bootRoot）
 * @param {Function} deps.stopServer     优雅关闭（/shutdown 用）
 */
function createApi({ registry, stopServer }) {
  // ── 静态托管 ──
  // web 构建产物目录（默认 server/public，可经 CC_WEB_PUBLIC 覆盖）。webIndexHtml() 每次实时读盘，
  // 故产物更新无需重启；缺产物时前端页面路由会明确告警并回 503，而不是给白屏。
  const WEB_PUBLIC_DEFAULT = path.join(__dirname, '..', 'public');
  const webPublicRoot = () => process.env.CC_WEB_PUBLIC || WEB_PUBLIC_DEFAULT;
  const webIndexHtml = () => {
    try { return fs.readFileSync(path.join(webPublicRoot(), 'index.html')); } catch { return null; }
  };
  // 前端「页面」路径集合：这些都是 SPA 的一个入口，统一回 index.html（由前端路由接管）
  const PAGE_PATHS = new Set([
    '/', '/dashboard', '/dashboard.html', '/diagnostics', '/diagnostics.html', '/decisions', '/decisions.html',
  ]);
  /** 惰性构造静态托管实例（产物缺失则返回 null，由调用方回 503） */
  function webHostInstance() {
    if (!webIndexHtml()) return null;
    return createStaticHost({ root: webPublicRoot(), aliases: { '/': 'index.html' }, spa: 'index.html' });
  }

  // ── plumbing ──
  /**
   * 读并解析请求体 JSON。
   * 解析失败（非法 JSON）→ resolve(null)，由调用方判空；空体 → {}。
   */
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

  /** 统一 JSON 响应出口（写状态码 + content-type + JSON body） */
  function send(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  /**
   * 自动介入只允许在 CLI pause 闩锁已生效后执行。
   * 返回 true = 放行；false = 已回 409，调用方必须 return（不继续）。
   * 语义：介入（intervene/interrupt）是对运行时的人工干预，必须先暂停编排，否则会与在跑的任务打架。
   */
  function requirePaused(rt, res) {
    const s = rt.ctx.stores.state.readSync();
    if (s?.mode === 'pause') return true;
    send(res, 409, { ok: false, error: `intervention requires mode=pause (current: ${s?.mode || 'unknown'})` });
    return false;
  }

  // 不依赖任何项目 state 的写端点（唯一例外）；其余写类都要求显式 ?p
  const PROJECT_AGNOSTIC_WRITES = new Set(['/shutdown']);
  /** 判断该请求是否为「需要项目上下文的写」——是则缺 ?p 必须 400（读/HEAD/OPTIONS 不受限） */
  function writeNeedsProject(method, pathname) {
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
    return !PROJECT_AGNOSTIC_WRITES.has(pathname);
  }

  /** tmux 缺席时的统一响应（503 —— 服务在但外部依赖不在，不是 404/500） */
  function noSession(res, rt) {
    return send(res, 503, { ok: false, error: `tmux session '${rt.ctx.tmux.SESSION}' not found; run bootstrap.sh` });
  }

  /** 顶层 handler：解析 URL + 触发活动刷新，再进 handleInner */
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    touch(); // 每个请求都算「有活动」，供空闲回收计时
    return handleInner(req, res, url);
  }

  /** 供 bootstrap 注入「活动刷新」（空闲回收计时） */
  let touch = () => {};
  function setTouch(fn) { touch = fn; }

  async function handleInner(req, res, url) {
    const pathname = url.pathname;

    // 写类端点缺 ?p → 400，绝不兜底到 boot
    // （事故根因：无 ?p 时被兜底到 boot 项目，手工 curl 的写落进了在跑的 run）
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

    // /shutdown 不读任何项目 state，先处理（它也是唯一豁免 ?p 的写端点）
    if (req.method === 'POST' && pathname === '/shutdown') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, shutting: true })); // 先回响应再关，避免客户端等超时
      setTimeout(() => { stopServer().then(() => { if (require.main === module) process.exit(0); }); }, 60);
      return;
    }

    // 到这里才解析项目 runtime：后续所有路由都在某个项目的 runtime 上操作
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

    // ── hook callback（CC hooks 回调总入口，见 handleHook）──
    if (req.method === 'POST' && pathname === '/hook') {
      return handleHook(req, res, url, rt);
    }

    // ── state / metrics / diagnostics / planning / decisions 读 ──
    // GET /awf/state：可选 ?sid 读分片 state（.awf/runs/<sid>/state.json），无 sid 读项目主 state
    if (req.method === 'GET' && pathname === '/awf/state') {
      const sid = url.searchParams.get('sid');
      const s = sid ? ctx.storeCore.readJsonSync(ctx.runStateFile(sid)) : ctx.stores.state.readSync();
      if (s == null) return send(res, 404, { ok: false, error: `state.json not found${sid ? ` for run ${sid}` : ''}` });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(s, null, 2)); // 格式化：这是给人与 CLI 看的调试面
    }
    if (req.method === 'GET' && pathname === '/awf/metrics') {
      return send(res, 200, { ok: true, metrics: rt.observability.metricsSnapshot() });
    }
    if (req.method === 'GET' && pathname === '/awf/diagnostics') {
      return send(res, 200, { ok: true, diagnosis: readDiagnosis(ctx.projectRoot) });
    }
    // GET /awf/dynamic-planning/proposals：给了 proposalId 取单条，否则列全部
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
    // POST /awf/diagnostics：启动一次诊断（异步），202 受理 / 409 已在诊断中
    if (req.method === 'POST' && pathname === '/awf/diagnostics') {
      const result = await rt.observability.startDiagnosis();
      return send(res, result.ok ? 202 : 409, result);
    }
    // GET /awf/decisions：列本项目全部决策记录
    if (req.method === 'GET' && pathname === '/awf/decisions') {
      const decisions = ctx.newDecisionStore().listAll();
      return send(res, 200, { ok: true, total: decisions.length, decisions });
    }
    // POST /awf/decisions/:id/resolve：人工解决一条决策（写决策存储 + 可能的续跑）
    const decisionResolve = pathname.match(/^\/awf\/decisions\/([^/]+)\/resolve$/);
    if (req.method === 'POST' && decisionResolve) {
      const decisionId = decodeURIComponent(decisionResolve[1]);
      const body = (await readJson(req)) || {};
      try {
        return send(res, 200, { ok: true, ...rt.dynamicPlanning().resolveDecision(decisionId, body) });
      } catch (error) {
        return send(res, 409, { ok: false, error: error.message }); // 业务失败 → 409，不是 500
      }
    }
    // POST /awf/decisions/:id/override：用人工指令覆盖 AI 决策（见 handleOverride）
    if (req.method === 'POST' && pathname.startsWith('/awf/decisions/') && pathname.endsWith('/override')) {
      return handleOverride(req, res, pathname, rt);
    }

    // ── status ──
    // GET /status：无 sid → 项目级会话态（CLI 的 server 发现入口，也是读类 boot 兜底的典型）；
    //              带 sid → 该 sid 槽的内存态（多 run 观测）
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
      if (!url.searchParams.get('p')) out.projects = registry.list();     // 无 ?p 视为「概览请求」，附带项目清单
      if (url.searchParams.get('snapshot')) {
        try { out.snapshot = ctx.tmux.capture(); } catch { out.snapshot = null; } // 可选抓屏（默认不抓，有开销）
      }
      return send(res, 200, out);
    }

    // ── 上下文快照就绪标记 ──
    // POST 置位（AI 写完 handoff 快照后通知）；GET 一次性消费（CLI /clear 后取走标记）
    if (req.method === 'POST' && pathname === '/context-ready') {
      session.setContextReady();
      console.log('[context-ready] 快照就绪，待 CLI /clear');
      return send(res, 200, { ok: true, contextReady: session.contextReady });
    }
    if (req.method === 'GET' && pathname === '/context-ready') {
      return send(res, 200, { ok: true, ready: session.consumeContextReady() });
    }

    // ── AI 通知：需要人做选择 / 自由输入 ──
    // 校验决策模型 → 置会话的 decisionPending（等待人经 /respond 回应）
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
    // /send：等就绪 → 标 busy → 抓 transcript 基线 → 记日志 → 注文本。这是最常用的「给 CC 一句话」入口。
    if (req.method === 'POST' && pathname === '/send') {
      const body = await readJson(req);
      if (!body || typeof body.text !== 'string' || body.text.length === 0) {
        return send(res, 400, { ok: false, error: 'body must be {text: non-empty string}' });
      }
      if (!ctx.tmux.hasSession()) return noSession(res, rt);
      const ok = await session.waitReady(READY_TIMEOUT_MS);
      if (!ok) return send(res, 409, { ok: false, error: 'still busy (ready timeout)' }); // 忙 → 409，不排队
      ctx.logger.captureFromTranscript();
      session.setBusy();
      ctx.logger.logPrompt(body.text);
      await submitRaw(rt, body.text);
      return send(res, 200, { ok: true, sent: body.text });
    }
    // /cmd：注入本地 slash 命令（如 /clear）；走 channel.sendLocalCmd（内含无 Stop hook 的兜底）
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
    // /intervene：w-monitor 的温和介入（仅在 pause 生效后）；记 reason + 注入修复提示
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
    // /intervene/interrupt：升级介入 —— 直接 Ctrl-C 打断当前响应，并起兜底定时器防卡 busy
    if (req.method === 'POST' && pathname === '/intervene/interrupt') {
      const body = (await readJson(req)) || {};
      if (!requirePaused(rt, res)) return;
      if (!ctx.tmux.hasSession()) return noSession(res, rt);
      ctx.tmux.sendCtrlC();
      session.clearDecision();
      session.clearFallbackTimer();
      session.setFallbackTimer(setTimeout(() => {
        if (session.state === 'busy') session.setReady(); // Ctrl-C 后可能没有 Stop hook，兜底放回 ready
      }, LOCAL_CMD_FALLBACK_MS));
      return send(res, 200, { ok: true, interrupted: true, reason: body.reason || null });
    }
    // /stop：直接打断（不要求 pause —— 停是安全操作）；同样起兜底
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
    // /respond：回应一个 pending 决策（注入人给的答案）。
    // 决策应答与普通发送共用「busy + 兜底」骨架，差别在兜底时长（人思考久 → DECISION_FALLBACK_MS）。
    if (req.method === 'POST' && pathname === '/respond') {
      const body = await readJson(req);
      if (!body || typeof body.value !== 'string' || body.value.length === 0) {
        session.clearDecision(); // 非法体也要清 pending，避免会话卡在等应答
        return send(res, 400, { ok: false, error: 'body must be {value: non-empty string}' });
      }
      if (!ctx.tmux.hasSession()) {
        session.clearDecision();
        return noSession(res, rt);
      }
      // 无 pending 决策时按普通发送处理：先等就绪（有 pending 则视为已在等，不额外等）
      if (!session.decisionPending) {
        const ok = await session.waitReady(READY_TIMEOUT_MS);
        if (!ok) return send(res, 409, { ok: false, error: 'still busy (ready timeout)' });
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
      return send(res, 200, { ok: true, sent: body.value });
    }

    // ── run host ──
    // /run/submit：CLI 提交一次 run（确保宿主已装配 → 提交 → 202）。runId/mode 非法则交给宿主兜底。
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
    // /run/status：取 run 快照（可选 ?runId 指定）
    if (req.method === 'GET' && pathname === '/run/status') {
      await rt.ensureRunHost();
      if (!rt.runHost) return send(res, 503, { ok: false, error: `run host 未就绪: ${rt.runHostBootErr?.message || 'unknown'}` });
      return send(res, 200, rt.runHost.snapshot(url.searchParams.get('runId') || undefined));
    }
    // /run/events：轮询事件（HTTP 路径）；afterSeq 必须是非负整数否则归 0（判据收紧在 run-host.pollEvents）
    if (req.method === 'GET' && pathname === '/run/events') {
      await rt.ensureRunHost();
      if (!rt.runHost) return send(res, 503, { ok: false, error: `run host 未就绪: ${rt.runHostBootErr?.message || 'unknown'}` });
      const afterSeq = Number(url.searchParams.get('afterSeq'));
      return send(res, 200, rt.runHost.pollEvents({
        afterSeq: Number.isInteger(afterSeq) && afterSeq >= 0 ? afterSeq : 0,
        runId: url.searchParams.get('runId') || undefined,
        limit: Number(url.searchParams.get('limit')) || undefined, // 合法性由 pollEvents 再判（0/NaN → undefined）
      }));
    }

    // ── 动态规划写端 ──
    // POST /run/dynamic-planning/proposals：提交一次动态任务调整（propose）
    if (req.method === 'POST' && pathname === '/run/dynamic-planning/proposals') {
      const body = (await readJson(req)) || {};
      try {
        const proposal = rt.dynamicPlanning().propose(body);
        const applied = proposal.status === 'applied_review_pending'; // 已自动应用 → 200，待人工 → 202
        return send(res, applied ? 200 : 202, { ok: true, applied, proposal });
      } catch (e) {
        return send(res, 409, { ok: false, error: e.message });
      }
    }
    // POST /run/dynamic-planning/proposals/:id/(approve|reject)：人工批准/驳回提案
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
    // /run/state/mode：设置工作流模式（run|idle|pause）—— 白名单硬校验，防误写非法模式
    if (req.method === 'POST' && pathname === '/run/state/mode') {
      const body = (await readJson(req)) || {};
      if (!body || typeof body.mode !== 'string' || !['run', 'idle', 'pause'].includes(body.mode)) {
        return send(res, 400, { ok: false, error: 'body must be {mode: run|idle|pause}' });
      }
      await rt.ensureRunStateApi();
      if (!rt.runStateApi) return send(res, 503, { ok: false, error: 'state api 未就绪' });
      return send(res, 200, { ok: !!rt.runStateApi.setWorkflowMode(ctx.projectRoot, body.mode), mode: body.mode });
    }
    // /run/state/task/active：把某任务标为 active（宿主派发时用）
    if (req.method === 'POST' && pathname === '/run/state/task/active') {
      const body = (await readJson(req)) || {};
      if (!body || typeof body.taskId !== 'string' || body.taskId.length === 0) {
        return send(res, 400, { ok: false, error: 'body must be {taskId: non-empty string}' });
      }
      await rt.ensureRunStateApi();
      if (!rt.runStateApi) return send(res, 503, { ok: false, error: 'state api 未就绪' });
      return send(res, 200, { ok: !!rt.runStateApi.markTaskActive(ctx.projectRoot, body.taskId), taskId: body.taskId });
    }
    // /run/state/gate：任务完成时触发门禁判定/自动派生修复（handleGateCompletion）。
    // 任务不存在 → 200 applied:false（幂等：重复通知不报错）
    if (req.method === 'POST' && pathname === '/run/state/gate') {
      const body = (await readJson(req)) || {};
      if (!body || typeof body.taskId !== 'string' || body.taskId.length === 0) {
        return send(res, 400, { ok: false, error: 'body must be {taskId: non-empty string}' });
      }
      const s = ctx.stores.state.readSync();
      const task = s?.tasks?.find((x) => x.id === body.taskId) || null;
      if (!task) return send(res, 200, { ok: true, applied: false, reason: 'task not found' });
      const gf = await import('../run/gate-fix.js'); // 动态 import：门禁修复较重，按需装载
      await gf.handleGateCompletion(ctx.projectRoot, body.taskId, task);
      return send(res, 200, { ok: true, applied: true, taskId: body.taskId });
    }
    // /run/state/backup：版本归档（run 收尾时调用）
    if (req.method === 'POST' && pathname === '/run/state/backup') {
      await rt.ensureRunStateApi();
      if (!rt.runStateApi) return send(res, 503, { ok: false, error: 'state api 未就绪' });
      rt.runStateApi.backupState(ctx.projectRoot);
      return send(res, 200, { ok: true });
    }
    // /run/state/apply：整份 state 落盘（含 CAS 可选路径，见 handleStateApply）
    if (req.method === 'POST' && pathname === '/run/state/apply') {
      return handleStateApply(req, res, url, rt);
    }

    // ── oneshot ──
    // /oneshot：同步跑一次 `claude -p`（无状态 LLM 调用），超时 5 分钟
    if (req.method === 'POST' && pathname === '/oneshot') {
      const body = (await readJson(req)) || {};
      if (!body || typeof body.prompt !== 'string' || body.prompt.length === 0) {
        return send(res, 400, { ok: false, error: 'body must be {prompt: non-empty string}' });
      }
      const r = await oneshotPort
        .runOneShot({ prompt: body.prompt, cwd: typeof body.cwd === 'string' ? body.cwd : undefined, timeoutMs: 300000 })
        .catch((e) => ({ ok: false, error: e.message })); // 失败也回 200 + {ok:false}，让调用方按体判
      return send(res, 200, r);
    }

    // ── 静态托管 ──（所有前面未命中的 GET 走这里；命中即返回，未命中才 404）
    if (req.method === 'GET') {
      const host = webHostInstance();
      if (host && host.serve(req, res, pathname)) return;
    }

    return send(res, 404, { ok: false, error: 'not found' });
  }

  /** 直接注入文本（不等待收尾）—— /send 与 /intervene 用 */
  async function submitRaw(rt, text) {
    rt.ctx.tmux.sendText(text);
    await new Promise((r) => setTimeout(r, ENTER_DELAY_MS)); // 文本与回车分两次发，中间留节奏
    rt.ctx.tmux.sendEnter();
  }

  /** POST /awf/decisions/:id/override —— 人工指令覆盖一条决策，并追加一个纠偏任务 */
  async function handleOverride(req, res, pathname, rt) {
    // 从路径切出 id：去掉前缀 '/awf/decisions/' 与后缀 '/override'
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
        detail: `instruction=${instruction.slice(0, 40)}`, // 日志只留前 40 字，避免超长
      });
      // 覆盖后追加一个「按新指令复核」的任务，让纠偏进入任务流（而不是只改记录）
      const task = appendDecisionReviewTask(rt.ctx.stores, {
        decision_id: decisionId,
        instruction,
        original_answer: typeof body.original_answer === 'string' ? body.original_answer : null,
      });
      if (!task.ok) {
        // 覆盖已生效但纠偏任务没建起来：如实回 500，别让调用方以为全成功
        return send(res, 500, { ok: false, error: `override 已记录但纠偏任务追加失败：${task.error}`, decision_id: decisionId });
      }
      return send(res, 200, { ok: true, decision_id: decisionId, runStamp: r.runStamp, reviewTaskId: task.taskId });
    } catch (e) {
      return send(res, 404, { ok: false, error: e.message }); // 决策不存在 → 404
    }
  }

  /**
   * POST /run/state/apply（含 CAS）。
   * 三种落盘路径：
   *   ① 带 ?sid → 写该 sid 的分片 state（writeRunStateSid，无 CAS）；
   *   ② 无 sid 且 body 带 expectedLastUpdated → CAS 写（replaceStateIfUnchanged，冲突回 409）；
   *   ③ 无 sid 且无 CAS 字段 → 直接整份覆盖（saveState）。
   */
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
        ctx.writeRunStateSid(sid, state); // ① 显式分片：不走 CAS
      } else {
        if (!rt.runStateApi) return send(res, 503, { ok: false, error: 'state api 未就绪' });
        if (Object.prototype.hasOwnProperty.call(body, 'expectedLastUpdated')) {
          // ② CAS：要求同时给指纹；指纹缺失 → 400（不能只给时间戳，判据不完整）
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
            // 别人先写了：409 让调用方重读后重试（这正是 CAS 要防的丢更新）
            return send(res, 409, { ...applied, error: 'state 已被其他写者更新，请重新读取后重试' });
          }
          return send(res, 200, applied);
        }
        rt.runStateApi.saveState(ctx.projectRoot, state); // ③ 无 CAS 直接覆盖
      }
      return send(res, 200, { ok: true });
    } catch (e) {
      return send(res, 500, { ok: false, error: `state 落盘失败: ${e.message}` });
    }
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

  /**
   * WebSocket 升级：/run/events 实时事件推送。
   * 非 /run/events 的升级请求直接断开（本 server 只此一个 WS 端点）。
   * 就绪后订阅 run host 事件，把每个事件编码成文本帧写出；订阅的退订函数挂在 onClose/onError 上。
   */
  function handleUpgrade(req, socket) {
    let pathname = '/';
    try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch { /* 保持默认 */ }
    if (pathname !== '/run/events') {
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }
    // 解析目标项目 runtime；解析失败则退到 boot（WS 也不该静默丢连接，退到 boot 至少有事件流）
    const rt = (() => {
      try { return registry.resolveRuntime({ p: new URL(req.url, 'http://localhost').searchParams.get('p') }); } catch { return registry.runtimeFor(registry.bootRoot); }
    })();
    rt.ensureRunHost()
      .then(() => {
        if (!rt.runHost) { try { socket.destroy(); } catch { /* ignore */ } return; } // 宿主装不起来 → 断开
        const unsub = rt.runHost.subscribe((event) => {
          try {
            if (socket.writable) socket.write(encodeTextFrame(JSON.stringify(event))); // 每个事件一行 JSON
          } catch { /* ignore */ }
        });
        wsUpgrade(req, socket, { onClose: unsub, onError: unsub }); // 连接关/错都退订，防订阅泄漏
      })
      .catch(() => { try { socket.destroy(); } catch { /* ignore */ } });
  }

  return { handle, handleUpgrade, setTouch, webPublicRoot };
}

module.exports = { createApi };
