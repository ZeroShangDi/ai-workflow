'use strict';
/**
 * api/run.cjs — run 域：run 宿主的 HTTP 面（提交 / 快照 / 事件）+ 无状态一次性执行
 *
 * 职责：把 CLI 的 run 提交、run 快照与事件轮询接到本项目惰性装配的 run host 上；
 * 并顺带承载 /oneshot（`claude -p` 一次性执行）—— 与 run host 同属「驱动一次执行」域。
 *
 * 路由（method + path）：
 *   POST /run/submit   提交一次 run（确保宿主已装配 → 提交 → 202）
 *   GET  /run/status   取 run 快照（可选 ?runId）
 *   GET  /run/events   轮询事件（HTTP 路径；WS 实时推送见 index 的 handleUpgrade）
 *   POST /oneshot      无状态 LLM 调用（`claude -p`，同步，超时 5 分钟）
 *
 * 约定：`handle(req, res, url, rt, deps)` 返回 boolean —— true=本域已处理（响应已发）；
 * false=不是本域路由，交下一个。deps 由入口注入（本域暂不使用）。
 */

const { oneshot: oneshotPort } = require('../../adapters/ports.cjs');
const { readJson, send } = require('./util.cjs');

async function handle(req, res, url, rt, deps) {
  const pathname = url.pathname;

  // ── run host ──
  // /run/submit：CLI 提交一次 run（确保宿主已装配 → 提交 → 202）。runId/mode 非法则交给宿主兜底。
  if (req.method === 'POST' && pathname === '/run/submit') {
    const body = (await readJson(req)) || {};
    await rt.ensureRunHost();
    if (!rt.runHost) { send(res, 503, { ok: false, error: `run host 未就绪: ${rt.runHostBootErr?.message || 'unknown'}` }); return true; }
    const runId = typeof body.runId === 'string' && body.runId.length > 0 ? body.runId : undefined;
    const mode = body.mode === 'single' || body.mode === 'batch' ? body.mode : undefined;
    const r = rt.runHost.submitRun({ runId, mode });
    if (!r.ok) { send(res, 409, { ok: false, error: r.error, runId: r.runId }); return true; }
    send(res, 202, { ok: true, runId: r.runId, mode: r.mode });
    return true;
  }
  // /run/status：取 run 快照（可选 ?runId 指定）
  if (req.method === 'GET' && pathname === '/run/status') {
    await rt.ensureRunHost();
    if (!rt.runHost) { send(res, 503, { ok: false, error: `run host 未就绪: ${rt.runHostBootErr?.message || 'unknown'}` }); return true; }
    send(res, 200, rt.runHost.snapshot(url.searchParams.get('runId') || undefined));
    return true;
  }
  // /run/events：轮询事件（HTTP 路径）；afterSeq 必须是非负整数否则归 0（判据收紧在 run-host.pollEvents）
  if (req.method === 'GET' && pathname === '/run/events') {
    await rt.ensureRunHost();
    if (!rt.runHost) { send(res, 503, { ok: false, error: `run host 未就绪: ${rt.runHostBootErr?.message || 'unknown'}` }); return true; }
    const afterSeq = Number(url.searchParams.get('afterSeq'));
    send(res, 200, rt.runHost.pollEvents({
      afterSeq: Number.isInteger(afterSeq) && afterSeq >= 0 ? afterSeq : 0,
      runId: url.searchParams.get('runId') || undefined,
      limit: Number(url.searchParams.get('limit')) || undefined, // 合法性由 pollEvents 再判（0/NaN → undefined）
    }));
    return true;
  }

  // ── oneshot ──
  // /oneshot：同步跑一次 `claude -p`（无状态 LLM 调用），超时 5 分钟
  if (req.method === 'POST' && pathname === '/oneshot') {
    const body = (await readJson(req)) || {};
    if (!body || typeof body.prompt !== 'string' || body.prompt.length === 0) {
      send(res, 400, { ok: false, error: 'body must be {prompt: non-empty string}' });
      return true;
    }
    const r = await oneshotPort
      .runOneShot({ prompt: body.prompt, cwd: typeof body.cwd === 'string' ? body.cwd : undefined, timeoutMs: 300000 })
      .catch((e) => ({ ok: false, error: e.message })); // 失败也回 200 + {ok:false}，让调用方按体判
    send(res, 200, r);
    return true;
  }

  return false;
}

module.exports = { handle };
