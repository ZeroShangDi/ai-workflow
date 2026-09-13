'use strict';
/**
 * cli/commands/run.cjs — awf run（薄）
 *
 * CLI 在 run 里的全部职责，只有四件：
 *   ① 起环境（server / tmux / settings / .mcp.json）；② 提交 run；③ 订阅事件与状态并展示；
 *   ④ 把人机决策转给用户、把回应写回。
 *
 * **不做**：不挑任务、不推进阶段、不做多 agent 调度、不直接读写 state 的编排字段 ——
 * 那些都在 server 的 run host 里（宿主拥有调度权）。本文件里每一次状态写入都是经 HTTP 的
 * `POST /run/state/mode`（CLI 不再是 state 的写者之一）。
 */

const { readJsonSync } = require('../../server/shared/store-core.cjs');
const { stateFilePath } = require('../../server/shared/project-paths.cjs');
const { buildContext } = require('../lib/context.cjs');
const { createClient } = require('../lib/client.cjs');
const session = require('../lib/session.cjs');
const { answerDecision } = require('../lib/decision.cjs');
const { decisionMode: readDecisionMode } = require('../../server/features/decision/config.cjs');

const C = { cyan: '[36m', dim: '[2m', red: '[31m', yellow: '[33m', reset: '[0m' };
const POLL_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 任务状态行：`<icon> [<id>] <标题> <耗时>` —— 与旧 CLI 的任务列表同一格式。
 * 它既是给人看的时间线，也是回归/评测用于事后复盘与并行度分析的稳定格式（eval 的日志检查按它解析）。
 */
const taskSeen = new Map(); // taskId → { title, startedAt }

function taskLine(icon, id, title, startedAt) {
  const secs = startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0;
  return `  ${icon} [${id}] ${title || '未命名任务'} ${secs}s`;
}

/** 事件 → 一行人读文本（未知类型原样打 type） */
function renderEvent(e) {
  const p = e.payload || {};
  const task = p.taskId || p.id || '';
  switch (e.type) {
    case 'run.started': return `▶ run 开始（mode=${p.mode || '-'}）`;
    case 'run.stopped': return `■ run 结束（status=${p.status || '-'}）`;
    case 'run.error': return `✖ run 出错：${p.error || ''}`;
    case 'task.started': {
      taskSeen.set(task, { title: p.title || '', startedAt: Date.now() });
      return taskLine('●', task, p.title, Date.now());
    }
    case 'task.done': {
      const seen = taskSeen.get(task);
      return taskLine('✓', task, seen?.title || p.title, seen?.startedAt);
    }
    case 'task.blocked': {
      const seen = taskSeen.get(task);
      return taskLine('⚠', task, seen?.title || p.title, seen?.startedAt);
    }
    // 门禁非 pass → 派生修复任务（fixId 由宿主从派发结果带出）
    case 'gate.fix':
      return `  ⚑ 门禁 ${task} 非 pass → 派生修复任务 ${p.fixId || '(未派生)'}`;
    default: return `  · ${e.type}`;
  }
}

/**
 * 订阅事件与状态，直到 run 进入终态。
 * @returns {{ ok: boolean, error?: string }}
 */
async function observe(client, { runId, afterSeq = 0, mode = 'auto' }) {
  let after = afterSeq;
  for (;;) {
    const ev = await client.pollRunEvents({ runId, afterSeq: String(after) });
    if (ev?.ok === false) return { ok: false, error: ev.error };
    for (const e of ev.events || []) {
      if (e.type && !e.type.startsWith('decision.')) console.log(renderEvent(e));
      after = Math.max(after, e.seq ?? after);
    }

    const st = await client.runSnapshot(runId ? { runId } : undefined);
    if (st?.ok === false) return { ok: false, error: st.error };

    // 人机决策挂在会话面（/status 的 decisionPending），不在 run 快照里 → 单独问一次。
    // 谁来答由配置的策略决定（manual / ai / auto），三路由的应答都经 /respond 落记录。
    const s = await client.getStatus();
    if (s?.decisionPending) {
      const r = await answerDecision({ pending: s.decisionPending, client, mode });
      if (r.answered) console.log(`  ${C.dim}⚡ 决策已答（${r.by}）：${String(r.value).slice(0, 40)}${C.reset}`);
      else console.log(`  ${C.dim}⏸ 决策待答（${r.by}）：${r.reason}${C.reset}`);
    }

    const status = st.run?.status;
    if (status === 'done') return { ok: true };
    if (status && status !== 'running' && status !== 'queued') {
      return { ok: false, error: `run 终止于 ${status}${st.run.error ? `：${st.run.error}` : ''}` };
    }
    await sleep(POLL_MS);
  }
}

async function runCommand(task, options = {}) {
  const ctx = buildContext(process.cwd());
  if (!readJsonSync(stateFilePath(ctx.projectRoot))) {
    console.error(`${C.red}未找到 .awf/state.json，请先规划（awf plan）${C.reset}`);
    process.exit(1);
  }
  const connectionMode = options.attach ? 'attach' : options.resume ? 'resume' : 'fresh';
  const decisionMode = readDecisionMode(ctx.projectRoot); // 决策策略：manual / ai / auto
  const state = readJsonSync(stateFilePath(ctx.projectRoot));
  const preservePause = connectionMode !== 'fresh' && state.mode === 'pause';

  const stop = () => session.stopSession(ctx);
  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });

  console.log(`${C.cyan}⚡ AI Workflow${C.reset}  ${C.dim}${state.plan?.summary || task || ''}${C.reset}`);

  await session.bringUp(ctx, { reuseExisting: connectionMode !== 'fresh' });
  const client = createClient({ port: ctx.port, project: ctx.projectRoot });

  let done = false;
  try {
    if (!preservePause && state.mode !== 'run') {
      const r = await client.setMode('run');
      if (r?.ok === false) throw new Error(`无法置 mode=run：${r.error}`);
    }
    if (connectionMode === 'attach') {
      // 不带 runId 的 snapshot 返回全部 run 摘要 —— 挂接其中活跃的那个
      const snap = await client.runSnapshot();
      const active = (snap.runs || []).find((r) => r.status === 'running' || r.status === 'queued');
      if (!active) throw new Error('没有活跃 run 可挂接');
      console.log(`${C.dim}  挂接 runId=${active.runId}${C.reset}`);
      const outcome = await observe(client, { runId: active.runId, mode: decisionMode });
      done = outcome.ok;
      if (!done) throw new Error(outcome.error);
      return;
    }
    const sub = await client.submitRun({ runId: options.runId || undefined, mode: options.multiAgent ? 'batch' : undefined });
    if (sub?.ok === false) throw new Error(`提交 run 失败：${sub.error}`);
    console.log(`${C.dim}  runId=${sub.runId} mode=${sub.mode}${C.reset}`);

    const outcome = await observe(client, { runId: sub.runId, mode: decisionMode });
    if (!outcome.ok) throw new Error(outcome.error);
    const idle = await client.setMode('idle');
    if (idle?.ok === false) throw new Error(`run 已完成但无法置 mode=idle：${idle.error}`);
    done = true;
  } finally {
    if (done) {
      stop();
      console.log(`${C.dim}  已停止运行会话（server 常驻保留）${C.reset}`);
    } else {
      console.log(`${C.yellow}  运行异常退出：保留 tmux 与 server 现场，供 w-monitor 诊断${C.reset}`);
    }
  }
}

module.exports = { runCommand, observe, renderEvent };
