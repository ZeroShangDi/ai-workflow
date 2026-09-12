'use strict';
/**
 * observability/metrics.cjs — 运行指标采集（横切；只读观察）
 *
 * 职责：把散落的运行事实汇聚成**一份只读指标快照**，供 `/awf/metrics` 接口与诊断提示词消费。
 *       不参与任何编排决策 —— 它只看，不判、不改业务状态。
 *
 * 数据来源（全是别人的产物，本模块只读）：
 *   - state.json    → mode / currentState（以及 startedAt 的兜底来源）
 *   - usage.json    → statusline 实测的上下文占用（context_window_size / used_percentage …）
 *   - run-meta.json → 本 run 的 startedAt/endedAt/mainSessionId/subagents（见下「观测产物」）
 *   - cc transcript → 各会话 ~/.claude/projects/<slug>/<sessionId>.jsonl，逐条 assistant usage 累加
 *   - config.json   → run.agents.max（判定单/多 agent 与 token 覆盖率）
 *
 * 「观测产物」：run-meta.json 是观测面唯一写目标之一（由 index.cjs 的 reconcileDiagnosisSession
 * 与 api 的 run 收尾写），记录本 run 的身份与子 agent 清单，本身不是业务状态。
 *
 * 缓存：本文件**不做缓存**；对外 1s 缓存由调用方 observability/index.cjs 的 metricsCache 承担
 *       （因为采集要遍历并解析整份 transcript，比较贵）。
 * 并发：run-meta 经 store 层 JsonFileStore 原子写；写者只有 server 一处，故不取跨进程锁。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
// run-meta 读写归位 store（JsonFileStore 原子写）；usage/config/transcript 解析仍走本地 readJson
const store = require('../core/store.cjs');

const RUN_META_PATH = ['.awf', 'logs', 'run-meta.json'];
const CONTEXT_USAGE_PATH = ['.awf', 'context', 'usage.json'];
const CONFIG_PATH = ['.awf', 'config.json'];
const RECENT_WINDOW_MS = 60 * 1000;

/** 容错读 JSON：文件缺失 / 半截 / 非法 → null。观测面不能因为读不到数据就抛断主流程。 */
function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/** run-meta.json 的绝对路径（<root>/.awf/logs/run-meta.json） */
function runMetaFile(projectRoot) {
  return path.join(projectRoot, ...RUN_META_PATH);
}

/** run-meta store（JsonFileStore：原子写，无需跨进程锁——单写者 server） */
function metaStore(projectRoot) {
  return store.createJsonFileStore({ filePath: runMetaFile(projectRoot) });
}

/**
 * 读改写 run-meta。
 * @param {Function} updater 收到当前值（浅拷贝），返回新对象 → 整份写回；返回假值 → 保留原值
 * @returns {object} 实际落盘的 meta
 */
function updateRunMeta(projectRoot, updater) {
  const prev = metaStore(projectRoot).readSync() || {};
  const next = updater({ ...prev }) || prev;
  metaStore(projectRoot).writeSync(next);
  return next;
}

/** 复位 run-meta 为「未开始」初值（每次 run 启动时清掉上一次 run 的残留身份/子 agent 清单） */
function resetRunMeta(projectRoot) {
  return updateRunMeta(projectRoot, () => ({
    projectRoot,
    startedAt: null,
    endedAt: null,
    mainSessionId: null,
    subagents: {},
    updatedAt: new Date().toISOString(),
  }));
}

/** 读 run-meta；缺失 → 空对象（调用方无需判空） */
function readRunMeta(projectRoot) {
  return metaStore(projectRoot).readSync() || {};
}

/** statusline 写入的实测上下文占用（.awf/context/usage.json）；缺失 → {} */
function readContextUsage(projectRoot) {
  return readJson(path.join(projectRoot, ...CONTEXT_USAGE_PATH)) || {};
}

/** 项目 config.json（含 run.agents 配额）；缺失 → {} */
function readConfig(projectRoot) {
  return readJson(path.join(projectRoot, ...CONFIG_PATH)) || {};
}

/** 把项目根路径编码成 cc 的项目 slug（cc 用「路径里 '/' 换 '-'」命名 ~/.claude/projects 下的目录） */
function projectSlug(projectRoot) {
  return path.resolve(projectRoot).replace(/\//g, '-');
}

/** 主会话 transcript 的绝对路径；无 sessionId → null（无从定位） */
function mainTranscriptPath(projectRoot, sessionId) {
  if (!sessionId) return null;
  return path.join(os.homedir(), '.claude', 'projects', projectSlug(projectRoot), `${sessionId}.jsonl`);
}

/** 数值兜底：非有限数字一律算 0 */
function parseNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 时间戳兜底：ISO 字符串 → 毫秒；无法解析 → null */
function parseTimestamp(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 解析**一份** transcript jsonl，累加 token 用量与时间边界。
 *
 * 关键点：
 *   - 只统计 `type === 'assistant'` 且带 usage 的消息；同一 message.id（或 uuid）只计一次 ——
 *     cc 会把流式增量落成多行，不去重会把 token 重复累加。
 *   - `type === 'cost-state'` 行携带 startTime，只用来抬早 startTimeMs，不计 token。
 *   - recent* 字段只统计最近 RECENT_WINDOW_MS（60s）内的输出 token，用于算「当前速度」；
 *     recentOldestTs 是这窗口内最早一条的时间，用来还原窗口实际跨度。
 *
 * @param {string} filePath transcript 绝对路径
 * @param {number} nowMs 当前时刻（由调用方传入，便于测试固定时间）
 */
function parseTranscript(filePath, nowMs) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      filePath,
      exists: false,
      totals: {},
      recentOutputTokens: 0,
      recentOldestTs: null,
      usageMessages: 0,
      startTimeMs: null,
      lastMessageTs: null,
    };
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const seenMessages = new Set();
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  let recentOutputTokens = 0;
  let recentOldestTs = null;
  let usageMessages = 0;
  let startTimeMs = null;
  let lastMessageTs = null;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === 'cost-state') {
      const costStart = typeof entry.startTime === 'number' ? entry.startTime : null;
      if (costStart && (!startTimeMs || costStart < startTimeMs)) startTimeMs = costStart;
      continue;
    }

    if (entry.type !== 'assistant') continue;
    const msgId = entry.message?.id || entry.uuid;
    if (!msgId || seenMessages.has(msgId)) continue;
    seenMessages.add(msgId);

    const usage = entry.message?.usage;
    if (!usage || typeof usage !== 'object') continue;

    usageMessages += 1;
    totals.inputTokens += parseNumber(usage.input_tokens);
    totals.outputTokens += parseNumber(usage.output_tokens);
    totals.cacheReadInputTokens += parseNumber(usage.cache_read_input_tokens);
    totals.cacheCreationInputTokens += parseNumber(usage.cache_creation_input_tokens);

    const ts = parseTimestamp(entry.timestamp);
    if (ts) {
      if (!startTimeMs || ts < startTimeMs) startTimeMs = ts;
      if (!lastMessageTs || ts > lastMessageTs) lastMessageTs = ts;
      if (nowMs - ts <= RECENT_WINDOW_MS) {
        recentOutputTokens += parseNumber(usage.output_tokens);
        if (!recentOldestTs || ts < recentOldestTs) recentOldestTs = ts;
      }
    }
  }

  return {
    filePath,
    exists: true,
    totals,
    recentOutputTokens,
    recentOldestTs,
    usageMessages,
    startTimeMs,
    lastMessageTs,
  };
}

/**
 * 推导 run 起始时刻（毫秒），按可信度降级取：
 *   ① run-meta.startedAt（最权威，run 启动时写入）
 *   ② transcript 最早时间（meta 缺失时用，如中途接管的旧 run）
 *   ③ state 里各 task 最早的 exec.startedAt（前两者都没有时的最后兜底）
 */
function deriveStartedAtMs(meta, state, aggregate) {
  const fromMeta = parseTimestamp(meta.startedAt);
  if (fromMeta) return fromMeta;
  if (aggregate.startTimeMs) return aggregate.startTimeMs;

  const taskTimes = (state?.tasks || [])
    .map((task) => parseTimestamp(task?.exec?.startedAt))
    .filter((value) => Number.isFinite(value));
  if (taskTimes.length > 0) return Math.min(...taskTimes);

  return null;
}

/**
 * 推导 run 结束时刻（毫秒）：
 *   - run-meta.endedAt 优先（收尾时写入）；
 *   - 否则若 state.mode === 'idle'（进程已退出、run 确已收尾），用 state.lastUpdated 兜底 ——
 *     这样「已结束但没写 endedAt」的 run 也能算出一段有限的 elapsed，而不是一直增长。
 *   - 否则 null（run 仍在进行中）。
 */
function deriveEndedAtMs(meta, state) {
  const fromMeta = parseTimestamp(meta.endedAt);
  if (fromMeta) return fromMeta;

  // AWF persists the final state timestamp even when the process has exited.
  if (state?.mode === 'idle') return parseTimestamp(state.lastUpdated);

  return null;
}

/**
 * 采集一份运行指标快照（详见文件头「数据来源」）。
 *
 * @param {string} projectRoot 项目根
 * @param {{ nowMs?: number, mainSessionId?: string, activeAgents?: number }} [runtime]
 *   nowMs          当前时刻（缺省 Date.now；测试可固定）
 *   mainSessionId  主会话 id；缺省回落 run-meta.mainSessionId（诊断重建会话时会替换）
 *   activeAgents   正在运行的子 agent 数；缺省用 run-meta.subagents 里 status==='running' 计数
 *                  （index.cjs 传的是内存观测 Map 里的实时计数，更准）
 * @returns {object} 指标对象：agentMode/activeAgents/tokens/outputSpeed/context/sources/state
 */
function readRunMetrics(projectRoot, runtime = {}) {
  const nowMs = typeof runtime.nowMs === 'number' ? runtime.nowMs : Date.now();
  const state = readJson(path.join(projectRoot, '.awf', 'state.json')) || {};
  const usage = readContextUsage(projectRoot);
  const meta = readRunMeta(projectRoot);
  const cfg = readConfig(projectRoot);
  const maxAgents = Math.max(1, Number(cfg?.run?.agents?.max) || 1);
  const subagents = meta.subagents || {};
  const activeAgents = Number.isFinite(runtime.activeAgents)
    ? runtime.activeAgents
    : Object.values(subagents).filter((item) => item?.status === 'running').length;
  const mainSessionId = runtime.mainSessionId || meta.mainSessionId || null;

  // 汇总要解析的 transcript：主会话 + 每个已知子 agent（去重后逐份解析）
  const transcriptPaths = [];
  const mainPath = mainTranscriptPath(projectRoot, mainSessionId);
  if (mainPath) transcriptPaths.push(mainPath);
  for (const agent of Object.values(subagents)) {
    if (agent?.transcriptPath) transcriptPaths.push(agent.transcriptPath);
  }

  const uniquePaths = [...new Set(transcriptPaths)];
  const transcriptStats = uniquePaths.map((filePath) => parseTranscript(filePath, nowMs));

  // 跨 transcript 聚合：token 求和、时间取并集边界（最早 start / 最晚 last / 最近窗口内最早）
  const aggregate = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    recentOutputTokens: 0,
    recentOldestTs: null,
    usageMessages: 0,
    startTimeMs: null,
    lastMessageTs: null,
  };

  for (const stat of transcriptStats) {
    aggregate.inputTokens += stat.totals.inputTokens || 0;
    aggregate.outputTokens += stat.totals.outputTokens || 0;
    aggregate.cacheReadInputTokens += stat.totals.cacheReadInputTokens || 0;
    aggregate.cacheCreationInputTokens += stat.totals.cacheCreationInputTokens || 0;
    aggregate.recentOutputTokens += stat.recentOutputTokens || 0;
    aggregate.usageMessages += stat.usageMessages || 0;
    if (stat.recentOldestTs && (!aggregate.recentOldestTs || stat.recentOldestTs < aggregate.recentOldestTs)) {
      aggregate.recentOldestTs = stat.recentOldestTs;
    }
    if (stat.startTimeMs && (!aggregate.startTimeMs || stat.startTimeMs < aggregate.startTimeMs)) {
      aggregate.startTimeMs = stat.startTimeMs;
    }
    if (stat.lastMessageTs && (!aggregate.lastMessageTs || stat.lastMessageTs > aggregate.lastMessageTs)) {
      aggregate.lastMessageTs = stat.lastMessageTs;
    }
  }

  const startedAtMs = deriveStartedAtMs(meta, state, aggregate);
  const endedAtMs = deriveEndedAtMs(meta, state);
  // 已结束的 run 用 endedAt 当观察终点（elapsed 定格不再增长）；进行中的用 now。
  const observedAtMs = endedAtMs || nowMs;
  const elapsedMs = startedAtMs ? Math.max(0, observedAtMs - startedAtMs) : null;
  // 最近窗口实际跨度：以窗口内最早一条为起点，至少 1s（防 0 除）。
  const recentObservedSeconds = aggregate.recentOldestTs
    ? Math.max(1, Math.round((nowMs - aggregate.recentOldestTs) / 1000))
    : null;
  const avgObservedSeconds = elapsedMs ? Math.max(1, Math.round(elapsedMs / 1000)) : null;
  // 近期速度：窗口内输出 token / min(60, 实际跨度)。取 min 是因为「最近一条距今很近」时
  // 分母会远小于 60s，直接除会得到虚高的瞬时速度。
  const recentTokensPerSecond = aggregate.recentOutputTokens > 0 && recentObservedSeconds
    ? aggregate.recentOutputTokens / Math.min(60, recentObservedSeconds)
    : null;
  // 全程均速：总输出 token / 总 elapsed
  const avgTokensPerSecond = aggregate.outputTokens > 0 && avgObservedSeconds
    ? aggregate.outputTokens / avgObservedSeconds
    : null;
  // 是否多 agent：配了 max>1、或已有子 agent、或有活跃子 agent，任一成立即算。
  const isMultiAgent = maxAgents > 1 || Object.keys(subagents).length > 0 || activeAgents > 0;
  const knownSubagents = Object.values(subagents);
  const missingSubagentTranscripts = knownSubagents.filter((item) => !item?.transcriptPath).length;

  // token 覆盖率（判断 tokens 总量是否可信）：
  //   none   —— 一条 usage 都没解析到（transcript 不可读/未产生）
  //   exact  —— 单 agent；或多 agent 但全部子 agent 已结束且都有 transcript（快照完整）
  //   partial—— 多 agent 且有子 agent 还在跑 / 有子 agent 缺 transcript（总量偏小，只可信下限）
  let tokenCoverage = 'none';
  if (aggregate.usageMessages > 0) {
    if (!isMultiAgent) tokenCoverage = 'exact';
    else tokenCoverage = activeAgents === 0 && missingSubagentTranscripts === 0 ? 'exact' : 'partial';
  }

  // usage.json 由 statusline 写；无 statusline 时这两个值为 null（前端应显示未知而非 0）
  const contextWindowSize = parseNumber(usage.context_window_size) || null;
  const totalInputTokens = parseNumber(usage.total_input_tokens) || null;

  return {
    agentMode: isMultiAgent ? 'multi' : 'single',
    activeAgents,
    maxAgents,
    startedAt: startedAtMs ? new Date(startedAtMs).toISOString() : null,
    endedAt: endedAtMs ? new Date(endedAtMs).toISOString() : null,
    elapsedMs,
    tokens: {
      total: aggregate.inputTokens + aggregate.outputTokens,
      input: aggregate.inputTokens,
      output: aggregate.outputTokens,
      cacheReadInput: aggregate.cacheReadInputTokens,
      cacheCreationInput: aggregate.cacheCreationInputTokens,
      coverage: tokenCoverage,
      coveredTranscripts: transcriptStats.filter((item) => item.exists && item.usageMessages > 0).length,
      totalTranscripts: uniquePaths.length,
      missingSubagentTranscripts,
    },
    outputSpeed: {
      currentTokensPerSecond: recentTokensPerSecond,
      averageTokensPerSecond: avgTokensPerSecond,
      basis: recentTokensPerSecond !== null ? 'recent_60s' : avgTokensPerSecond !== null ? 'average' : 'none',
      recentWindowSeconds: 60,
    },
    context: {
      usedPercentage: typeof usage.used_percentage === 'number' ? usage.used_percentage : null,
      remainingPercentage: typeof usage.remaining_percentage === 'number' ? usage.remaining_percentage : null,
      contextWindowSize,
      totalInputTokens,
      ratio: contextWindowSize && totalInputTokens ? totalInputTokens / contextWindowSize : null,
      updatedAt: usage.updatedAt || null,
    },
    sources: {
      mainSessionId,
      mainTranscriptPath: mainPath,
      subagentCount: knownSubagents.length,
      transcriptPaths: uniquePaths,
    },
    state: {
      mode: state.mode || null,
      currentPhase: state.currentState || null,
    },
  };
}

module.exports = {
  readRunMetrics,
  readRunMeta,
  resetRunMeta,
  updateRunMeta,
  mainTranscriptPath, // 主会话 transcript 绝对路径（收尾协商的「本轮有无产出」探测用）
};
