'use strict';
/**
 * api/decisions.cjs — 决策域：决策记录的读与人工干预（列表 / resolve / override）
 *
 * 职责：把项目决策存储的读取、人工解决与人工覆盖接到 HTTP 面；覆盖时顺带追加一个纠偏任务，
 * 让「改决策」进入任务流而不是只改一条记录。
 *
 * 路由（method + path）：
 *   GET  /awf/decisions                    列本项目全部决策记录
 *   POST /awf/decisions/:id/resolve        人工解决一条决策（写决策存储 + 可能的续跑）
 *   POST /awf/decisions/:id/override       用人工指令覆盖 AI 决策 + 追加纠偏任务
 *
 * 约定：`handle(req, res, url, rt, deps)` 返回 boolean —— true=本域已处理（响应已发）；
 * false=不是本域路由，交下一个。deps 由入口注入（本域暂不使用）。
 */

const { readJson, send } = require('./util.cjs');

async function handle(req, res, url, rt, deps) {
  const pathname = url.pathname;
  const ctx = rt.ctx;

  // GET /awf/decisions：列本项目全部决策记录
  if (req.method === 'GET' && pathname === '/awf/decisions') {
    const decisions = ctx.newDecisionStore().listAll();
    send(res, 200, { ok: true, total: decisions.length, decisions });
    return true;
  }
  // POST /awf/decisions/:id/resolve：人工解决一条决策（写决策存储 + 可能的续跑）
  const decisionResolve = pathname.match(/^\/awf\/decisions\/([^/]+)\/resolve$/);
  if (req.method === 'POST' && decisionResolve) {
    const decisionId = decodeURIComponent(decisionResolve[1]);
    const body = (await readJson(req)) || {};
    try {
      send(res, 200, { ok: true, ...rt.dynamicPlanning().resolveDecision(decisionId, body) });
    } catch (error) {
      send(res, 409, { ok: false, error: error.message }); // 业务失败 → 409，不是 500
    }
    return true;
  }
  // POST /awf/decisions/:id/override：用人工指令覆盖 AI 决策（见 handleOverride）
  if (req.method === 'POST' && pathname.startsWith('/awf/decisions/') && pathname.endsWith('/override')) {
    await handleOverride(req, res, pathname, rt);
    return true;
  }

  return false;
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
    const task = rt.decision.appendDecisionReviewTask({
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

module.exports = { handle };
