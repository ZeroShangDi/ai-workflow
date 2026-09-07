'use strict';
/**
 * persist-pipeline.cjs — 领域日志/usage/metrics 快照落盘管道接口（消费 events）
 *
 * 为 W3-003/004（events 总线 + server 分层）预留的「事件 → store 落盘」管道接缝：
 *   1. createPersistSinks(ctx, opts)：把 store 家族绑定为命名 sink（usage/meta/decision/log/metrics）
 *   2. dispatchEvent(sinks, event)：把归一化领域事件按 type 路由到对应 sink 落盘；未识别返回 false
 *
 * 事件 type 词汇（W1-028 events 总线定型前的最小集）：
 *   - usage.snapshot   → usage json 原子写（.awf/context/usage.json 或 run 布局 context/usage）
 *   - meta.patch       → meta json（updater 载荷直接写，run-meta）
 *   - decision.record  → decision jsonl 追加（当前 runStamp 文件）
 *   - log.append       → 运行日志 main.log 原样追加（文本块）
 *   - metrics.snapshot → metrics json 原子写
 *
 * 约定：sink 内部用 store 层（JsonFileStore/AppendFileStore，原子写/串行队列）；
 * dispatch 是纯路由（不建文件、不持有状态），events 总线接上时把总线事件映射到本 type 即可。
 */

const path = require('node:path');
const store = require('./store.cjs');

/**
 * 绑定 store 家族为命名 sink。
 * @param {object} ctx - run-context 输出（含 runDir/runUsagePath/runMetaPath/decisionsDir/logsDir 等）
 * @param {{ runStamp?: string, logMainPath?: string, metricsPath?: string }} [opts]
 *   runStamp     决策 jsonl 用 runStamp（缺省取 ctx.runDir 名或 'run'）
 *   logMainPath  运行日志 main.log 路径（缺省 ctx.runLogsDir/main.log 或 ctx.logsDir 下待定）
 * @returns {object} sinks
 */
function createPersistSinks(ctx, { runStamp, logMainPath, metricsPath } = {}) {
  const perRun = Boolean(ctx.runDir);
  const usagePath = perRun ? ctx.runUsagePath : ctx.contextUsagePath;
  const decisionDir = perRun ? ctx.runDecisionsDir : ctx.decisionsDir;
  const stamp = runStamp || (ctx.sid ? String(ctx.sid) : 'run');
  const mainLog = logMainPath || path.join(perRun ? ctx.runLogsDir : ctx.logsDir, stamp === 'run' ? 'main.log' : `${stamp}.log`);
  const metrics = metricsPath || path.join(ctx.runMetaPath ? path.dirname(ctx.runMetaPath) : ctx.logsDir, 'metrics.json');

  return {
    usage: store.createJsonFileStore({ filePath: usagePath }),
    meta: store.createJsonFileStore({ filePath: ctx.runMetaPath }),
    decision: store.createAppendFileStore({ filePath: path.join(decisionDir, `${stamp}.jsonl`), json: true }),
    log: store.createAppendFileStore({ filePath: mainLog }),
    metrics: store.createJsonFileStore({ filePath: metrics }),
  };
}

/** 归一化领域事件 → 命名 sink 落盘；未知 type 返回 false */
function dispatchEvent(sinks, event) {
  const { type } = event || {};
  switch (type) {
    case 'usage.snapshot':
      sinks.usage.writeSync(event.payload);
      return 'usage';
    case 'meta.patch':
      // payload 为可序列化对象 → 浅合并进当前 meta（文件缺失则以 payload 建），不携带函数
      sinks.meta.updateSync((s) => {
        if (s) { Object.assign(s, event.payload); return true; }
        return { ...event.payload };
      });
      return 'meta';
    case 'decision.record':
      sinks.decision.appendSync(event.payload);
      return 'decision';
    case 'log.append':
      sinks.log.appendRawSync(event.text);
      return 'log';
    case 'metrics.snapshot':
      sinks.metrics.writeSync(event.payload);
      return 'metrics';
    default:
      return false;
  }
}

module.exports = { createPersistSinks, dispatchEvent };
