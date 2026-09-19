'use strict';
/**
 * serve.cjs — DSH 网页后台的「确保在跑」（不在则拉起并等就绪，在则复用跳过）
 *
 * 为什么要它：DSH 模式下网页后台是**必需前置**（设计文档 §8）——AWF 建的会话跑在它里面，
 * 它不在就什么都驱动不了。此前没人负责：`awf plan` / `awf run` 都假定用户已经手动起过，
 * 没起就以「未连接」的形式失败在建会话那一步（checklist D1 推荐「session.start() 负责拉起并等就绪」，
 * 那一项一直没落地）。
 *
 * 形状与 cc 侧的 `cli/lib/session.cjs:ensureServer` 对齐：
 *   已在跑 → 复用，不起第二个；端口被别的服务占着 → 显式报错（不静默混用）；不在 → 拉起 + 等就绪。
 *
 * ## 复用判据（真机实测的指纹）
 * `GET http://127.0.0.1:<port>/` 返回 **401/403** = dsh 网页在跑。
 * 依据：`dsh web` 默认监听 127.0.0.1:3080，`GET /` 与 `/api` 都返 401，而**插件自己注册的路由不在这道
 * 信任栅栏内**（探针 F36：`/api/awf-probe/ping` = 200）。所以「401」是这条链上最稳的 dsh 指纹，
 * 换成「端口有人应答就复用」会在端口被别的东西占用时先假复用、到建会话才以难懂的方式炸掉。
 *
 * ## 起法（F37）
 * `dsh web` 是 `--profile web` 的**别名，不接受父级 `--profile`**（会报
 * `web takes none of parent --profile ...`）。所以：
 *   profile === 'web' → `dsh web --port <p> --no-open`
 *   其它 profile      → `dsh --profile <p> --port <p> --no-open`
 * 一律 `--no-open`：后台起，不弹浏览器（浏览器由 `awf open` / plan 出口按需打开）。
 *
 * ## 共享性
 * 这个后台是**用户级、多项目共享**的（同 DSH_HOME 下一份）。所以复用是常态，
 * 日志落在**触发它的那个项目**的 `.awf/logs/` 下，只是便于当场排查，不代表进程归属该项目。
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

/** 缺省端口：与 install.cjs 写进 profile 的 webPort 一致（会话观看地址用它） */
const DEFAULT_WEB_PORT = 3080;
/** 缺省 profile 名：`awf plugin install` 装的就是它 */
const DEFAULT_PROFILE = 'web';
/** 等就绪上限：dsh 冷启动含插件装载，实测在数秒级，给足余量 */
const READY_TIMEOUT_MS = 30000;
const POLL_MS = 500;

/** 端口：显式参数 > AWF_DSH_WEB_PORT > 3080（与 install/plugin 的取值口径一致） */
function webPortOf(explicit, env = process.env) {
  const n = Number(explicit ?? env.AWF_DSH_WEB_PORT);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WEB_PORT;
}

/** profile 名：显式参数 > AWF_DSH_PROFILE > web */
function profileOf(explicit, env = process.env) {
  const v = String(explicit ?? env.AWF_DSH_PROFILE ?? '').trim();
  return v === '' ? DEFAULT_PROFILE : v;
}

/**
 * 启动参数（纯函数，便于单测 —— F37 的别名坑就钉在这里）。
 * @param {string} profile
 * @param {number} port
 * @returns {string[]}
 */
function dshArgs(profile, port) {
  const tail = ['--port', String(port), '--no-open'];
  return profile === 'web' ? ['web', ...tail] : ['--profile', profile, ...tail];
}

/**
 * 探一次端口。
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<{kind: 'dsh'|'absent'|'foreign'|'timeout', status?: number, reason?: string}>}
 */
function probe(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', timeout: timeoutMs },
      (res) => {
        res.resume(); // 丢弃响应体，只要状态码
        const status = res.statusCode ?? 0;
        if (status === 401 || status === 403) resolve({ kind: 'dsh', status });
        else resolve({ kind: 'foreign', status });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ kind: 'timeout' }); });
    req.on('error', (err) => {
      // 没人监听 = 没起；其它错误（权限、DNS…）不是「没起」，别当成可以拉起
      const code = err?.code ?? '';
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND') resolve({ kind: 'absent' });
      else resolve({ kind: 'foreign', reason: `${code || err.message}` });
    });
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 确保 DSH 网页后台在跑。
 * @param {{ webPort?: number, profile?: string, logDir?: string, timeoutMs?: number,
 *           deps?: { probeFn?: Function, spawnFn?: Function, sleepFn?: Function } }} [opts]
 * @returns {Promise<{ reused: boolean, started: boolean, port: number, profile: string,
 *                     logPath: string|null, url: string|null }>}
 * @throws {Error} 端口被别的服务占用 / dsh 起不来（超时） / dsh 不在 PATH
 */
async function ensureWeb({ webPort, profile, logDir, timeoutMs = READY_TIMEOUT_MS, deps = {} } = {}) {
  const {
    probeFn = probe,
    spawnFn = spawn,
    sleepFn = sleep,
  } = deps;
  const port = webPortOf(webPort);
  const prof = profileOf(profile);

  const first = await probeFn(port);
  if (first.kind === 'dsh') return { reused: true, started: false, port, profile: prof, logPath: null, url: null };
  if (first.kind === 'foreign' || first.kind === 'timeout') {
    const why = first.status ? `HTTP ${first.status}` : (first.reason || '无响应');
    throw new Error(
      `端口 ${port} 上有进程在监听但不是 dsh 网页后台（${why}）。\n`
      + `  本功能只复用「GET / 返 401/403」的 dsh；端口被别的服务占用时不会硬起。\n`
      + `  请先腾出该端口，或用 AWF_DSH_WEB_PORT 指定别的端口后重新 awf plugin install。`,
    );
  }

  // 没起 → 拉起。日志落项目 .awf/logs/，便于当场排查
  let logPath = null;
  let fd = 'ignore';
  if (logDir) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      logPath = path.join(logDir, 'dsh-web.log');
      fd = fs.openSync(logPath, 'a');
    } catch { fd = 'ignore'; logPath = null; } // 日志写不了不影响起服务
  }

  let proc;
  try {
    proc = spawnFn('dsh', dshArgs(prof, port), {
      stdio: ['ignore', fd, fd],
      detached: true,
      env: process.env,
    });
  } catch (err) {
    if (typeof fd === 'number') { try { fs.closeSync(fd); } catch { /* 已关 */ } }
    throw new Error(`拉起 dsh 网页后台失败：${err.message}（dsh 在 PATH 里吗？）`);
  }
  proc.unref?.();
  if (typeof fd === 'number') { try { fs.closeSync(fd); } catch { /* 已关 */ } }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleepFn(POLL_MS);
    const p = await probeFn(port);
    if (p.kind === 'dsh') return { reused: false, started: true, port, profile: prof, logPath, url: null };
  }
  throw new Error(
    `dsh 网页后台启动超时（${timeoutMs}ms，端口 ${port}）`
    + (logPath ? `\n  看日志：${logPath}` : '')
    + '\n  手动起一次看报错：' + `dsh ${dshArgs(prof, port).join(' ')}`,
  );
}

module.exports = {
  ensureWeb,
  probe,
  dshArgs,
  webPortOf,
  profileOf,
  DEFAULT_WEB_PORT,
  DEFAULT_PROFILE,
  READY_TIMEOUT_MS,
};
