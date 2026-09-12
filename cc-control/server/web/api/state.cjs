'use strict';
/**
 * api/state.cjs — state 域：state/metrics/diagnostics 读取 + 上下文快照标记 + run 状态写端点
 *
 * 职责：把对 state.json 的读取、观测快照、上下文就绪标记与 **state 写原语**（mode / task-active /
 * gate / backup / apply，含 CAS）收在一处，写路径统一经 rt.runStateApi（惰性装配，见 runtime）。
 *
 * 路由（method + path）：
 *   GET  /awf/state               读 state.json（可选 ?sid 读 per-run 分片；无 ok 字段，回原文）
 *   GET  /awf/metrics             观测指标快照
 *   GET  /awf/diagnostics         读最近一次诊断结果
 *   POST /awf/diagnostics         启动一次诊断（异步）→ 202 / 409
 *   POST /context-ready           置位「快照就绪」（AI 写完 handoff 后通知）
 *   GET  /context-ready           一次性消费「快照就绪」标记（CLI /clear 后取走）
 *   POST /run/state/mode          设置工作流模式（run|idle|pause，白名单硬校验）
 *   POST /run/state/task/active   把某任务标为 active
 *   POST /run/state/gate          任务完成时触发门禁判定/自动派生修复
 *   POST /run/state/backup        版本归档（run 收尾调用）
 *   POST /run/state/apply         整份 state 落盘（含 CAS 可选路径）
 *
 * 约定：`handle(req, res, url, rt, deps)` 返回 boolean —— true=本域已处理（响应已发）；
 * false=不是本域路由，交下一个。deps 由入口注入（本域暂不使用）。
 */

const { readDiagnosis } = require('../../observability/diagnosis.cjs');
const { readJson, send } = require('./util.cjs');

async function handle(req, res, url, rt, deps) {
  const pathname = url.pathname;
  const ctx = rt.ctx;

  // ── state / metrics / diagnostics 读 ──
  // GET /awf/state：可选 ?sid 读分片 state（.awf/runs/<sid>/state.json），无 sid 读项目主 state
  if (req.method === 'GET' && pathname === '/awf/state') {
    const sid = url.searchParams.get('sid');
    const s = sid ? ctx.storeCore.readJsonSync(ctx.runStateFile(sid)) : ctx.stores.state.readSync();
    if (s == null) { send(res, 404, { ok: false, error: `state.json not found${sid ? ` for run ${sid}` : ''}` }); return true; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(s, null, 2)); // 格式化：这是给人与 CLI 看的调试面
    return true;
  }
  if (req.method === 'GET' && pathname === '/awf/metrics') {
    send(res, 200, { ok: true, metrics: rt.observability.metricsSnapshot() });
    return true;
  }
  if (req.method === 'GET' && pathname === '/awf/diagnostics') {
    send(res, 200, { ok: true, diagnosis: readDiagnosis(ctx.projectRoot) });
    return true;
  }
  // POST /awf/diagnostics：启动一次诊断（异步），202 受理 / 409 已在诊断中
  if (req.method === 'POST' && pathname === '/awf/diagnostics') {
    const result = await rt.observability.startDiagnosis();
    send(res, result.ok ? 202 : 409, result);
    return true;
  }

  // ── 上下文快照就绪标记 ──
  // POST 置位（AI 写完 handoff 快照后通知）；GET 一次性消费（CLI /clear 后取走标记）
  if (req.method === 'POST' && pathname === '/context-ready') {
    rt.session.setContextReady();
    console.log('[context-ready] 快照就绪，待 CLI /clear');
    send(res, 200, { ok: true, contextReady: rt.session.contextReady });
    return true;
  }
  if (req.method === 'GET' && pathname === '/context-ready') {
    send(res, 200, { ok: true, ready: rt.session.consumeContextReady() });
    return true;
  }

  // ── state 写端点 ──
  // /run/state/mode：设置工作流模式（run|idle|pause）—— 白名单硬校验，防误写非法模式
  if (req.method === 'POST' && pathname === '/run/state/mode') {
    const body = (await readJson(req)) || {};
    if (!body || typeof body.mode !== 'string' || !['run', 'idle', 'pause'].includes(body.mode)) {
      send(res, 400, { ok: false, error: 'body must be {mode: run|idle|pause}' });
      return true;
    }
    await rt.ensureRunStateApi();
    if (!rt.runStateApi) { send(res, 503, { ok: false, error: 'state api 未就绪' }); return true; }
    send(res, 200, { ok: !!rt.runStateApi.setWorkflowMode(ctx.projectRoot, body.mode), mode: body.mode });
    return true;
  }
  // /run/state/task/active：把某任务标为 active（宿主派发时用）
  if (req.method === 'POST' && pathname === '/run/state/task/active') {
    const body = (await readJson(req)) || {};
    if (!body || typeof body.taskId !== 'string' || body.taskId.length === 0) {
      send(res, 400, { ok: false, error: 'body must be {taskId: non-empty string}' });
      return true;
    }
    await rt.ensureRunStateApi();
    if (!rt.runStateApi) { send(res, 503, { ok: false, error: 'state api 未就绪' }); return true; }
    send(res, 200, { ok: !!rt.runStateApi.markTaskActive(ctx.projectRoot, body.taskId), taskId: body.taskId });
    return true;
  }
  // /run/state/gate：任务完成时触发门禁判定/自动派生修复（handleGateCompletion）。
  // 任务不存在 → 200 applied:false（幂等：重复通知不报错）
  if (req.method === 'POST' && pathname === '/run/state/gate') {
    const body = (await readJson(req)) || {};
    if (!body || typeof body.taskId !== 'string' || body.taskId.length === 0) {
      send(res, 400, { ok: false, error: 'body must be {taskId: non-empty string}' });
      return true;
    }
    const s = ctx.stores.state.readSync();
    const task = s?.tasks?.find((x) => x.id === body.taskId) || null;
    if (!task) { send(res, 200, { ok: true, applied: false, reason: 'task not found' }); return true; }
    const gf = await import('../../features/gate/fix.js'); // 动态 import：门禁修复较重，按需装载
    await gf.handleGateCompletion(ctx.projectRoot, body.taskId, task);
    send(res, 200, { ok: true, applied: true, taskId: body.taskId });
    return true;
  }
  // /run/state/backup：版本归档（run 收尾时调用）
  if (req.method === 'POST' && pathname === '/run/state/backup') {
    await rt.ensureRunStateApi();
    if (!rt.runStateApi) { send(res, 503, { ok: false, error: 'state api 未就绪' }); return true; }
    rt.runStateApi.backupState(ctx.projectRoot);
    send(res, 200, { ok: true });
    return true;
  }
  // /run/state/apply：整份 state 落盘（含 CAS 可选路径，见 handleStateApply）
  if (req.method === 'POST' && pathname === '/run/state/apply') {
    await handleStateApply(req, res, url, rt);
    return true;
  }

  return false;
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

module.exports = { handle };
