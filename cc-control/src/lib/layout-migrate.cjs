'use strict';
/**
 * layout-migrate.cjs — 旧布局兼容读 + 完整迁移器（承接 W1-014 migrate 的内容迁移，落盘到每 run 布局）
 *
 * 背景：地基从「单 run 现行布局」（state.json/.awf 根、.awf/logs/<version>-<ts>/、.awf/decisions/runs/）
 * 演进到「每 run 布局 .awf/runs/<sid>/」（W1-018）。本模块提供：
 *   1. 兼容读：读 state 时自动识别布局——优先 runs/<sid>/state.json，回退 .awf/state.json（旧），
 *      内容按 schema 版本迁移（migrateState，承接 W1-014/016）。
 *   2. 完整迁移器：为指定 run(sid) 把旧布局 state 复制到 .awf/runs/<sid>/state.json（非破坏，
 *      默认保留旧文件），并在写前做 schema 版本升级。
 *   3. 旧 artifacts 只读列举：.awf/logs/*（历史 run 日志目录）、.awf/decisions/runs/*.jsonl（历史决策）。
 *
 * 安全约定：默认 copy（不动旧文件）——本模块可能被接入 run 启动流程（后续 driver/host），
 * 绝不会自动移动正在被写入的 live state；显式 destructive 才删除旧文件。纯路径/读写，不改 schema。
 */

const fs = require('node:fs');
const path = require('node:path');
const storeCore = require('./store-core.cjs');
const { migrateState } = require('./migrate.cjs');

function awfDir(projectRoot) {
  return path.join(projectRoot, '.awf');
}

function runStateFile(projectRoot, sid) {
  return path.join(awfDir(projectRoot), 'runs', sid, 'state.json');
}

/**
 * 解析 state 文件：优先每 run 布局，回退旧布局。
 * @returns {{ file: string, layout: 'run'|'legacy'|'none' }}
 */
function resolveStateFile({ projectRoot, sid }) {
  if (sid) {
    const runFile = runStateFile(projectRoot, sid);
    if (fs.existsSync(runFile)) return { file: runFile, layout: 'run' };
  }
  const legacy = path.join(awfDir(projectRoot), 'state.json');
  if (fs.existsSync(legacy)) return { file: legacy, layout: 'legacy' };
  return { file: sid ? runStateFile(projectRoot, sid) : legacy, layout: 'none' };
}

/**
 * 兼容读：读 state（按布局解析）+ schema 版本迁移。
 * @returns {{ state: object|null, file: string, layout: 'run'|'legacy'|'none', migrated: boolean, applied: string[] }}
 */
function readStateCompat({ projectRoot, sid }) {
  const { file, layout } = resolveStateFile({ projectRoot, sid });
  const raw = storeCore.readJsonSync(file);
  if (!raw) return { state: null, file, layout, migrated: false, applied: [] };
  const { state, applied } = migrateState(raw);
  return { state, file, layout, migrated: applied.length > 0, applied };
}

/**
 * 完整迁移器：把旧布局 state 落到 runs/<sid>/state.json（写前 schema 迁移，原子写）。
 *   - 目标已存在 → { action: 'exists' }（幂等，不覆盖）
 *   - 旧布局存在 → 复制并升级 → { action: 'copied' }（默认保留旧文件）
 *   - 均不存在 → { action: 'none' }
 * @param {{ projectRoot: string, sid: string, destructive?: boolean }} input
 */
function migrateStateToRun({ projectRoot, sid, destructive = false }) {
  const target = runStateFile(projectRoot, sid);
  if (fs.existsSync(target)) return { action: 'exists', file: target };
  const legacy = path.join(awfDir(projectRoot), 'state.json');
  if (!fs.existsSync(legacy)) return { action: 'none', file: target };

  const raw = storeCore.readJsonSync(legacy);
  if (!raw) return { action: 'none', file: target, reason: 'legacy state unreadable' };
  const { state, applied } = migrateState(raw);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  storeCore.writeJsonAtomicSync(target, state);
  if (destructive) fs.unlinkSync(legacy);
  return { action: 'copied', file: target, migratedSchema: applied, destructive };
}

/** 旧布局历史 run 日志目录：.awf/logs/<dir>/（倒序，最新在前）；空 → [] */
function listLegacyLogDirs(projectRoot) {
  const dir = path.join(awfDir(projectRoot), 'logs');
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch { /* 缺失 */ }
  return names.sort().reverse();
}

/** 旧布局历史决策文件：.awf/decisions/runs/*.jsonl（倒序）；空 → [] */
function listLegacyDecisionFiles(projectRoot) {
  const dir = path.join(awfDir(projectRoot), 'decisions', 'runs');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch { /* 缺失 */ }
  return names.sort().reverse();
}

module.exports = {
  resolveStateFile,
  readStateCompat,
  migrateStateToRun,
  listLegacyLogDirs,
  listLegacyDecisionFiles,
};
