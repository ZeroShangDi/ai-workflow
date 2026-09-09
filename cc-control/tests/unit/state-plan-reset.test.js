import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveOldStateForPlan, loadState } from '../../src/lib/state.js';

// T1-104：plan 启动守卫——残留旧 state 归档 + 重置空模板；run 模式不触发；空 state 不重复归档。

function writeState(root, state) {
  fs.mkdirSync(path.join(root, '.awf'), { recursive: true });
  fs.writeFileSync(path.join(root, '.awf', 'state.json'), JSON.stringify(state, null, 2));
}
function listVersions(root) {
  const dir = path.join(root, '.awf', 'versions');
  try { return fs.readdirSync(dir).filter((f) => f.startsWith('state-')); } catch { return []; }
}

describe('archiveOldStateForPlan（plan 启动重置守卫）', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-planreset-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('残留旧 plan（tasks/plan 非空，mode idle）→ 归档 versions/state-<ts>.json + 重置空模板', () => {
    writeState(tmp, {
      mode: 'idle', currentState: 'CODE', version: '0.2.0',
      milestones: [], tasks: [{ id: 'T1', kind: 'dev', status: 'done' }], wbs: [], plan: { summary: '旧' },
    });
    const r = archiveOldStateForPlan(tmp);
    expect(r.action).toBe('archived');
    expect(listVersions(tmp)).toHaveLength(1);
    expect(listVersions(tmp)[0]).toMatch(/^state-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/);

    const cur = loadState(tmp);
    expect(cur.mode).toBe('plan');
    expect(cur.currentState).toBe('PLAN');
    expect(cur.tasks).toEqual([]);
    expect(cur.wbs).toEqual([]);
    expect(cur.plan).toEqual({});
    expect(cur.version).toBe('0.2.0'); // 版本延续

    const archived = JSON.parse(fs.readFileSync(path.join(tmp, '.awf', 'versions', listVersions(tmp)[0]), 'utf-8'));
    expect(archived.tasks).toHaveLength(1); // 原样归档
  });

  it('空 state（无任务/无 plan，模板残留）→ 不归档不重置', () => {
    writeState(tmp, { mode: 'idle', currentState: 'IDLE', version: '0.2.0', milestones: [], tasks: [], wbs: [], plan: {} });
    const r = archiveOldStateForPlan(tmp);
    expect(r.action).toBe('none');
    expect(listVersions(tmp)).toHaveLength(0);
  });

  it('run 模式不触发（mode=run，含残留任务）→ run-active，不动文件', () => {
    writeState(tmp, {
      mode: 'run', currentState: 'CODE', version: '0.2.0',
      milestones: [], tasks: [{ id: 'T1', kind: 'dev', status: 'active' }], wbs: [], plan: {},
    });
    const before = loadState(tmp);
    const r = archiveOldStateForPlan(tmp);
    expect(r.action).toBe('run-active');
    expect(listVersions(tmp)).toHaveLength(0);
    expect(loadState(tmp)).toEqual(before); // 文件未动
  });

  it('state 不存在 → none，不建文件', () => {
    expect(archiveOldStateForPlan(tmp).action).toBe('none');
  });
});
