/**
 * pause.js — pause 闩锁（工作流暂停时让调用方原地等待，恢复后自动放行）
 *
 * 职责：提供 isWorkflowPaused（读 state.mode === 'pause'）与 waitWhilePaused（轮询等待，直到
 * mode 不再是 pause 或目标任务已结算）。暂停语义是「外部控制器把 state.mode 置为 pause」→
 * 宿主/执行器在派发与收尾前调 waitWhilePaused，于是整个 run 停摆但不退出；mode 恢复后自动继续。
 *
 * 边界：本模块只读 state、只等待，不写 state、不决定谁该暂停。日志出口由调用方注入——server 的
 * stdout 在生产被 stdio:'ignore' 丢弃，缺省出口仅 console.error，生产必须传 log 才能被人看到。
 * 兼容：waitWhilePaused 仍接受旧的数字签名（pollMs），见函数内注释。
 *
 * 坑（2026-09-10 事故）：早期只在 mode 恢复时才返回，出现「任务其实早已结算、闩锁却仍在等」的
 * 死等，run 静默停摆 4 小时。现引入 isSettled 出口，等待期间必须同时盯「我还要做的事是否已无需做」。
 */

import { loadState } from '../../shared/state.js';

/** 自带的等待原语 —— server 不依赖 cli 的 session/client */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询间隔：每 1s 重新读一次 state.mode（不缓存，保证跨进程改动能被及时观察） */
export const PAUSE_POLL_MS = 1000;

/** 等待超过此阈值 → 打一次告警（env 可覆盖，便于回归用短阈值验证） */
export const PAUSE_ALERT_MS = envMs('CC_PAUSE_ALERT_MS', 30_000);
/** 告警之后的心跳间隔（周期性报「还在等」，避免长时间静默让人以为进程死了） */
export const PAUSE_HEARTBEAT_MS = envMs('CC_PAUSE_HEARTBEAT_MS', 60_000);

/**
 * 从 env 读毫秒数（如 CC_PAUSE_ALERT_MS）；非法（非数字/≤0）→ 用 fallback。
 * @param {string} name 环境变量名
 * @param {number} fallback 缺省值
 * @returns {number}
 */
function envMs(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * 人类可读时长（告警里用；避免读者自己换算毫秒）。
 * <1s → `Nms`；<1min → `Ns`；否则 `MminSSs`（秒补零）。
 * @param {number} ms
 * @returns {string}
 */
export function formatWait(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}min${String(s % 60).padStart(2, '0')}s`;
}

/**
 * 缺省日志出口：server 的 stdout 在生产被 stdio:'ignore' 丢弃，故调用方应注入项目运行日志。
 * 签名 (kind, detail)：kind 为日志级别（info/warn/error），detail 为人类可读文本。
 */
function defaultLog(kind, detail) {
  console.error(`[pause][${kind}] ${detail}`);
}

/** 工作流是否被外部控制器暂停（state.mode === 'pause'；state 读不到 → false）。 */
export function isWorkflowPaused(projectRoot) {
  return loadState(projectRoot)?.mode === 'pause';
}

/**
 * pause 闩锁：暂停期间不返回；mode 恢复为 run（或其他非 pause 值）后自动放行。
 * 不缓存 state，确保 MCP/其他进程对 state.json 的修改能被及时观察。
 *
 * **三条出口**（返回值 `releasedBy` 区分）：
 *   - `null`      ：调用时就没暂停，立即返回
 *   - `'resumed'` ：mode 不再为 pause（正常恢复）
 *   - `'settled'` ：等待期间 `isSettled()` 变真 —— 目标任务已结算，没必要再等闩锁
 *
 * `isSettled` 的由来（2026-09-10 事故）：宿主在 `settleTask(T1-108)` 的 `send()` 里被闩锁
 * **无限期**挂住，期间 T1-108 早已 done，而宿主卡在 send 里回不到自己的状态轮询，看不见。
 * run 静默停摆 4 小时无人察觉。故等待期间必须同时盯着「我还要做的事是否已经不需要做了」。
 *
 * **可观测性**：等待超 `alertMs` 打一次告警（项目根 + `label` = 等待所在阶段），之后每
 * `heartbeatMs` 一条心跳，放行时一条恢复日志。这些是运维信息，须落到人均可读的项目运行日志
 * （`log` 由调用方注入 `pcx.logger.logNotice`）；缺省退化为 console。
 *
 * @param {string} projectRoot
 * @param {{ pollMs?: number, label?: string, isSettled?: Function, log?: Function,
 *           alertMs?: number, heartbeatMs?: number }} [opts]
 * @returns {Promise<{ waited: boolean, releasedBy: 'resumed'|'settled'|null, waitedMs: number, polls: number }>}
 */
export async function waitWhilePaused(projectRoot, opts = {}) {
  // 兼容旧签名 waitWhilePaused(root, pollMs)
  const o = typeof opts === 'number' ? { pollMs: opts } : opts;
  const {
    pollMs = PAUSE_POLL_MS,
    label = 'pause-latch', // 日志里标识「在哪个阶段被闩住」，便于定位
    isSettled = null, // 可选回调：返回 true 表示「调用方要等的结果已经不必等了」
    log = defaultLog,
    alertMs = PAUSE_ALERT_MS,
    heartbeatMs = PAUSE_HEARTBEAT_MS,
  } = o;

  // 快路径：进函数时就没暂停 → 立即返回，不进循环（不做无谓的 sleep 与读盘）
  if (!isWorkflowPaused(projectRoot)) {
    return { waited: false, releasedBy: null, waitedMs: 0, polls: 0 };
  }

  const t0 = Date.now();
  let polls = 0;
  let alerted = false; // 是否已打过一次挂起告警（只打一次，之后走心跳）
  let lastHeartbeat = t0;

  for (;;) {
    // 先 sleep 再判定：保证不会忙等空转，也保证两次读盘之间至少隔一个 pollMs
    await sleep(pollMs);
    polls += 1;
    const waitedMs = Date.now() - t0;

    // 结算出口优先于恢复出口：目标任务已结算时，即便 mode 还没恢复也没必要再等（2026-09-10 事故的补救）
    if (isSettled && isSettled()) {
      log('warn', `pause 闩锁放行：目标任务已结算，无需再等（已等待 ${formatWait(waitedMs)}，阶段 ${label}，项目 ${projectRoot}）`);
      return { waited: true, releasedBy: 'settled', waitedMs, polls };
    }

    // 每次循环都重新读 state（loadState 无缓存），确保别的进程把 mode 改回来时能立刻放行
    if (!isWorkflowPaused(projectRoot)) {
      log('info', `pause 闩锁放行：mode 已恢复（已等待 ${formatWait(waitedMs)}，阶段 ${label}，项目 ${projectRoot}）`);
      return { waited: true, releasedBy: 'resumed', waitedMs, polls };
    }

    // 可观测性：超 alertMs 打一次 error（唯一一次），之后每 heartbeatMs 一条 warn 心跳，避免长时间静默
    if (!alerted && waitedMs >= alertMs) {
      alerted = true;
      lastHeartbeat = Date.now();
      log('error', `pause 闩锁已挂起 ${formatWait(waitedMs)}：阶段 ${label}，项目 ${projectRoot}。`
        + '期间不派发/不收尾任何任务（这是闩锁的预期语义）；若并非有意暂停，'
        + '检查是否有人不带 ?p 误置了 mode=pause（见 .awf/bugs/write-endpoint-missing-p-fell-back-to-boot.md）');
    } else if (alerted && Date.now() - lastHeartbeat >= heartbeatMs) {
      lastHeartbeat = Date.now();
      log('warn', `pause 闩锁心跳：仍在等待（已等待 ${formatWait(waitedMs)}，阶段 ${label}，项目 ${projectRoot}）`);
    }
  }
}
