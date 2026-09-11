import { spawn, execSync } from 'child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { installProjectMcp } from '../lib/profile.js';
import { loadState } from '../lib/state.js';
import { waitWhilePaused } from '../lib/pause.js';
import { buildRunContext, projectSid } from '../lib/run-context.cjs';
import { openServerLog, serverLogPath } from '../lib/server-log.js';
import { generateRunSettings } from '../server/run-settings.cjs';
import { createRunClient } from './run-client.js';
import { httpPost, httpPostJson, autoSelect, waitForReady, getStatus, SERVER_PORT, projectQuery } from '../lib/session/client.js';
import { logSection, logStep } from '../lib/ui/log.js';
import { createRunFollow } from '../lib/ui/run-follow.js';
import { CYAN, GREEN, YELLOW, RED, DIM, RESET } from '../lib/ui/colors.js';

/**
 * awf run — 自治开发工作流（T1-058：CLI 薄化为「提交 run → 订阅事件/状态 → 应答 → 收尾」；
 * T1-059：--resume/--attach 重连，读 store 落盘状态续接）
 *
 * 编排（任务选择/阶段推进/门禁闭环）已迁入 server run host（run-host.cjs，T1-105）。
 * 本文件不再挑选任务、不再推进阶段链、不再做多 agent 调度——单 agent（默认）经
 * run-client 提交 run 到 server，宿主驱动；CLI 只负责：展示宿主事件/状态、把宿主或会话
 * 暴露的人机决策转发给用户并把回应写回（handleDecision/drainDecisionResume）、收尾复位。
 *
 * 保留现状（零改动）：环境拉起（server/tmux/settings/dashboard）、mode run/idle 复位、
 * --resume 暂停闩锁语义、异常保留运行现场供 w-monitor 诊断。
 * 未迁项（形成 T1-061 清单的直写点 + 交由后续任务补齐的运行语义）见文件尾部注释。
 *
 * 说明：
 *   - 重连（T1-059）：--resume/--attach 复用现有 server/tmux 现场；driveSingle 先探宿主——
 *     有活跃 run（CLI 中断但宿主仍在驱动）→ 挂接续观（不重复提交，读 store 落盘进度展示）；
 *     宿主空闲 → resume 提交续跑 store 剩余 pending / attach 报错。--resume 对暂停闩锁保持原语义。
 *   - 多 agent（--multi-agent）：宿主 batch 传输（inbox/subagent 落账）尚未接线，
 *     暂保留 cli/run-batch.js live 路径（run.js 不实现调度，只路由），host batch 接线后切回。
 *   - 决策闸门/决策续跑：宿主单 agent 通道只等待任务在 state 自我结算；decisionPending/
 *     decisionResume 的中继仍由本 CLI observe 轮询负责（与旧 executeTask 语义一致）。
 */

/** 任务前上下文压缩与收尾协商等旧 CLI 职责：随编排迁入宿主后由 run 域任务补齐
 *  （T1-061 state/gate 直写迁移、T1-067 单写者/attach 冒烟、T1-098 真 run 全流程回归）。
 *   本文件不再承担 —— 相关函数已移除，剩余「读 state 直接判定/直写 state/gate」的落点
 *   以注释锚点在文件尾标注，供 T1-061 逐一收敛。 */

// 单 server 多项目：本次 run 的项目根（?p 路由到该项目上下文；缺省 null → 存量路径不变）
let activeProject = null;

export async function runCommand(task, options) {
  const projectRoot = process.cwd(); // run 项目（.awf 宿主）
  activeProject = projectRoot;
  // 会话名唯一化（单 server 多项目：不同目录不再共用基础名 `cc` 而互相 kill）
  const ctx = buildRunContext({ projectRoot, sid: projectSid(projectRoot) }); // 装配 infra/路径/会话名/端口（server/client/MCP 共用）
  // T1-059 重连语义：fresh=新提交 / resume=重启续接（活跃 run 挂接、空闲则提交续跑）/
  // attach=仅挂接活跃 run（读 store 落盘进度续观，不重复提交）
  const connectionMode = options?.attach ? 'attach' : options?.resume ? 'resume' : 'fresh';

  // 验证 state（bootstrap 前 server 未起，用 lib 只读 loadState 判存在/mode——读而非写；
  // 运行态读一律经 run-client 快照：attach/resume 进度取 runSnapshot、run-batch 轮询取 client.getState）
  const state = loadState(projectRoot);
  if (!state) {
    console.log(`${RED}  未找到 .awf/state.json，请先执行 awf plan${RESET}\n`);
    process.exit(1);
  }

  // awf run 是运行模式的真实入口；w-monitor 靠 mode=run 识别 run 已启动。
  // mode 写已迁 server run api（T1-061）：server 起来后经 /run/state/mode 置 run（见下方 try），
  // 此处只算标记位。w-monitor 在 pause 闩锁保持期间用 --resume 重启异常退出的 CLI，
  // 必须保留 pause，等监控验证 CLI 已重新驻留后再显式恢复为 run。
  const preservePause = options?.resume && state.mode === 'pause';
  const needSetRun = state.mode !== 'run' && !preservePause;

  // 信号清理
  let cleaned = false;
  const doCleanup = () => {
    if (cleaned) return;
    cleaned = true;
    const session = ctx.runSessionName;
    try { execSync(`tmux kill-session -t ${session} 2>/dev/null`, { stdio: 'ignore' }); } catch {}
    // T1-064：run 结束只关 tmux 会话，不再 kill 常驻 server——server 保留（下个 run/attach 复用，
    // 空闲超时自动回收，或 awf server stop 显式关闭）
    console.log(`${DIM}  已停止运行会话（server 常驻保留：空闲自动回收 / awf server stop）${RESET}`);
  };
  process.on('SIGINT', () => { doCleanup(); process.exit(0); });
  process.on('SIGTERM', () => { doCleanup(); process.exit(0); });

  // Header
  const summary = state.plan?.summary || task || '';
  console.log(`${CYAN}⚡ AI Workflow 运行${RESET}`);
  console.log(`  ${DIM}工作流:${RESET} ${summary}\n`);

  // 1. 启动环境（resume/attach 复用现有 server/tmux 现场，fresh 重建）
  logSection('启动环境');
  await startSession({
    ctx,
    workDir: projectRoot,
    reuseExisting: connectionMode !== 'fresh',
  });

  // 打开页面带本项目作用域（?p）：单 server 多项目时，否则页面会落到 server 的 boot 项目
  spawn('open', [`http://localhost:${SERVER_PORT}/?p=${encodeURIComponent(projectRoot)}`], { stdio: 'ignore', detached: true }).unref();
  logStep('dashboard', 'ok', `http://localhost:${SERVER_PORT}/?p=${projectRoot}`);
  console.log('');

  // 2. 提交 run + 订阅展示 + 应答中继（单/多 agent 一律经 server run host 驱动）
  //    多 agent（--multi-agent 或 cfg.agents.max>1）由宿主 driveBatch → runScheduler 调度，
  //    CLI 不持有调度权、不实现滑动窗口。
  let runCompleted = false;
  try {
    const client = createRunClient({ project: projectRoot });
    // T1-061：mode 写经 server run api（server 已由 startSession 拉起）——置 run 供 w-monitor 识别
    if (needSetRun) {
      const modeResp = await client.setRunMode('run');
      if (!modeResp?.ok) throw new Error('无法将工作流 mode 设置为 run');
    }
    const outcome = await driveSingle(client, {
      projectRoot,
      connectionMode,
      runId: options?.runId || null,
      mode: options?.multiAgent ? 'batch' : null, // 显式多 agent（配置面 run.agents.max>1 由宿主自行判定）
    });
    // 正常完成（宿主 run done）才标 idle（经 server run api）；异常/run error 保留现场供 w-monitor 识别
    if (outcome.ok) {
      const idleResp = await client.setRunMode('idle');
      if (!idleResp?.ok) throw new Error('工作流已完成，但无法将 mode 设置为 idle；保留运行现场');
    } else {
      throw new Error(outcome.error || 'run 未正常完成');
    }
    runCompleted = true;
  } finally {
    if (runCompleted) {
      doCleanup();
    } else {
      console.log(`${YELLOW}  运行异常退出：保留 tmux 与 Session Server 现场，供 w-monitor 诊断${RESET}`);
    }
  }
}

// ── Session 环境管理 ──

/** 启动 Session Server + tmux session 两个基础设施（路径/会话名/socket 一律来自 run-context ctx） */
async function startSession({ ctx, workDir, reuseExisting = false }) {
  // 项目级 .mcp.json 是 MCP 工具可用的必要条件（enabled-only 插件注册下插件 .mcp.json 不暴露工具）
  // 幂等合并：只刷新 awf-* server 的绝对路径，保留项目已有 server
  const m = installProjectMcp(workDir, ctx.infraRoot, ctx.port);
  if (m.written) logStep('.mcp.json', 'ok', `已确保项目 MCP 注册 → ${m.servers.join(', ')}`);
  await ensureServer(ctx.serverScriptPath, ctx.infraRoot, workDir, reuseExisting, ctx);
  await writeRunSettings(ctx, workDir);
  const seqBefore = await sessionSeqOf(workDir);
  const created = await ensureSession(ctx.bootstrapScriptPath, workDir, ctx.runSessionName, reuseExisting);
  // 新建会话才等就绪：SessionStart 到达 = claude 已接受输入（含信任弹窗已消除）
  if (created) await waitSessionStarted(ctx, workDir, seqBefore);
}

/** 读本项目当前会话启动序号（SessionStart 计数）；拿不到 → 0 */
async function sessionSeqOf(workDir) {
  const st = await getStatus(SERVER_PORT, workDir).catch(() => null);
  return st?.sessionSeq ?? 0;
}

/**
 * 等本次会话真正就绪（SessionStart 已到达）再放行派发。
 *
 * bootstrap 用固定 `sleep 3` + Enter 消除文件夹信任弹窗；claude 启动稍慢时（并发起多个 run、
 * 插件/MCP 冷启动）那一击会打空 → 弹窗仍在 → 随后派发的任务文本被打进弹窗被丢弃，
 * 留下一个「从没收到过输入」的会话（2026-09-10 dual-b 现场：pane 空、无 transcript）。
 * 这里等真实就绪信号（sessionSeq 增长），等待期间周期性补 Enter 兜住可能仍挂着的信任弹窗。
 * 超时不硬失败：告警后继续（避免把偶发慢启动升级成整个 run 失败），但会留下明确日志。
 *
 * @param {{ status?, nudge?, sleepFn?, timeoutMs?, nudgeMs? }} [deps] 测试注入点
 * @returns {Promise<boolean>} 是否等到就绪
 */
export async function waitSessionStarted(ctx, workDir, seqBefore, deps = {}) {
  const {
    status = (root) => getStatus(SERVER_PORT, root).catch(() => null),
    nudge = () => { try { execSync(`tmux send-keys -t ${ctx.runSessionName} Enter 2>/dev/null`, { stdio: 'ignore' }); } catch { /* 无会话忽略 */ } },
    sleepFn = sleep,
    timeoutMs = Number(process.env.CC_SESSION_READY_TIMEOUT_MS ?? 60000),
    nudgeMs = 5000, // bootstrap 已 nudge 过一次，这里再等一个间隔才补
  } = deps;
  const startedAt = Date.now();
  let lastNudge = startedAt;
  for (;;) {
    const st = await status(workDir);
    if ((st?.sessionSeq ?? 0) > seqBefore) {
      logStep('session', 'ok', '会话已就绪（SessionStart）');
      return true;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      logStep('', 'warn', `等待会话就绪超时（${Math.round(timeoutMs / 1000)}s 未收到 SessionStart），继续派发`);
      return false;
    }
    if (Date.now() - lastNudge >= nudgeMs) {
      lastNudge = Date.now();
      nudge(); // 补 Enter：claude 起得慢时 bootstrap 那一击可能打空，信任弹窗仍挂着
    }
    await sleepFn(500);
  }
}

/** 确保 Session Server 已启动（单 server 多项目）。T1-063+：任何健康 server 直接复用——
 *  不同项目目录也可复用同一常驻 server（请求带 ?p 路由到各自项目上下文），不再因跨项目报错；
 *  无健康 server → 拉起（本项目为 boot 项目；其余项目随后以 ?p 注册自身上下文）。 */
async function ensureServer(serverScript, infraRoot, workDir, reuseExisting = false, runCtx = buildRunContext({ projectRoot: workDir })) {
  const existing = await getStatus(SERVER_PORT).catch(() => false);
  if (existing?.state) {
    logStep('tmux-http', 'ok', existing.projectRoot === workDir
      ? '复用现有服务'
      : `复用现有服务（单 server 多项目：${existing.projectRoot} 已驻留，本项目经 ?p 路由）`);
    return;
  }

  // T1-112：server 的 console 输出不再丢弃 —— 接到项目下 .awf/logs/server.log（追加 + 按 spawn 单代轮转）。
  // 2026-09-10 宿主卡死时因为没有 server 日志，只能靠 transcript 反推才定位到 pause 闩锁。
  const logPath = serverLogPath(runCtx.logsDir);
  const log = openServerLog(logPath);
  logStep('tmux-http', 'ok', `server 输出 → ${logPath}${log.rotated ? '（已轮转上一代）' : ''}`);
  const proc = spawn('node', [serverScript], {
    stdio: ['ignore', log.fd, log.fd], detached: true, cwd: workDir,
    env: { ...process.env, CC_PORT: String(SERVER_PORT), CC_PROJECT: workDir },
  });
  proc.unref();
  log.close(); // 子进程已 dup 自己的 fd，父进程这份还回去

  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const st = await getStatus(SERVER_PORT);
    if (st && st.state) { logStep('tmux-http', 'ok', '已启动'); return; }
  }
  throw new Error('Session Server 启动超时（端口可能被非 awf 进程占用）');
}

/** 确保 tmux session 存在（会话名按项目唯一化）；resume 时优先复用现场，否则重建。
 *  @returns {Promise<boolean>} 是否新建了会话（复用 → false；调用方据此决定要不要等就绪） */
async function ensureSession(bootstrapScript, workDir, sessionName, reuseExisting = false) {
  if (reuseExisting) {
    try {
      const sessionCwd = execSync(
        `tmux display-message -p -t ${sessionName} "#{pane_current_path}"`,
        { encoding: 'utf8' },
      ).trim();
      // 会话不存在时 tmux 不报错，而是回**空串**且退出码 0；而 path.resolve('') 会静默取
      // process.cwd()（= 本进程 cwd = workDir），令下面的相等判断恒真 → 假装复用了一个不存在
      // 的会话，于是 --attach/--resume 在无会话时既不建会话也不报错（T1-108 真机回归暴露）。
      // 故空输出必须显式判为「不存在」。
      if (sessionCwd && path.resolve(sessionCwd) === path.resolve(workDir)) {
        logStep('session', 'ok', `${sessionName} → 复用现有会话`);
        return false;
      }
    } catch {}
  }
  try { execSync(`tmux kill-session -t ${sessionName} 2>/dev/null`, { stdio: 'ignore' }); } catch {}
  execSync(`bash "${bootstrapScript}"`, {
    stdio: 'ignore', cwd: workDir,
    env: {
      ...process.env,
      CC_WORKDIR: workDir,
      CC_SESSION: sessionName,
      CC_PROJECT: workDir,
      // 单 server 多项目（主键=projectRoot）：run 会话内 hook/MCP 只带 ?p 路由到本项目单槽/主 state。
      // 不注入 CC_SID —— 否则 awf-state/session MCP 会把主 run 路由到不存在的 .awf/runs/<sid> 分片（404）；
      // sid 仅用于 tmux 会话名唯一化（projectSid），不作为主 run 的寻址。
      // T1-077：run 会话内 awf-state MCP 底层经 server run api（server 单写者，不直写文件/锁）
      CC_AWF_STATE_SERVER: '1',
      CC_PORT: String(SERVER_PORT),
    },
  });
  logStep('session', 'ok', `${sessionName} → ${workDir}`);
  return true;
}

/**
 * 写 run-session 专属 settings（ctx.runSettingsPath = .awf/run-settings.json）— 声明 statusLine。
 * bootstrap 以 --settings 注入（合并语义：只覆盖声明键，不动用户/项目 settings），
 * 使 tmux 会话里状态行每次刷新把 context_window 实测百分比写入 .awf/context/usage.json。
 * T1-065：cross-session messaging 降级 tmux，不再注入 inbox 入站配置。
 * 作用域限定在 run 会话，不污染用户在项目里的交互式会话。
 */
async function writeRunSettings(ctx, workDir) {
  const settings = generateRunSettings({
    workdir: workDir,
    contextUsageScript: path.join(ctx.infraRoot, 'scripts', 'context-usage.mjs'),
  });
  await fs.mkdir(path.dirname(ctx.runSettingsPath), { recursive: true });
  await fs.writeFile(ctx.runSettingsPath, JSON.stringify(settings, null, 2));
}

// ── 单 agent：提交 run 到 server run host + 订阅展示 + 应答中继（T1-058 cutover） ──

/**
 * 单 agent 驱动入口（T1-059 重连语义）。
 *
 * 编排在 server run host（run-host.cjs）：宿主按 state 顺序推进任务（findNextTask + 门禁锚点），
 * CLI 只消费事件/状态做展示，并把会话决策/续跑中继给用户。
 *
 * connectionMode：
 *   fresh  —— 提交新 run（宿主须空闲；若已有活跃 run，防御性转挂接续观）。
 *   resume —— 重启续接：读宿主/store 落盘状态判定——有活跃 run → 挂接续观（不重复提交）；
 *             宿主空闲 → 提交续跑（store 中 done 保留、pending 由宿主继续驱动）。
 *   attach —— 仅挂接活跃 run（读 store 落盘进度展示 + 续观 + 中继）；宿主空闲 → 报错保留现场。
 *
 * @param {object} opts
 *   runId - 指定目标 run（T1-073 attach 指定 run / fresh 提交命名 sid）：缺省探宿主活跃 run。
 * @returns {Promise<{ ok: boolean, status?: string, error?: string }>}
 */
export async function driveSingle(client, { projectRoot, connectionMode = 'fresh', runId = null, mode = null }) {
  // 探宿主现态（host snapshot 的 counts 来自 store 落盘 state）
  const all = await client.runSnapshot({}).catch(() => null);
  const runs = all?.runs || [];
  const active = runs.find((r) => r.status === 'queued' || r.status === 'running');
  const target = runId ? runs.find((r) => r.runId === runId) : null;

  // 指定 run（attach/resume）→ 直接观察该 run（活跃推进 or 终态汇报）
  if (runId && (connectionMode === 'attach' || connectionMode === 'resume')) {
    if (!target) {
      const err = `attach: 宿主未找到 run ${runId}`;
      logStep('', 'error', err);
      return { ok: false, error: err };
    }
    const afterSeq = await hostEventTail(client);
    const note = target.status === 'running' || target.status === 'queued'
      ? `指定 run ${runId}（store 已落盘 ${target.counts?.done ?? 0}/${target.counts?.total ?? 0} done）`
      : `指定 run ${runId} 已 ${target.status}`;
    logStep('run', 'ok', `挂接指定 run ${runId}（${target.status}）`);
    return observeRun(client, {
      runId, projectRoot, afterSeq,
      header: { mode: target.mode || 'single', note },
    });
  }

  // fresh/resume 指定 run 但宿主正驱动别的 run → 单槽冲突（不能并发开第二个）
  if (runId && active && active.runId !== runId) {
    const err = `宿主正在驱动 run ${active.runId}（单槽），无法并发 run ${runId}`;
    logStep('', 'error', err);
    return { ok: false, error: err };
  }

  if (!active) {
    if (connectionMode === 'attach') {
      const err = 'attach: 宿主无活跃 run（请先 awf run，或用 awf run --resume 续跑）';
      logStep('', 'error', err);
      return { ok: false, error: err };
    }
    // fresh / resume(空闲) → 提交（runId 命名或 default）：resume 即「读 store 落盘的剩余 pending 由宿主续跑」
    const afterSeq = await hostEventTail(client);
    const submitted = await client.submitRun({ runId: runId || undefined, mode: mode || undefined });
    if (!submitted?.ok) {
      const err = `run 提交失败: ${submitted?.error || 'unknown'}`;
      logStep('', 'error', err);
      return { ok: false, error: err };
    }
    logStep('run', 'ok', `已提交 run ${submitted.runId}（mode=${submitted.mode}），server 宿主开始推进`);
    return observeRun(client, {
      runId: submitted.runId,
      projectRoot,
      afterSeq,
      header: { mode: submitted.mode },
    });
  }

  // 有活跃 run：attach / resume → 挂接；fresh 防御性转挂接（宿主单槽不可重复提交）
  if (connectionMode === 'fresh') {
    logStep('', 'warn', `宿主已有活跃 run ${active.runId}，按挂接续观处理（不重复提交）`);
  }
  const counts = active.counts || {};
  logStep('run', 'ok', `挂接 run ${active.runId}：store 已落盘 ${counts.done}/${counts.total} done，${counts.blocked || 0} blocked`);
  const afterSeq = await hostEventTail(client);
  return observeRun(client, {
    runId: active.runId,
    projectRoot,
    afterSeq,
    header: { mode: active.mode || 'single', note: `store 已落盘 ${counts.done}/${counts.total} done` },
  });
}

/** 取宿主事件尾游标（提交/挂接前调用，避免回放本次之前/之外的旧宿主事件） */
async function hostEventTail(client) {
  try {
    const seed = await client.pollRunEvents({});
    return seed?.tailSeq || 0;
  } catch {
    return 0;
  }
}

/**
 * 观察宿主推进直至 run 终态（submit 与 attach 共用；afterSeq 起始游标由调用方决定）。
 * TTY 终端启用 run-follow 跟随展示（任务行原地更新 + 进度行）；非 TTY 走静态事件日志。
 */
async function observeRun(client, { runId, projectRoot, afterSeq = 0, header = null }) {
  const follow = header && process.stdout.isTTY ? createRunFollow() : null;
  if (follow) follow.attach({ runId, mode: header.mode, note: header.note });

  const seenResume = new Set(); // 已续跑过的 decision_id，防轮询重复注入
  let terminal;

  while (!terminal) {
    // 外部监控/人工介入闩锁：暂停期间不消费事件、不应答，恢复后再续。
    await waitWhilePaused(projectRoot);

    // 1) 会话级人机应答中继：decisionPending（choice/ask/AskUserQuestion）→ 用户回应写回
    //    decisionResume（gate 捕获的续跑）→ 注入续跑消息（一次）
    const st = await getStatus(SERVER_PORT, projectRoot).catch(() => null);
    if (st) {
      if (st.decisionPending) {
        await handleDecision(st.decisionPending);
      }
      const resume = st.decisionResume;
      if (resume?.decision_id && !seenResume.has(resume.decision_id)) {
        seenResume.add(resume.decision_id);
        await injectResumeOnce(resume);
      }
    }

    // 2) 宿主事件展示：TTY → 喂 follow（任务行重绘 + run/gate 浮日志）；否则静态事件日志
    const ev = await client.pollRunEvents({ runId, afterSeq }).catch(() => ({ events: [], afterSeq }));
    for (const e of ev?.events || []) {
      afterSeq = Math.max(afterSeq, e.seq);
      if (follow) follow.event(e);
      else renderHostEvent(e);
    }

    // 3) 宿主状态 → 进度行 + 终态判定
    const snap = await client.runSnapshot({ runId }).catch(() => null);
    const run = snap?.run;
    if (follow && run && !['done', 'error', 'stopped'].includes(run.status)) {
      follow.status(run);
    }
    if (run && ['done', 'error', 'stopped'].includes(run.status)) {
      terminal = run;
      break;
    }

    await sleep(200);
  }

  if (!terminal) {
    if (follow) follow.finish({ status: 'stopped' });
    return { ok: false, error: 'run 观察中断（宿主未返回终态）' };
  }

  if (terminal.status === 'done') {
    const c = terminal.counts || {};
    console.log(`\n${GREEN}  ✔ 工作流结束${RESET}`);
    if (follow) follow.finish({ status: 'done', counts: c });
    logStep('run', 'ok', `run ${runId} done：${c.done}/${c.total} done，${c.blocked || 0} blocked`);
    return { ok: true, status: 'done' };
  }

  const err = terminal.error || terminal.status;
  console.log(`\n${RED}  ✗ run ${runId} ${terminal.status}${RESET}${terminal.error ? `：${terminal.error}` : ''}`);
  if (follow) follow.finish({ status: terminal.status });
  return { ok: false, status: terminal.status, error: err };
}

/** 展示单个宿主事件（task/run 生命周期） */
function renderHostEvent(e) {
  const p = e.payload || {};
  switch (e.type) {
    case 'run.started':
      logStep('run', 'ok', `宿主开始驱动（mode=${p.mode || ''}）`);
      break;
    case 'run.phase':
      logStep('', 'skip', `阶段 → ${p.phase || ''}`);
      break;
    case 'task.started': {
      logBanner(`任务 ${p.taskId}: ${p.title || ''}`);
      if (Array.isArray(p.chain) && p.chain.length > 0) logStep('', 'skip', `阶段链 ${p.chain.join(' → ')}`);
      break;
    }
    case 'task.done':
      logStep(p.taskId, 'ok', 'done');
      break;
    case 'task.blocked':
      logStep(p.taskId, 'warn', `blocked${p.verdict?.level ? `（${p.verdict.level}：${p.verdict.conclusion || ''}）` : ''}`);
      break;
    case 'gate.fix':
      logStep('', 'ok', `门禁 ${p.taskId} 非 pass → 已派生修复任务`);
      break;
    case 'run.stopped':
      logStep('run', 'skip', `已停止（${p.status || 'stopped'}）`);
      break;
    case 'run.error':
      logStep('', 'error', `run ${e.runId} 异常：${p.error || ''}`);
      break;
    default:
      break;
  }
}

/** 注入 gate 决策续跑消息（一次）；失败仅告警不阻断观察 */
async function injectResumeOnce(resume) {
  const pj = projectQuery(activeProject); // 多项目：/send 路由到本项目
  const note = resume.fallback ? '（兜底：无法可靠决策，按延后处理继续）' : '';
  logStep('decision', 'ok', `决策 ${resume.decision_id} → 续跑: ${String(resume.answer).slice(0, 60)}`);
  const text = `已收到 AWF 决策结果：${resume.answer}${note}\n请据此继续执行当前任务，完成后结束本回合；如再遇需要决策之处，按既定标记处理。`;
  try {
    const resp = await httpPostJson(`http://127.0.0.1:${SERVER_PORT}/send${pj}`, { text });
    if (!resp?.ok) logStep('', 'error', `决策续跑注入失败: ${resp?.error || 'unknown'}`);
  } catch (e) {
    logStep('', 'error', `决策续跑注入失败: ${e.message}`);
  }
}

// ── 决策处理（中继：把会话/AI 的决策展示给用户并把回应写回） ──

/** 已处理过的问题去重 */
const seenAnswers = new Set();

/**
 * 处理 AI 发出的决策请求：
 *   AskUserQuestion → 自动选择（5s 倒计时）
 *   choice          → readline 手动选择
 *   text            → readline 手动输入
 */
export async function handleDecision(d) {
  const pj = projectQuery(activeProject); // 多项目：/respond 路由到本项目
  if (d.source === 'AskUserQuestion') {
    if (d.answered) {
      if (!seenAnswers.has(d.question)) { console.log(`     ${GREEN}✔ 已选择: ${d.answer}${RESET}`); seenAnswers.add(d.question); }
      return;
    }
    console.log(`\n${YELLOW}  ⚡ AI 提问:${RESET} ${CYAN}${d.question}${RESET}${d.multiSelect ? ` ${DIM}(多选)${RESET}` : ''}`);
    if (d.options?.length) d.options.forEach((o, i) => console.log(`     ${DIM}${i + 1}.${RESET} ${o}`));
    const sel = await autoSelect(d);
    if (sel) {
      if (sel.multiSelect) await httpPost(`http://127.0.0.1:${SERVER_PORT}/respond${pj}`, { value: sel.selected.join(',') });
      else if (sel.index > 0) await httpPost(`http://127.0.0.1:${SERVER_PORT}/respond${pj}`, { value: String(sel.index) });
      else if (sel.customInput) await httpPost(`http://127.0.0.1:${SERVER_PORT}/respond${pj}`, { value: sel.customInput });
    }
    return;
  }

  console.log(`\n${YELLOW}  ⚡ AI 需要决策...${RESET}`);
  const { createInterface } = await import('readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    if (d.type === 'choice' && Array.isArray(d.options) && d.options.length > 0) {
      console.log(`  ${CYAN}${d.question}${RESET}`);
      d.options.forEach((o, i) => console.log(`     ${DIM}${i + 1}.${RESET} ${o}`));
      const value = await askChoice(rl, d.options);
      await httpPost(`http://127.0.0.1:${SERVER_PORT}/respond${pj}`, JSON.stringify({ value }));
      console.log(`     ${GREEN}✔ 已选择: ${value}${RESET}\n`);
      return;
    }

    console.log(`  ${CYAN}${d.question}${RESET}`);
    const answer = await new Promise((resolve) => rl.question(`  ${DIM}输入: ${RESET}`, (a) => resolve(a.trim())));
    if (answer) {
      await httpPost(`http://127.0.0.1:${SERVER_PORT}/respond${pj}`, JSON.stringify({ value: answer }));
      console.log(`     ${GREEN}✔ 已发送${RESET}\n`);
    }
  } finally {
    rl.close();
  }
}

/**
 * 反复追问直到拿到合法序号。
 * 越界/非数字输入绝不能当答案回传——否则 "11" 这类脏值会被决策方当成真实选择
 * （2026-09-10 真 run：连续敲键得到 "11" → options[10] 为 undefined → 原样回传 → 决策方拿到无意义答案）。
 * @returns {Promise<string>} 选中的选项文本
 */
async function askChoice(rl, options) {
  for (;;) {
    const raw = await new Promise((resolve) => rl.question(`  ${DIM}选择 (1-${options.length}): ${RESET}`, (a) => resolve(a.trim())));
    const idx = Number.parseInt(raw, 10);
    if (Number.isInteger(idx) && idx >= 1 && idx <= options.length) return options[idx - 1];
    console.log(`  ${YELLOW}请输入 1-${options.length} 之间的序号（收到「${raw}」）${RESET}`);
  }
}

/**
 * gate on 决策捕获后的决策续跑（供 run-resume 等外部调用复用）：读取一次 /status 的
 * decisionResume → 注入续跑消息 → 再次等待，直到无待续跑决策。单 agent observe 内不直接
 * 使用（避免与宿主等待冲突），改由 driveSingleViaHost 的 seenResume 一次性注入代替。
 */
export async function drainDecisionResume(projectRoot) {
  const pj = projectQuery(projectRoot);
  for (let i = 0; i < 10; i++) {
    const status = await getStatus(SERVER_PORT, projectRoot);
    const resume = status?.decisionResume;
    if (!resume || !resume.decision_id) return;
    const note = resume.fallback ? '（兜底：无法可靠决策，按延后处理继续）' : '';
    logStep('decision', 'ok', `决策 ${resume.decision_id} → 续跑: ${String(resume.answer).slice(0, 60)}`);
    const text = `已收到 AWF 决策结果：${resume.answer}${note}\n请据此继续执行当前任务，完成后结束本回合；如再遇需要决策之处，按既定标记处理。`;
    const sendResp = await httpPostJson(`http://127.0.0.1:${SERVER_PORT}/send${pj}`, { text });
    if (!sendResp?.ok) {
      logStep('', 'error', `决策续跑注入失败: ${sendResp?.error || 'unknown'}`);
      return;
    }
    await waitForReady({ onDecision: handleDecision, whilePaused: () => waitWhilePaused(projectRoot), project: projectRoot });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 输出辅助 ──

/** 打印任务分隔横幅 */
export function logBanner(text) { console.log(`${CYAN}  ── ${text} ──${RESET}`); }

// ════════════════════════════════════════════════════════════════════════════════
// T1-061/T1-062 状态写入收敛（cli 侧 state 直写 → server run api）
//
// 【T1-061 已迁】（写经 server /run/state/*，server 单写者；本文件不再直写 state 写函数）
//   - run.js：mode run/idle 复位 → client.setRunMode（POST /run/state/mode）。
//   - 调度/门禁/版本备份：全在 server 进程内执行（run-host 门禁锚点 →
//     src/server/gate-fix.js；host drive 收尾 backupState），CLI 侧没有对应写点。
//   - gate-fix.handleGateCompletion：写逻辑单源在 src/server/gate-fix.js。
//
// 【T1-062】读路径：本文件 loadState 只读校验；运行态读经 client 快照（GET /awf/state 等）。
//
// 【多 agent 已收归宿主】cli/run-batch.js 已删除——调度权不再在 CLI：
//   run.js 只提交 run（--multi-agent → mode:'batch'），宿主 driveBatch → runScheduler 调度，
//   派发/完成感知由 src/server/batch-transport.cjs 承担。
//
// 【单 agent 会话内协商】宿主 defaultSingleExecutor 的收尾协商与任务前上下文压缩由
//   src/server/task-channel.cjs 承担（迁自重构前本文件的 settleTask / maybeCompactContext）。
// ════════════════════════════════════════════════════════════════════════════════
