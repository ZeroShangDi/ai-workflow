import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveStateFile,
  readStateCompat,
  migrateStateToRun,
  listLegacyLogDirs,
  listLegacyDecisionFiles,
} from '../../src/lib/layout-migrate.cjs';

// layout-migrate（W1-019 / T1-025）：旧布局兼容读 + 完整迁移器（承接 W1-014 schema 迁移）。

const tmpDirs = [];
function legacyProject({ version = '0.1.0', extra = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-lm-'));
  tmpDirs.push(root);
  fs.mkdirSync(path.join(root, '.awf', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.awf', 'decisions', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.awf', 'state.json'), JSON.stringify({ version, ...extra }));
  return root;
}

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('resolveStateFile / readStateCompat — 旧布局兼容读', () => {
  it('无 runs：回退 .awf/state.json（legacy）', () => {
    const root = legacyProject();
    const r = resolveStateFile({ projectRoot: root, sid: 'run1' });
    expect(r.layout).toBe('legacy');
    expect(r.file).toBe(path.join(root, '.awf', 'state.json'));
  });

  it('有 runs/<sid>/state.json：优先 run 布局', () => {
    const root = legacyProject();
    const runFile = path.join(root, '.awf', 'runs', 'run1', 'state.json');
    fs.mkdirSync(path.dirname(runFile), { recursive: true });
    fs.writeFileSync(runFile, JSON.stringify({ version: '0.2.0' }));
    const r = resolveStateFile({ projectRoot: root, sid: 'run1' });
    expect(r.layout).toBe('run');
  });

  it('readStateCompat：旧版本读到升 schema（0.2.0）', () => {
    const root = legacyProject({ version: '0.1.0' });
    const { state, layout, migrated } = readStateCompat({ projectRoot: root, sid: 'run1' });
    expect(layout).toBe('legacy');
    expect(state.version).toBe('0.2.0');
    expect(migrated).toBe(true);
  });
});

describe('migrateStateToRun — 完整迁移器', () => {
  it('旧布局 → 复制+升 schema 到 runs/<sid>/state.json（旧文件保留）', () => {
    const root = legacyProject({ version: '0.1.0' });
    const m = migrateStateToRun({ projectRoot: root, sid: 'run1' });
    expect(m.action).toBe('copied');
    expect(m.migratedSchema.length).toBeGreaterThan(0);
    const target = path.join(root, '.awf', 'runs', 'run1', 'state.json');
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).version).toBe('0.2.0');
    expect(fs.existsSync(path.join(root, '.awf', 'state.json'))).toBe(true); // 非破坏
  });

  it('幂等：目标已存在 → exists 不覆盖', () => {
    const root = legacyProject();
    const target = path.join(root, '.awf', 'runs', 'run1', 'state.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ version: '0.2.0', custom: 1 }));
    expect(migrateStateToRun({ projectRoot: root, sid: 'run1' }).action).toBe('exists');
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).custom).toBe(1);
  });

  it('destructive=true 复制后删除旧文件', () => {
    const root = legacyProject();
    migrateStateToRun({ projectRoot: root, sid: 'r', destructive: true });
    expect(fs.existsSync(path.join(root, '.awf', 'state.json'))).toBe(false);
  });

  it('无 state → none', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-lm-none-'));
    tmpDirs.push(root);
    fs.mkdirSync(path.join(root, '.awf'), { recursive: true });
    expect(migrateStateToRun({ projectRoot: root, sid: 'r' }).action).toBe('none');
  });
});

describe('旧 artifacts 列举', () => {
  it('listLegacyLogDirs / listLegacyDecisionFiles 倒序返回；空目录 → []', () => {
    const root = legacyProject();
    fs.mkdirSync(path.join(root, '.awf', 'logs', '0.2.0-2026-09-07T09-00-00'), { recursive: true });
    fs.mkdirSync(path.join(root, '.awf', 'logs', '0.2.0-2026-09-07T10-00-00'), { recursive: true });
    fs.writeFileSync(path.join(root, '.awf', 'decisions', 'runs', 'a.jsonl'), '{}');
    const logs = listLegacyLogDirs(root);
    expect(logs[0]).toBe('0.2.0-2026-09-07T10-00-00');
    expect(listLegacyDecisionFiles(root)).toEqual(['a.jsonl']);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-lm-empty-'));
    tmpDirs.push(empty);
    expect(listLegacyLogDirs(empty)).toEqual([]);
    expect(listLegacyDecisionFiles(empty)).toEqual([]);
  });
});
