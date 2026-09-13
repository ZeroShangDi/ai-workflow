'use strict';
/**
 * project-paths.cjs — **项目 `.awf` 布局的单一知情者**（文件/目录在哪）
 *
 * 「`.awf/` 里东西怎么摆」是**外部形状**（项目目录约定），不是任何功能发明的。它只允许有一个
 * 知情者，否则布局一变就得到处改，而漏改一处**不会报错** —— 那个模块静默读不到文件、回落默认值，
 * 行为悄悄变了。此前 `.awf/config.json` 被 4 个模块各拼一遍、`.awf/logs` 被 4 处、`.awf/context/*`
 * 被 3 处，就是这种漂移的温床。
 *
 * ## 边界（位置 vs 读写语义）
 * 本模块只回答「文件在哪」，不碰怎么读怎么写 —— 容错读、原子写、加锁分别在
 * `store-core.cjs` / `state.js` / `store.cjs`。换布局只动这一个文件，换存储方式也只动一处。
 *
 * ## 为什么是 CJS
 * 消费方横跨 ESM/CJS（`shared/state.js` 是 ESM，`features/replanning/service.cjs` 是 CJS，
 * 后者 require 不了 ESM），故落成 CJS 原语，两端各自 import / require 同一份实现。
 *
 * ## 每 run 分片（T1-018）
 * 现行单 run 布局是 `.awf/state.json`；带 sid 时走 `.awf/runs/<sid>/state.json`。
 * **分片与否由布局决定，故接口带 sid 参数**（`runStateFilePath(root, sid)`）——
 * 调用方不需要知道 `<sid>` 拼在哪一层。
 */

const path = require('node:path');
const { withFileLock } = require('./store-core.cjs');

// ── 根 ──

/** 项目运行态根目录 `<root>/.awf` */
function awfDir(projectRoot) {
  return path.join(projectRoot, '.awf');
}

// ── 现行单 run 布局 ──

/** state.json 绝对路径（无 sid 的现行布局） */
function stateFilePath(projectRoot) {
  return path.join(awfDir(projectRoot), 'state.json');
}

/** state 写锁路径（CLI/MCP/server 共用同名 state.lock，防跨实现并发写） */
function stateLockPath(projectRoot) {
  return path.join(awfDir(projectRoot), 'state.lock');
}

/** 项目 run 配置（run.agents 配额、decision 开关、dynamicPlanning 策略等） */
function configFilePath(projectRoot) {
  return path.join(awfDir(projectRoot), 'config.json');
}

/** run 专用 settings 产物（cc 格式，bootstrap 消费） */
function settingsFilePath(projectRoot) {
  return path.join(awfDir(projectRoot), 'run-settings.json');
}

// ── 每 run 分片布局（T1-018）：.awf/runs/<sid>/ ──

/** 全部 run 分片的父目录 `<root>/.awf/runs` */
function runsDir(projectRoot) {
  return path.join(awfDir(projectRoot), 'runs');
}

/** 某 run 分片的 state.json（**显式分片**；无 sid 的调用方应走 stateFilePath） */
function runStateFilePath(projectRoot, sid) {
  return path.join(runsDir(projectRoot), String(sid), 'state.json');
}

/** 某 run 分片的 state 锁 */
function runStateLockPath(projectRoot, sid) {
  return path.join(runsDir(projectRoot), String(sid), 'state.lock');
}

// ── 观测产物 ──

/** 日志目录 `<root>/.awf/logs`（run 日志 / 子 agent 记录 / run-meta 都在这） */
function logsDir(projectRoot) {
  return path.join(awfDir(projectRoot), 'logs');
}

/** 本 run 的运行元数据（startedAt/endedAt/mainSessionId/subagents） */
function runMetaPath(projectRoot) {
  return path.join(logsDir(projectRoot), 'run-meta.json');
}

// ── 上下文接力 ──

/** 上下文目录 `<root>/.awf/context` */
function contextDir(projectRoot) {
  return path.join(awfDir(projectRoot), 'context');
}

/** statusline 实测的上下文占用（context-usage.mjs 写、指标/压缩检查读） */
function contextUsagePath(projectRoot) {
  return path.join(contextDir(projectRoot), 'usage.json');
}

/** 上下文接力快照（code-context-onboard 写、/clear 前注入） */
function handoffPath(projectRoot) {
  return path.join(contextDir(projectRoot), 'handoff.md');
}

// ── 归档与记录 ──

/** 版本归档目录 `<root>/.awf/versions`（run 收尾 / 重开 plan 时快照 state） */
function versionsDir(projectRoot) {
  return path.join(awfDir(projectRoot), 'versions');
}

/** 决策记录的 run 分文件目录 `<root>/.awf/decisions/runs` */
function decisionsRunsDir(projectRoot) {
  return path.join(awfDir(projectRoot), 'decisions', 'runs');
}

/** 动态规划的 proposal/事件目录 `<root>/.awf/dynamic-planning` */
function dynamicPlanningDir(projectRoot) {
  return path.join(awfDir(projectRoot), 'dynamic-planning');
}

/**
 * 报告目录的**相对前缀**（不是绝对路径）：用于比对任务 exec.files 里记录的产出路径
 * （如门禁修复目标从 `.awf/reports/...` 里挑）。记录下来的就是相对项目根的路径，故此处给前缀而非绝对路径。
 */
const REPORTS_PREFIX = '.awf/reports/';

/**
 * 在 state 锁内执行 fn。给**多步临界区**用：调用方要在同一个临界区里读 state、算、写 state
 * （甚至读写本功能自己的产物），这时用 loadState/saveState 会各锁一次、中间可能被他人插入。
 * 普通单步读改写请用 shared/state.js 的领域原语（markTaskActive / mutateState / replaceStateIfUnchanged）。
 *
 * @param {string} projectRoot
 * @param {Function} fn 临界区函数（返回值原样透出）
 * @param {object} [opts] 透传给 withFileLock（如 timeoutMs）
 * @returns {*} fn 的返回值
 */
function withStateLock(projectRoot, fn, opts) {
  return withFileLock(stateLockPath(projectRoot), fn, opts);
}

module.exports = {
  awfDir,
  stateFilePath,
  stateLockPath,
  configFilePath,
  settingsFilePath,
  runsDir,
  runStateFilePath,
  runStateLockPath,
  logsDir,
  runMetaPath,
  contextDir,
  contextUsagePath,
  handoffPath,
  versionsDir,
  decisionsRunsDir,
  dynamicPlanningDir,
  REPORTS_PREFIX,
  withStateLock,
};
