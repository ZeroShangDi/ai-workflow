'use strict';
/**
 * api/planning.cjs — 动态规划域：proposal 的读与写（propose / approve / reject）
 *
 * 职责：把「运行期动态调整任务图」的 proposal 面收在一处：读列表/单条、提交提案、人工批准/驳回。
 * 执行模式来自 `.awf/config.json` 的 `run.dynamicPlanning.mode`；服务由 rt.dynamicPlanning() 惰性装配。
 *
 * 路由（method + path）：
 *   GET  /awf/dynamic-planning/proposals                          列全部 / 取单条（?proposalId）
 *   POST /run/dynamic-planning/proposals                          提交一次动态任务调整（propose）
 *   POST /run/dynamic-planning/proposals/:id/(approve|reject)     人工批准/驳回提案
 *
 * 约定：`handle(req, res, url, rt, deps)` 返回 boolean —— true=本域已处理（响应已发）；
 * false=不是本域路由，交下一个。deps 由入口注入（本域暂不使用）。
 */

const { readJson, send } = require('./util.cjs');

async function handle(req, res, url, rt, deps) {
  const pathname = url.pathname;

  // GET /awf/dynamic-planning/proposals：给了 proposalId 取单条，否则列全部
  if (req.method === 'GET' && pathname === '/awf/dynamic-planning/proposals') {
    const proposalId = url.searchParams.get('proposalId');
    const service = rt.dynamicPlanning();
    if (proposalId) {
      const proposal = service.get(proposalId);
      if (proposal) send(res, 200, { ok: true, proposal });
      else send(res, 404, { ok: false, error: `dynamic planning proposal not found: ${proposalId}` });
      return true;
    }
    send(res, 200, { ok: true, proposals: service.list() });
    return true;
  }

  // ── 动态规划写端 ──
  // POST /run/dynamic-planning/proposals：提交一次动态任务调整（propose）
  if (req.method === 'POST' && pathname === '/run/dynamic-planning/proposals') {
    const body = (await readJson(req)) || {};
    try {
      const proposal = rt.dynamicPlanning().propose(body);
      const applied = proposal.status === 'applied_review_pending'; // 已自动应用 → 200，待人工 → 202
      send(res, applied ? 200 : 202, { ok: true, applied, proposal });
    } catch (e) {
      send(res, 409, { ok: false, error: e.message });
    }
    return true;
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
      send(res, 200, { ok: true, proposal });
    } catch (e) {
      send(res, 409, { ok: false, error: e.message });
    }
    return true;
  }

  return false;
}

module.exports = { handle };
