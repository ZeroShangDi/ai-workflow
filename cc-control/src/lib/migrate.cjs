'use strict';
/**
 * migrate.cjs — state 迁移器骨架（schema 版本：读旧 → 升新）
 *
 * state.json 顶层 `version` 即 schema/工作流版本（单源见 state-schema.STATE_SCHEMA_VERSION）。
 * 读取到 version 缺失或低于当前 schema 版本的旧 state 时，按 MIGRATIONS 注册表顺序逐级升级，
 * 末端统一做结构兜底归一并写回当前版本。
 *
 * 骨架职责：
 *   - needsMigration：判定是否需升级（version 缺失 或 semver 低于当前）
 *   - registerMigration：登记 { id, from, to, up }，供后续真实升级段（T1-019 完整迁移器）扩展
 *   - migrateState：按序执行未到达的升级段 → normalize → 置当前版本；返回 { state, applied }
 *   - readAndMigrate：读文件→升级→（可选写回）→返回，供 store/CLI/server/MCP 读入口统一接入
 *
 * 迁移器只做结构/语义升级，不做业务写入；写回一律经 store-core 原子写（调用方传 write 回调）。
 */

const { STATE_SCHEMA_VERSION } = require('./state-schema.cjs');

/** 注册的升级段：{ id, from, to, up(state) → state }，按登记顺序执行 */
const MIGRATIONS = [];

/**
 * semver 比较（数字段），缺失按 0。支持 x.y 与 x.y.z。
 * @returns 1 表示 a>b；0 相等；-1 表示 a<b
 */
function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** state.version 是否低于 target（或缺失） */
function versionLt(v, target) {
  return compareVersions(v, target) < 0;
}

/** 当前 state 是否需迁移到 STATE_SCHEMA_VERSION */
function needsMigration(state) {
  if (!state || typeof state !== 'object') return false;
  return !state.version || versionLt(state.version, STATE_SCHEMA_VERSION);
}

/** 登记一段迁移（返回 id，便于去重/引用）。 */
function registerMigration(migration) {
  if (!migration || typeof migration.up !== 'function' || !migration.to) {
    throw new Error(`migrate: 非法迁移段（需 up/to）：${JSON.stringify(migration)}`);
  }
  migration.id = migration.id || `${migration.from || '?'}→${migration.to}`;
  MIGRATIONS.push(migration);
  return migration.id;
}

/** 结构兜底归一：保证新读器期望的顶层字段齐备；就地改并返回 */
function normalizeState(state) {
  if (!Array.isArray(state.tasks)) state.tasks = [];
  if (!Array.isArray(state.wbs)) state.wbs = [];
  if (!Array.isArray(state.milestones)) state.milestones = [];
  if (!state.plan || typeof state.plan !== 'object' || Array.isArray(state.plan)) state.plan = {};
  if (typeof state.mode !== 'string') state.mode = 'idle';
  if (typeof state.currentState !== 'string') state.currentState = 'IDLE';
  return state;
}

// ── 骨架基线迁移：旧（0.1.x 及其更早/version 缺失）→ 0.2.0 ──
// 历史 doc-sync 布局字段语义已不可考，基线只做 normalize 兜底 + 版本推进；
// 具体旧布局字段重映射在确证后以 registerMigration 追加真实升级段（T1-019）。
registerMigration({
  id: 'legacy-baseline→0.2.0',
  from: '0.1.0',
  to: STATE_SCHEMA_VERSION,
  up(state) {
    return normalizeState(state);
  },
});

/**
 * 迁移一份 state：逐段升级（当前版本 < 该段 to 才执行）→ 兜底归一 → 置当前版本。
 * @param {object} state
 * @returns {{ state: object, applied: string[] }}
 */
function migrateState(state) {
  if (!state || typeof state !== 'object') return { state, applied: [] };
  const applied = [];
  if (!needsMigration(state)) return { state, applied };
  for (const m of MIGRATIONS) {
    const current = state.version || '0';
    // 只执行「目标 ≤ 当前 schema」的历史升级段；未来目标段（> STATE_SCHEMA_VERSION）
    // 在当前 schema 下不适用——避免应用了 9.0 的变更却把版本写回 0.2.0。
    const reachesCurrent = !versionLt(STATE_SCHEMA_VERSION, m.to);
    if (reachesCurrent && versionLt(current, m.to)) {
      state = m.up(state, m) || state;
      applied.push(m.id);
    }
  }
  state.version = STATE_SCHEMA_VERSION;
  if (!state.lastUpdated) state.lastUpdated = new Date().toISOString();
  return { state, applied };
}

/**
 * 读旧 → 升新：read(statePath) 读原始 state，migrate 后回调 write(newState)（可选原子写回）。
 * 供 store/CLI/server/MCP 读入口统一接入；write 不传则只返回迁移结果不落盘。
 * @param {{ read: Function, write?: Function }} io
 * @returns {{ state: object, migrated: boolean, applied: string[] }}
 */
function readAndMigrate({ read, write }) {
  const raw = read();
  if (!raw) return { state: null, migrated: false, applied: [] };
  const { state, applied } = migrateState(raw);
  const migrated = applied.length > 0;
  if (migrated && write) write(state);
  return { state, migrated, applied };
}

module.exports = {
  STATE_SCHEMA_VERSION,
  MIGRATIONS,
  compareVersions,
  versionLt,
  needsMigration,
  registerMigration,
  normalizeState,
  migrateState,
  readAndMigrate,
};
