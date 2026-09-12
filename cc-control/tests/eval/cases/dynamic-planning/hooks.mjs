/**
 * 动态规划全真用例的运行中钩子。
 *
 * 为什么需要钩子：`case.json` 是声明式的（跑完看结果），而这个能力的关键动作发生在 run **进行中** ——
 * 会话内的 AI 提交 proposal、人工批准、**同一个 run** 继续跑。钩子扮演「人在环」的那一环，
 * 而**绝不代替 AI 调 awf_dynamic_plan**（那是被验证的能力本身）。
 *
 * duringRun：等 proposal 出现 → 记录当时现场 → 立刻人工批准
 * afterRun ：用 startedAt 断言「前置先于目标执行」（同一 run，不重提）
 */
import fs from 'node:fs';
import path from 'node:path';

const memory = { proposalId: null, target: null, inserted: null };

const holdIds = (state) => Object.values(state?.dynamicPlanning?.holds || {})
  .flatMap((h) => h.taskIds || []);

export async function duringRun({ readState, get, post, sleep }) {
  const checks = [];
  const check = (ok, msg) => checks.push({ ok, msg });

  // 钩子与 `awf run` 同时起步，server 还没起来 —— 连接失败必须重试，
  // 只有「server 已在听、但没有这个路由」才是真问题（常驻 server 是旧代码）。
  let probe = { status: 0 };
  for (let i = 0; i < 60 && probe.status === 0; i++) {
    probe = await get('/awf/dynamic-planning/proposals');
    if (probe.status === 0) await sleep(1000);
  }
  if (probe.status === 0) {
    check(false, '60s 内没连上 server（HTTP 0）——本用例的钩子需要与 run 共用同一个 server');
    return { checks };
  }
  if (probe.status !== 200) {
    check(false, `server 未提供动态规划路由（HTTP ${probe.status}）——常驻 server 可能仍是旧代码，先 \`awf server stop\` 让它带新代码重启`);
    return { checks };
  }

  // 1) 等会话内的 AI 自己提出 proposal
  let proposal = null;
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline && !proposal) {
    const r = await get('/awf/dynamic-planning/proposals');
    proposal = (r.json?.proposals || []).find((p) => p.status === 'awaiting_approval') || null;
    if (!proposal) await sleep(1000);
  }
  if (!proposal) {
    check(false, '未等到 awaiting_approval 的提案（8 分钟内会话内的 AI 没有发起任何动态规划提案）');
    return { checks };
  }
  memory.proposalId = proposal.proposalId;
  check(true, `AI 在 run 中发起了提案 ${proposal.proposalId}`);

  const stateAtProposal = readState();
  const op = proposal.operations?.[0];
  const target = op?.relation?.targetTaskId || null;
  memory.target = target;

  check(stateAtProposal?.mode === 'run', `提案发起时 mode=run（实际 ${stateAtProposal?.mode}）`);
  check(proposal.requestedBy === 'ai', `提案 requestedBy=ai（实际 ${proposal.requestedBy}）`);
  check(op?.type === 'insert_task' && op?.relation?.type === 'prerequisite_for',
    `提案是 insert_task / prerequisite_for（实际 ${op?.type}）`);
  check(['T2', 'T3'].includes(target), `缺口由 AI 自己找出：目标是 ${target}（应为尚未执行的 T2/T3）`);
  const held = holdIds(stateAtProposal);
  check(!!target && held.includes(target), `hold 覆盖目标 ${target}（holds=${JSON.stringify(held)}）`);
  check(!held.includes('T1'), `hold 不牵连正在执行的任务（holds=${JSON.stringify(held)}）`);

  const targetTask = (stateAtProposal?.tasks || []).find((t) => t.id === target);
  check(targetTask?.status === 'pending' && !targetTask?.exec?.startedAt,
    `批准前目标从未被派发（status=${targetTask?.status}）`);
  const runStatus = await get('/run/status');
  const active = (runStatus.json?.runs || [])
    .filter((r) => r.status === 'queued' || r.status === 'running').length;
  check(active >= 1, `批准时 run 仍在飞（活跃 run=${active}）`);

  // 2) 人工批准（HTTP 人工入口，刻意不暴露为 MCP 工具）
  const approve = await post(`/run/dynamic-planning/proposals/${proposal.proposalId}/approve`,
    { reviewer: 'eval-hook', note: '运行中人工批准' });
  check(approve.status === 200 && approve.json?.proposal?.status === 'applied',
    `人工批准应用提案（HTTP ${approve.status} / ${approve.json?.proposal?.status ?? approve.json?.error ?? ''}）`);

  const stateAfter = readState();
  const ids = (stateAfter?.tasks || []).map((t) => t.id);
  const idx = ids.indexOf(target);
  const inserted = idx > 0 ? ids[idx - 1] : null;
  memory.inserted = inserted;
  check(!!inserted && inserted !== 'T2' && inserted !== 'T1', `新任务插在目标之前（序=${ids.join(',')}）`);
  check(!!inserted && (stateAfter?.tasks.find((t) => t.id === target)?.deps || []).includes(inserted),
    `目标依赖已重连到新任务 ${inserted}`);
  check(!stateAfter?.dynamicPlanning, 'hold 已释放');
  return { checks };
}

/** run 结束后：同一 run 内的执行顺序 + 审计记录（不重提 run 这回事由 run-eval 的流程本身保证） */
export async function afterRun({ readState, sandbox }) {
  const checks = [];
  const check = (ok, msg) => checks.push({ ok, msg });
  const state = readState();
  const byId = (id) => (state?.tasks || []).find((t) => t.id === id);
  const inserted = memory.inserted;
  const target = memory.target;

  const preAt = inserted ? byId(inserted)?.exec?.startedAt : null;
  const tgtAt = target ? byId(target)?.exec?.startedAt : null;
  check(!!preAt && !!tgtAt && preAt < tgtAt,
    `${inserted} 先于 ${target} 被派发（startedAt ${preAt ?? '无'} < ${tgtAt ?? '无'}）`);

  let events = '';
  try { events = fs.readFileSync(path.join(sandbox, '.awf', 'dynamic-planning', 'events.jsonl'), 'utf8'); } catch { /* 缺失 */ }
  check(events.includes('proposal.awaiting_approval') && events.includes('proposal.approved_and_applied'),
    '审计记录完整（proposal.awaiting_approval → proposal.approved_and_applied）');
  return { checks };
}
