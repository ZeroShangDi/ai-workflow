'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const RUN_META_PATH = ['.awf', 'logs', 'run-meta.json'];
const CONTEXT_USAGE_PATH = ['.awf', 'context', 'usage.json'];
const CONFIG_PATH = ['.awf', 'config.json'];
const RECENT_WINDOW_MS = 60 * 1000;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function runMetaFile(projectRoot) {
  return path.join(projectRoot, ...RUN_META_PATH);
}

function updateRunMeta(projectRoot, updater) {
  const file = runMetaFile(projectRoot);
  const prev = readJson(file) || {};
  const next = updater({ ...prev }) || prev;
  ensureDir(file);
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

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

function readRunMeta(projectRoot) {
  return readJson(runMetaFile(projectRoot)) || {};
}

function readContextUsage(projectRoot) {
  return readJson(path.join(projectRoot, ...CONTEXT_USAGE_PATH)) || {};
}

function readConfig(projectRoot) {
  return readJson(path.join(projectRoot, ...CONFIG_PATH)) || {};
}

function projectSlug(projectRoot) {
  return path.resolve(projectRoot).replace(/\//g, '-');
}

function mainTranscriptPath(projectRoot, sessionId) {
  if (!sessionId) return null;
  return path.join(os.homedir(), '.claude', 'projects', projectSlug(projectRoot), `${sessionId}.jsonl`);
}

function parseNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseTimestamp(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

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

function deriveEndedAtMs(meta, state) {
  const fromMeta = parseTimestamp(meta.endedAt);
  if (fromMeta) return fromMeta;

  // AWF persists the final state timestamp even when the process has exited.
  if (state?.mode === 'idle') return parseTimestamp(state.lastUpdated);

  return null;
}

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

  const transcriptPaths = [];
  const mainPath = mainTranscriptPath(projectRoot, mainSessionId);
  if (mainPath) transcriptPaths.push(mainPath);
  for (const agent of Object.values(subagents)) {
    if (agent?.transcriptPath) transcriptPaths.push(agent.transcriptPath);
  }

  const uniquePaths = [...new Set(transcriptPaths)];
  const transcriptStats = uniquePaths.map((filePath) => parseTranscript(filePath, nowMs));

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
  const observedAtMs = endedAtMs || nowMs;
  const elapsedMs = startedAtMs ? Math.max(0, observedAtMs - startedAtMs) : null;
  const recentObservedSeconds = aggregate.recentOldestTs
    ? Math.max(1, Math.round((nowMs - aggregate.recentOldestTs) / 1000))
    : null;
  const avgObservedSeconds = elapsedMs ? Math.max(1, Math.round(elapsedMs / 1000)) : null;
  const recentTokensPerSecond = aggregate.recentOutputTokens > 0 && recentObservedSeconds
    ? aggregate.recentOutputTokens / Math.min(60, recentObservedSeconds)
    : null;
  const avgTokensPerSecond = aggregate.outputTokens > 0 && avgObservedSeconds
    ? aggregate.outputTokens / avgObservedSeconds
    : null;
  const isMultiAgent = maxAgents > 1 || Object.keys(subagents).length > 0 || activeAgents > 0;
  const knownSubagents = Object.values(subagents);
  const missingSubagentTranscripts = knownSubagents.filter((item) => !item?.transcriptPath).length;

  let tokenCoverage = 'none';
  if (aggregate.usageMessages > 0) {
    if (!isMultiAgent) tokenCoverage = 'exact';
    else tokenCoverage = activeAgents === 0 && missingSubagentTranscripts === 0 ? 'exact' : 'partial';
  }

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
};
