import { configFilePath } from '../shared/project-paths.cjs'; // .awf 布局单源
import { readJsonFile } from '../shared/config-loader.cjs';

/**
 * run 运行时配置 — 读 .awf/config.json 的 run.* 段
 *
 * 唯一入口：loadRunConfig(projectRoot)。
 * 约定：run.agents 四级并行配额，全部缺省时 max:1 = 现状单任务串行，零行为变化。
 *
 * 边界：只读 `run.agents`（编排配额，本模块的变化轴）。`run.decision.enabled` **不在这里** ——
 * 那是 decision 能力的开关，由 features/decision 自己判定，运行期经 ctx.decisionEnabled() 取
 * （见 runtime/project.cjs）。此前这里顺带返回了 decision 段：既是无人消费的死字段，又让 run 的
 * 配额加载器背上 decision 的变化轴。
 */

const DEFAULT_AGENTS = {
  max: 1,          // 总并发子 Agent 数
  maxModules: 1,   // 同时活跃模块数
  maxPerModule: 1, // 每模块并发任务数
  maxPerFeature: 1, // 每功能并发任务数
};

/** 归一化 agents 配置：非法/缺省值回落到默认（正整数 ≥ 1） */
function normalizeAgents(src = {}) {
  const out = { ...DEFAULT_AGENTS }; // 先铺默认，再逐键覆盖，保证任一键缺失都有兜底
  // 只采信「正整数」；字符串/0/负数/NaN 一律保留默认，避免坏配置漏进调度器的配额计算
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
  // 缺失 / 非法 JSON → null → 用默认；读取形状归 config-loader（与另两个配置读者同一原语）
  const raw = readJsonFile(configFilePath(projectRoot), { optional: true }) || {};
  return { agents: normalizeAgents(raw?.run?.agents) };
}
