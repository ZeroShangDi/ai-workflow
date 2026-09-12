'use strict';
/**
 * server-idle.cjs — server 空闲回收判定（纯逻辑，T1-064）
 *
 * 常驻 server 在 run 结束后保留，靠空闲超时自回收。判定仅依赖最近活动时间与超时阈值：
 *   超时 <= 0（或 CC_SERVER_IDLE_MS=0）→ 关闭回收禁用（测试/手动管理）。
 * 端口每次收到请求都会刷新 lastActivityAt（见 server.cjs），因此「有 CLI/看板轮询」即非空闲；
 * 回收侧还需叠加「宿主无 active run」，避免长任务期间无请求误回收。
 */

/** 默认空闲阈值 ms（30min）；env CC_SERVER_IDLE_MS 可覆盖，0 = 禁用 */
const IDLE_MS_DEFAULT = 30 * 60 * 1000;

/** 解析空闲阈值：env CC_SERVER_IDLE_MS 合法且 ≥0 时采用（0 = 禁用回收），否则回落默认 30min */
function idleDefaultMs() {
  const raw = Number(process.env.CC_SERVER_IDLE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : IDLE_MS_DEFAULT;
}

/**
 * 判定「是否已到空闲回收点」。
 * @param {{ now: number, lastActivityAt: number, idleMs: number }} o
 * @returns {boolean} 距最近活动已 >= 阈值；阈值<=0（禁用）或 lastActivityAt 非法时恒 false
 */
function isIdleDue({ now, lastActivityAt, idleMs }) {
  if (!idleMs || idleMs <= 0) return false;
  if (!Number.isFinite(lastActivityAt)) return false;
  return now - lastActivityAt >= idleMs;
}

module.exports = { isIdleDue, idleDefaultMs, IDLE_MS_DEFAULT };
