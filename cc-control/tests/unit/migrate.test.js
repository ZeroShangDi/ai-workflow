import { describe, it, expect, beforeEach } from 'vitest';
import {
  MIGRATIONS,
  compareVersions,
  versionLt,
  needsMigration,
  registerMigration,
  normalizeState,
  migrateState,
  readAndMigrate,
} from '../../src/lib/migrate.cjs';

// migrate（W1-014 / T1-015）：schema 版本迁移骨架（读旧 → 升新）。
// 每用例前重置 MIGRATIONS 只保留内置基线段，避免用例间互相注册污染。

beforeEach(() => {
  MIGRATIONS.length = 0;
  registerMigration({ id: 'legacy-baseline→0.2.0', from: '0.1.0', to: '0.2.0', up: (s) => normalizeState(s) });
});

describe('compareVersions / versionLt', () => {
  it('数字段逐位比较，缺失按 0', () => {
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1);
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0);
    expect(compareVersions('0.3.0', '0.2.0')).toBe(1);
    expect(compareVersions('0.2', '0.2.0')).toBe(0);
    expect(compareVersions('0.2.1', '0.2')).toBe(1);
    expect(compareVersions('0.1.5', '0.2.0')).toBe(-1);
  });

  it('versionLt', () => {
    expect(versionLt('0.1.0', '0.2.0')).toBe(true);
    expect(versionLt('0.2.0', '0.2.0')).toBe(false);
    expect(versionLt('1.0.0', '0.2.0')).toBe(false);
    expect(versionLt(undefined, '0.2.0')).toBe(true);
  });
});

describe('needsMigration', () => {
  it('version 缺失 / 低于当前 → true；等于当前 → false；非对象 → false', () => {
    expect(needsMigration({})).toBe(true);
    expect(needsMigration({ version: '0.1.0' })).toBe(true);
    expect(needsMigration({ version: '0.2.0' })).toBe(false);
    expect(needsMigration(null)).toBe(false);
  });
});

describe('registerMigration / MIGRATIONS', () => {
  it('缺 up/to 抛错；合法注册返回 id', () => {
    expect(() => registerMigration({ to: 'x' })).toThrowError(/非法迁移段/);
    expect(registerMigration({ to: '0.3.0', up: (s) => s })).toBe('?→0.3.0');
  });
});

describe('normalizeState', () => {
  it('补齐 tasks/wbs/milestones 数组、plan 对象、mode/currentState 默认', () => {
    const s = normalizeState({});
    expect(s.tasks).toEqual([]);
    expect(s.wbs).toEqual([]);
    expect(s.milestones).toEqual([]);
    expect(s.plan).toEqual({});
    expect(s.mode).toBe('idle');
    expect(s.currentState).toBe('IDLE');
  });
});

describe('migrateState — 读旧升新', () => {
  it('旧版本：升到当前 schema + 结构兜底，返回 applied', () => {
    const { state, applied } = migrateState({ version: '0.1.0' });
    expect(state.version).toBe('0.2.0');
    expect(Array.isArray(state.tasks)).toBe(true);
    expect(applied).toContain('legacy-baseline→0.2.0');
  });

  it('缺失版本也迁移并补 lastUpdated', () => {
    const { state, applied } = migrateState({ wbs: [] });
    expect(state.version).toBe('0.2.0');
    expect(applied.length).toBeGreaterThan(0);
    expect(typeof state.lastUpdated).toBe('string');
  });

  it('已最新：幂等，applied 空、不改动', () => {
    const src = { version: '0.2.0', tasks: [{ id: 'T1' }] };
    const { state, applied } = migrateState(src);
    expect(applied).toEqual([]);
    expect(state).toBe(src);
  });

  it('注册的自定义旧→当前段在迁移时执行', () => {
    registerMigration({ id: 'custom', to: '0.2.0', up: (s) => { s.custom = true; return s; } });
    const { state, applied } = migrateState({ version: '0.1.5' });
    expect(state.custom).toBe(true);
    expect(applied).toContain('custom');
  });

  it('未来目标段（>当前 schema）不触发', () => {
    registerMigration({ id: 'future', to: '9.0.0', up: (s) => { s.fut = true; return s; } });
    const { state, applied } = migrateState({ version: '0.1.0' });
    expect(applied).not.toContain('future');
    expect(state.fut).toBeUndefined();
    expect(state.version).toBe('0.2.0');
  });
});

describe('readAndMigrate — 读→升→(写回)', () => {
  it('旧 → 迁移并写回', () => {
    let written = null;
    const r = readAndMigrate({ read: () => ({ version: '0.1.0' }), write: (s) => { written = s; } });
    expect(r.migrated).toBe(true);
    expect(r.applied.length).toBeGreaterThan(0);
    expect(written).not.toBeNull();
    expect(written.version).toBe('0.2.0');
  });

  it('已最新 → 不迁移不写回', () => {
    const write = () => { throw new Error('不应写回'); };
    const r = readAndMigrate({ read: () => ({ version: '0.2.0' }) , write });
    expect(r.migrated).toBe(false);
    expect(r.applied).toEqual([]);
  });

  it('读不到 → 直通 null', () => {
    const r = readAndMigrate({ read: () => null });
    expect(r.state).toBeNull();
    expect(r.migrated).toBe(false);
  });
});
