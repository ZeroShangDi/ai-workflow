/**
 * features/index.js — 独立功能的统一出口
 *
 * `features/` 的**准入规则**（一句话）：**SDD 正常流程之外的处理**。
 *   - 正常流程是：plan 建任务 → 按任务执行（调度、派发、阶段链、收尾协商）—— 那些在 `run/`。
 *   - 这里装的是「出了岔子 / 需要额外处理」时才会走上的路径：
 *       context     上下文要满时压缩交接
 *       decision    需要判断而 AI 不该自决时
 *       replanning  计划本身有缺口时
 *       gate        任务结果不合格时
 *       pause       人强行中断/恢复编排
 *       monitor     编排卡住时的检测与介入
 *
 * 每个 feature 都有**自己的协议**（谁在什么条件下做什么、上限多少、失败怎么办），
 * 而不是「一段流程里的顺序代码」—— 这是它区别于 `run/` 的判据。
 *
 * 本文件只是出口聚合：让消费方 `require('.../features/index.js')` 一次拿到全部，
 * 不必逐个知道子目录路径。各 feature 的内部实现仍归各自目录。
 *
 * 注意 ESM/CJS 混用：本文件是 ESM（.js），子模块多为 CJS（.cjs）。
 * CJS 侧一律用 **default import**（具名导入依赖 cjs-module-lexer 的静态分析，易踩坑）。
 */

import context from './context/compaction.cjs';
import decision from './decision/handler.cjs';
import gateLoop from './gate/loop.cjs';
import * as gateFix from './gate/fix.js';
import * as gateClosure from './gate/closure.js';
import * as pause from './pause/index.js';
import monitor from './monitor/index.cjs';
import replanning from './replanning/index.cjs';

/** 上下文压缩与接力：{ createContextCompactor, formatContextUsage, COMPACTION } */
export { context };
/** 决策门阀编排：{ createDecisionHandler, appendDecisionReviewTask } */
export { decision };
/** 门禁闭环：{ handleGateCompletion }（fix）+ { buildFixTarget, verdictSummary }（loop）+ { gateFixMeta, spawnGateFixTask, spawnGateFixTaskAtomic, MAX_RECHECK }（closure） */
export const gate = { ...gateFix, ...gateLoop, ...gateClosure };
/** pause 闩锁：{ waitWhilePaused, isWorkflowPaused, formatWait, PAUSE_POLL_MS, PAUSE_ALERT_MS, PAUSE_HEARTBEAT_MS } */
export { pause };
/** 介入（编排异常时）：createMonitor({ ctx, session, observability }) → { diagnose, reconcile, inspect } */
export { monitor };
/** 动态任务规划：config / planner / service / store / decision-port 的合并面 */
export { replanning };
