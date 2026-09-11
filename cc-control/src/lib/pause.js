import { loadState } from './state.js';
import { sleep } from './session/client.js';

export const PAUSE_POLL_MS = 1000;

/** 等待超过此阈值 → 打一次告警（env 可覆盖，便于回归用短阈值验证） */
export const PAUSE_ALERT_MS = envMs('CC_PAUSE_ALERT_MS', 30_000);
/** 告警之后的心跳间隔 */
export const PAUSE_HEARTBEAT_MS = envMs('CC_PAUSE_HEARTBEAT_MS', 60_000);

function envMs(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** 人类可读时长（告警里用；避免读者自己换算毫秒） */
export function formatWait(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}min${String(s % 60).padStart(2, '0')}s`;
}

/** 缺省日志出口：server 的 stdout 在生产被 stdio:'ignore' 丢弃，故调用方应注入项目运行日志 */
function defaultLog(kind, detail) {
  console.error(`[pause][${kind}] ${detail}`);
}

/** 工作流是否被外部控制器暂停。 */
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
    label = 'pause-latch',
    isSettled = null,
    log = defaultLog,
    alertMs = PAUSE_ALERT_MS,
    heartbeatMs = PAUSE_HEARTBEAT_MS,
  } = o;

  if (!isWorkflowPaused(projectRoot)) {
    return { waited: false, releasedBy: null, waitedMs: 0, polls: 0 };
  }

  const t0 = Date.now();
  let polls = 0;
  let alerted = false;
  let lastHeartbeat = t0;

  for (;;) {
    await sleep(pollMs);
    polls += 1;
    const waitedMs = Date.now() - t0;

    if (isSettled && isSettled()) {
      log('warn', `pause 闩锁放行：目标任务已结算，无需再等（已等待 ${formatWait(waitedMs)}，阶段 ${label}，项目 ${projectRoot}）`);
      return { waited: true, releasedBy: 'settled', waitedMs, polls };
    }

    if (!isWorkflowPaused(projectRoot)) {
      log('info', `pause 闩锁放行：mode 已恢复（已等待 ${formatWait(waitedMs)}，阶段 ${label}，项目 ${projectRoot}）`);
      return { waited: true, releasedBy: 'resumed', waitedMs, polls };
    }

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
