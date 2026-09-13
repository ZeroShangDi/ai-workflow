'use strict';
/**
 * cli/lib/session.cjs — 环境拉起（server 进程 / tmux 会话 / run-settings / 项目配置注入）
 *
 * 这是 CLI 唯一**较厚**的地方，因为它是「server 还没起时」的引导：进程与 shell 操作没人能替它做。
 * 除此之外不含任何编排判断，也**不含任何 cc 形状实现** —— run-settings 与 `.mcp.json` 注入都经
 * `adapters/ports.cjs` 取（见 cc/settings.cjs、cc/profile.cjs）。
 *
 * ## 只拉新 server
 * 本 CLI 与 `server/` 同属新树。同类端口上若已有**旧树** server 驻留，两者不兼容（hook/MCP 契约
 * 相同、实现不同），必须显式报错而不是复用 —— 用 `/probe` 作为判别：新 server 有它，旧 server 没有。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');
const { serverSpawnEnv, runSessionEnv } = require('./env.cjs');
const client = require('./client.cjs');
const { settings: settingsPort, profile } = require('../../server/adapters/ports.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 写 run 专属 settings（声明 statusLine）：bootstrap 以 --settings 注入，作用域限本次会话 */
function writeRunSettings(ctx) {
  const settings = settingsPort.generateRunSettings({
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
 * - 端口上有 server 但**没有** `/probe` → 是旧树那份，报错退出（不静默混用两棵树）；
 * - 都没有 → 拉起新 server（输出接 `.awf/logs/server.log`），等 /status 就绪。
 */
async function ensureServer(ctx) {
  const probe = await client.createClient({ port: ctx.port, project: ctx.projectRoot })
    .request('GET', '/probe', undefined, { timeoutMs: 1500 });
  if (probe?.ok) return { started: false, reused: true };

  const legacy = await client.createClient({ port: ctx.port }).alive(1500);
  if (legacy) {
    throw new Error(
      `端口 ${ctx.port} 上驻留的 server 不响应 /probe（旧树实现），与本 CLI 不兼容。\n`
      + '  请先用旧 CLI 关闭它（awf server stop），再运行本 CLI。',
    );
  }

  const logPath = path.join(ctx.logsDir, 'server.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, 'a');
  const proc = spawn('node', [ctx.serverEntry], {
    stdio: ['ignore', fd, fd],
    detached: true,
    cwd: ctx.projectRoot,
    env: serverSpawnEnv({ projectRoot: ctx.projectRoot, port: ctx.port, baseSession: ctx.session }),
  });
  proc.unref();
  fs.closeSync(fd);

  const c = client.createClient({ port: ctx.port, project: ctx.projectRoot });
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    if (await c.alive(1000)) return { started: true, reused: false, logPath };
  }
  throw new Error(`server 启动超时（日志：${logPath}）`);
}

// ── tmux 会话 ──

/**
 * 确保 tmux 会话存在且指向本项目。
 * resume/attach 时优先复用现场；但**空输出必须判为不存在** —— tmux 对不存在的会话
 * 返回空串且退出码 0，path.resolve('') 会静默取进程 cwd，令相等判断恒真（旧 CLI 踩过这个坑）。
 * @returns {boolean} 是否新建了会话
 */
function ensureSession(ctx, { reuseExisting = false } = {}) {
  const name = ctx.runSessionName;
  if (reuseExisting) {
    try {
      const cwd = execSync(`tmux display-message -p -t ${name} "#{pane_current_path}"`, { encoding: 'utf8' }).trim();
      if (cwd && path.resolve(cwd) === path.resolve(ctx.projectRoot)) return false;
    } catch { /* 会话不存在 → 往下走重建 */ }
  }
  try { execSync(`tmux kill-session -t ${name} 2>/dev/null`, { stdio: 'ignore' }); } catch { /* 没有就算了 */ }
  execSync(`bash "${ctx.bootstrapScript}"`, {
    stdio: 'ignore',
    cwd: ctx.projectRoot,
    env: runSessionEnv({ projectRoot: ctx.projectRoot, port: ctx.port, sessionName: name }),
  });
  return true;
}

/** 起环境：项目 MCP 注册 → server → run-settings → tmux 会话 */
async function bringUp(ctx, { reuseExisting = false } = {}) {
  profile.installProjectMcp(ctx.projectRoot, ctx.port);
  const server = await ensureServer(ctx);
  writeRunSettings(ctx);
  const created = ensureSession(ctx, { reuseExisting });
  return { server, sessionCreated: created };
}

/** 结束本次 run 的会话（server 常驻保留：空闲自动回收 / 显式 stop） */
function stopSession(ctx) {
  try { execSync(`tmux kill-session -t ${ctx.runSessionName} 2>/dev/null`, { stdio: 'ignore' }); } catch { /* 已不在 */ }
}

module.exports = { writeRunSettings, ensureServer, ensureSession, bringUp, stopSession };
