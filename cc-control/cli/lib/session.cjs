'use strict';
/**
 * cli/lib/session.cjs — 环境拉起（server 进程 / 会话 / run-settings / 项目配置注入）
 *
 * 这是 CLI 唯一**较厚**的地方，因为它是「server 还没起时」的引导：进程操作没人能替它做。
 * 除此之外不含任何编排判断，也**不含任何平台实现** —— run-settings、`.mcp.json` 注入与
 * 会话生命周期（起/停/探测/补 Enter）都经 `adapters/ports.cjs` 取（T-P1-01/T-P1-03）：
 * 本文件零 `tmux` / `claude` 字面。
 *
 * ## 只拉新 server
 * 同类端口上若已有**不兼容的旧版** server 驻留（无 `/probe`），必须显式报错而不是复用 ——
 * 用 `/probe` 作判别：本树 server 有它。
 *
 * ## 起会话后必须等「真就绪」
 * bootstrap 用固定 `sleep 3` + 一记 Enter 消除文件夹信任弹窗；claude 起得慢时（并发起多个 run、
 * 插件/MCP 冷启动）那一击会打空 → 弹窗仍在 → 随后派发的任务文本被打进弹窗被丢弃，留下一个
 * 「从没收到过输入」的会话（2026-09-10 dual-b 现场：pane 空、无 transcript）。
 * 故建会话后等真实就绪信号（`sessionSeq` 增长），等待期间周期性补 Enter —— 见 `waitSessionStarted`。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { serverSpawnEnv, runSessionEnv } = require('./env.cjs');
const client = require('./client.cjs');
const { openServerLog, serverLogPath } = require('./server-log.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 写 run 专属 settings（声明 statusLine）：bootstrap 以 --settings 注入，作用域限本次会话 */
function writeRunSettings(ctx) {
  // 平台资产经本项目解析出的适配器取（T-P1-01）：settings 形状由平台决定，不在这里静态绑 cc
  const settings = ctx.adapters.tools.settings.generateRunSettings({
    workdir: ctx.projectRoot,
    contextUsageScript: path.join(ctx.infraRoot, 'scripts', 'context-usage.mjs'),
  });
  fs.mkdirSync(path.dirname(ctx.runSettingsPath), { recursive: true });
  fs.writeFileSync(ctx.runSettingsPath, JSON.stringify(settings, null, 2));
  return ctx.runSettingsPath;
}

// ── server ──

/**
 * 确保本项目配套的 server 在跑。
 * - 已经在跑（/probe 通）→ 复用，不起第二个；
 * - 端口上有 server 但**没有** `/probe` → 是不兼容的旧版实现，报错退出（不静默混用两代）；
 * - 都没有 → 拉起本树 server（输出接 `.awf/logs/server.log`，单代轮转），等 /status 就绪。
 */
async function ensureServer(ctx) {
  const probe = await client.createClient({ port: ctx.port, project: ctx.projectRoot })
    .request('GET', '/probe', undefined, { timeoutMs: 1500 });
  if (probe?.ok) return { started: false, reused: true };

  const foreign = await client.createClient({ port: ctx.port }).alive(1500);
  if (foreign) {
    throw new Error(
      `端口 ${ctx.port} 上驻留的 server 不响应 /probe（不兼容的旧版实现），与本 CLI 不匹配。\n`
      + '  请先关掉它（awf server stop，或直接结束占用该端口的 node 进程）再运行本 CLI。',
    );
  }

  const log = openServerLog(serverLogPath(ctx.logsDir));
  if (log.rotated) console.log(`  server.log 超上限，已轮转为 server.log.1`);
  const proc = spawn('node', [ctx.serverScriptPath], {
    stdio: ['ignore', log.fd, log.fd],
    detached: true,
    cwd: ctx.projectRoot,
    env: serverSpawnEnv({ projectRoot: ctx.projectRoot, port: ctx.port, baseSession: ctx.session }),
  });
  proc.unref();
  log.close();

  const c = client.createClient({ port: ctx.port, project: ctx.projectRoot });
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    if (await c.alive(1000)) return { started: true, reused: false, logPath: log.path };
  }
  throw new Error(`server 启动超时（日志：${log.path}）`);
}

// ── tmux 会话 ──

/**
 * 确保会话存在且指向本项目（会话生命周期经本项目平台的 session 端口 —— T-P1-03；
 * CLI 不再直连 tmux）。resume/attach 时优先复用现场；**空 cwd 必须判为不存在**：
 * 「空串当路径」会让相等判断恒真（旧 CLI 踩过这个坑，判定已下沉进端口实现）。
 * @returns {boolean} 是否新建了会话
 */
function ensureSession(ctx, { reuseExisting = false } = {}) {
  const sessionPort = ctx.adapters.ports.session;
  if (reuseExisting) {
    const cwd = sessionPort.cwd();
    if (cwd && path.resolve(cwd) === path.resolve(ctx.projectRoot)) return false;
  }
  sessionPort.kill();
  sessionPort.start({
    projectRoot: ctx.projectRoot,
    env: runSessionEnv({ projectRoot: ctx.projectRoot, port: ctx.port, sessionName: ctx.runSessionName }),
  });
  return true;
}

/** 读本项目当前会话启动序号（SessionStart 计数）；拿不到 → 0 */
async function sessionSeqOf(ctx) {
  const st = await client.createClient({ port: ctx.port, project: ctx.projectRoot })
    .getStatus().catch(() => null);
  return st?.sessionSeq ?? 0;
}

/**
 * 等本次会话真正就绪（SessionStart 已到达）再放行派发。
 *
 * bootstrap 那一记 Enter 打空时（见文件头）会话会「看起来起了、实际没收到输入」。这里等真实就绪
 * 信号（`sessionSeq` 增长），等待期间周期性补 Enter 兜住可能仍挂着的信任弹窗。
 * 超时不硬失败：告警后继续（避免把偶发慢启动升级成整个 run 失败），但会留下明确日志。
 *
 * @param {{ status?, nudge?, sleepFn?, timeoutMs?, nudgeMs? }} [deps] 测试注入点
 * @returns {Promise<boolean>} 是否等到就绪
 */
async function waitSessionStarted(ctx, seqBefore, deps = {}) {
  const {
    status = () => sessionSeqOf(ctx),
    nudge = () => ctx.adapters.ports.session.nudge(), // 补 Enter（T-P1-03：经 session 端口，不直连 tmux）
    sleepFn = sleep,
    timeoutMs = Number(process.env.CC_SESSION_READY_TIMEOUT_MS ?? 60000),
    nudgeMs = 5000, // bootstrap 已 nudge 过一次，这里再等一个间隔才补
  } = deps;
  const startedAt = Date.now();
  let lastNudge = startedAt;
  for (;;) {
    if ((await status()) > seqBefore) {
      console.log('  会话已就绪（SessionStart）');
      return true;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      console.warn(`  ⚠ 等待会话就绪超时（${Math.round(timeoutMs / 1000)}s 未收到 SessionStart），继续派发`);
      return false;
    }
    if (Date.now() - lastNudge >= nudgeMs) {
      lastNudge = Date.now();
      nudge(); // 补 Enter：claude 起得慢时 bootstrap 那一击可能打空，信任弹窗仍挂着
    }
    await sleepFn(500);
  }
}

/** 起环境：项目 MCP 注册 → server → run-settings → 会话 →（新建时）等会话就绪 */
async function bringUp(ctx, { reuseExisting = false } = {}) {
  ctx.adapters.tools.profile.installProjectMcp(ctx.projectRoot, ctx.port);
  const server = await ensureServer(ctx);
  writeRunSettings(ctx);
  const seqBefore = await sessionSeqOf(ctx); // 基准须在建会话**之前**取
  const created = ensureSession(ctx, { reuseExisting });
  // 只在新建会话时等：resume/attach 复用的是已经在跑的现场
  if (created) await waitSessionStarted(ctx, seqBefore);
  return { server, sessionCreated: created };
}

/** 结束本次 run 的会话（server 常驻保留：空闲自动回收 / 显式 stop）；经 session 端口（T-P1-03） */
function stopSession(ctx) {
  ctx.adapters.ports.session.kill();
}

module.exports = {
  writeRunSettings, ensureServer, ensureSession, sessionSeqOf, waitSessionStarted, bringUp, stopSession,
};
