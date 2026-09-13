/**
 * harness/session-env.mjs — 读 run 会话（tmux 里的 claude 进程）的 CC_* / AWF_* 环境
 *
 * 两个 runner 都要这个事实（`sessionEnvPointsAt` 断言：派生会话的 env 必须指向本项目，
 * 否则 hook 网关会把事件投到别人的项目槽 —— 真机踩过），故收在这里一份。
 *
 * ## 为什么不是 `tmux show-environment`
 * bootstrap 是用命令前缀 `env CC_SESSION=… claude …` 注入身份的，那些变量在**进程环境**里，
 * 不在 tmux 的会话环境里 —— `show-environment` 查不到。
 *
 * ## 为什么必须在 run **进行中**取
 * run 一收尾，CLI 就把会话关了；事后读只会拿到空。
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

/** 直接子进程 pid 列表（无 → []） */
export function childrenOf(pid) {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** 单进程的 CC_ / AWF_ 前缀 env（`ps eww` 在命令后平铺 env；失败 → null） */
export function envOfPid(pid) {
  try {
    const out = execFileSync('ps', ['eww', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const env = {};
    for (const tok of out.split(/\s+/)) {
      const m = /^(CC_[A-Z_]+|AWF_[A-Z_]+)=(.*)$/.exec(tok);
      if (m) env[m[1]] = m[2];
    }
    return Object.keys(env).length ? env : null;
  } catch {
    return null;
  }
}

/**
 * 取 tmux 会话内 claude 进程的 CC_* env（pane pid 及其后代，广度有界）。
 * 逐层下钻而不是只看 pane pid：claude 常是 shell 的子进程。
 * @returns {object} 命中 CC_SESSION 的那层 env；没命中 → {}
 */
export function sessionEnvOf(session) {
  let root = null;
  try {
    root = execFileSync('tmux', ['list-panes', '-t', session, '-F', '#{pane_pid}'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], // 会话不存在时 tmux 会往 stderr 喊，静音
    }).trim().split('\n')[0];
  } catch {
    return {};
  }
  if (!root) return {};

  const queue = [{ pid: root, depth: 0 }];
  const seen = new Set();
  while (queue.length) {
    const { pid, depth } = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const env = envOfPid(pid);
    if (env?.CC_SESSION) return env;
    if (depth < 3) for (const c of childrenOf(pid)) queue.push({ pid: c, depth: depth + 1 });
  }
  return {};
}

/** 轮询等会话内 claude 起来并取到 env（会话在 run 结束时被关，必须在 run 期间取） */
export async function probeSessionEnv(session, { timeoutMs = 120000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const env = sessionEnvOf(session);
    if (env.CC_SESSION) return { session, env };
    if (Date.now() > deadline) return { session, env: {} };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** 会话 env 是否指向本项目（CC_PROJECT / CC_WORKDIR 皆为该项目根，与 ensureSession 同取 realpath） */
export function envPointsAt(env, projectRoot) {
  const real = fs.realpathSync(projectRoot);
  return env.CC_PROJECT === real && env.CC_WORKDIR === real;
}
