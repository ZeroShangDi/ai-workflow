import path from 'node:path';
import fs from 'node:fs';

/**
 * run 运行时配置 — 读 .awf/config.json 的 run.* 段
 *
 * 唯一入口：loadRunConfig(projectRoot)。
 * 约定：run.agents 四级并行配额，全部缺省时 max:1 = 现状单任务串行，零行为变化。
 */

const DEFAULT_AGENTS = {
  max: 1,          // 总并发子 Agent 数
  maxModules: 1,   // 同时活跃模块数
  maxPerModule: 1, // 每模块并发任务数
  maxPerFeature: 1, // 每功能并发任务数
};

/** 归一化 agents 配置：非法/缺省值回落到默认（正整数 ≥ 1） */
function normalizeAgents(src = {}) {
  const out = { ...DEFAULT_AGENTS };
  for (const key of Object.keys(DEFAULT_AGENTS)) {
    const v = src[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1) out[key] = v;
  }
  return out;
}

/**
 * 读取 .awf/config.json 的 run.* 段；文件缺失/非法 JSON → 全部用默认值。
 * @param {string} projectRoot - 用户项目根目录（cwd）
 * @returns {{ agents: { max: number, maxModules: number, maxPerModule: number, maxPerFeature: number } }}
 */
export function loadRunConfig(projectRoot) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(projectRoot, '.awf', 'config.json'), 'utf-8'));
  } catch {
    /* 缺失或非法 JSON → 用默认 */
  }
  return { agents: normalizeAgents(raw?.run?.agents) };
}
