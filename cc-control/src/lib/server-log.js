import fs from 'node:fs';
import path from 'node:path';

/**
 * server-log.js — 常驻 server 的输出落盘（T1-112）
 *
 * 背景（2026-09-10 事故）：`spawn('node', [serverScript], { stdio: 'ignore' })` 把 server 的**全部**
 * console 输出丢进了黑洞 —— 宿主卡死时无日志可查，只能靠 transcript 反推才定位到 pause 闩锁。
 * 现在把子进程的 stdout/stderr 接到项目下 `.awf/logs/server.log`（追加），常驻与空闲回收语义不变。
 *
 * 轮转：单代、按 spawn 触发。每次起 server（含空闲回收后重启）先看现有文件是否超上限，
 * 超了就把 `server.log` 改名成 `server.log.1`（覆盖上一代），新文件从空开始。
 * 这样文件不会无限增长，也不会因为写日志而拖慢热路径。
 */

/** 单文件上限（MB）；`CC_SERVER_LOG_MAX_MB` 可覆盖，<=0 表示不轮转 */
export const SERVER_LOG_MAX_MB = (() => {
  const raw = Number(process.env.CC_SERVER_LOG_MAX_MB);
  return Number.isFinite(raw) ? raw : 5;
})();

/** 项目下的 server 输出日志路径 */
export function serverLogPath(logsDir) {
  return path.join(logsDir, 'server.log');
}

/**
 * 打开 server 输出日志（追加）；必要时先轮转。
 * @param {string} logPath
 * @param {{ maxBytes?: number }} [opts]
 * @returns {{ fd: number, path: string, rotated: boolean, close: Function }}
 *   close() 关掉**父进程**这份 fd（子进程已 dup 自己的）；已关闭/无效 fd 不抛。
 */
export function openServerLog(logPath, { maxBytes = SERVER_LOG_MAX_MB * 1024 * 1024 } = {}) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  let rotated = false;
  if (maxBytes > 0) {
    try {
      if (fs.statSync(logPath).size > maxBytes) {
        fs.renameSync(logPath, `${logPath}.1`);
        rotated = true;
      }
    } catch { /* 文件不存在 → 无需轮转 */ }
  }
  const fd = fs.openSync(logPath, 'a');
  return {
    fd, path: logPath, rotated,
    close: () => { try { fs.closeSync(fd); } catch { /* 已关闭 → 无事可做 */ } },
  };
}
