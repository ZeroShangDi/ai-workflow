import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { handleGateCompletion } from '../../src/cli/gate-fix.js';
import { MAX_RECHECK } from '../../src/lib/state.js';

// handleGateCompletion 用真实 loadState/saveState/spawnGateFixTask（state.js 纯文件 I/O），
// 覆盖「读盘 → 判定 → 派生/回退 → 落盘」全链路。

describe('gate-fix.js — handleGateCompletion（门禁闭环钩子）', () => {
  let tmpDir;

  function writeState(tasks) {
    fs.mkdirSync(path.join(tmpDir, '.awf'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.awf', 'state.json'), JSON.stringify({ mode: 'run', tasks }));
  }
  function readState() {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, '.awf', 'state.json'), 'utf-8'));
  }
  const gate = (overrides = {}) => ({
    id: 'R1', kind: 'review', title: '审查 T1', status: 'blocked',
    deps: ['T1'],
    exec: { verdict: { level: 'fail', conclusion: '方向性错误' }, files: ['.awf/reports/review/review-r1.md'] },
    ...overrides,
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-gate-fix-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('TC-H1: 门禁 blocked + verdict 非 pass → 派生修复任务 + 回退待复审 + 落盘', async () => {
    writeState([gate(), { id: 'T1', kind: 'dev', status: 'done' }]);
    await handleGateCompletion(tmpDir, 'R1', gate());
    const s = readState();
    expect(s.tasks.find((t) => t.id === 'R1-F1')).toBeTruthy();
    const g = s.tasks.find((t) => t.id === 'R1');
    expect(g.status).toBe('pending');
    expect(g.deps).toEqual(['T1', 'R1-F1']);
    expect(g.exec.recheck).toBe(1);
  });

  it('TC-H2: 非门禁 kind → no-op', async () => {
    writeState([{ ...gate(), kind: 'dev', id: 'D1' }]);
    await handleGateCompletion(tmpDir, 'D1', { ...gate(), kind: 'dev', id: 'D1' });
    const s = readState();
    expect(s.tasks).toHaveLength(1); // 无派生、无改动
  });

  it('TC-H3: 非 blocked → no-op（幂等：重复触发同 id）', async () => {
    writeState([gate({ status: 'pending' })]);
    await handleGateCompletion(tmpDir, 'R1', gate({ status: 'pending' }));
    expect(readState().tasks).toHaveLength(1);
  });

  it('TC-H4: verdict pass → no-op', async () => {
    writeState([gate({ exec: { verdict: { level: 'pass' } } })]);
    await handleGateCompletion(tmpDir, 'R1', gate({ exec: { verdict: { level: 'pass' } } }));
    expect(readState().tasks).toHaveLength(1);
  });

  it('TC-H5: 无 verdict → no-op（旧协议/卡住）', async () => {
    writeState([gate({ exec: { result: 'x' } })]);
    await handleGateCompletion(tmpDir, 'R1', gate({ exec: { result: 'x' } }));
    expect(readState().tasks).toHaveLength(1);
  });

  it('TC-H6: 已达轮次上限 → 不派生，保持 blocked', async () => {
    writeState([gate({ exec: { ...gate().exec, recheck: MAX_RECHECK } })]);
    await handleGateCompletion(tmpDir, 'R1', gate({ exec: { ...gate().exec, recheck: MAX_RECHECK } }));
    const s = readState();
    expect(s.tasks).toHaveLength(1); // 无派生
    expect(s.tasks[0].status).toBe('blocked');
  });

  it('TC-H7: 任务 id 不存在 → no-op（不抛错）', async () => {
    writeState([gate()]);
    await expect(handleGateCompletion(tmpDir, 'T999', gate({ id: 'T999' }))).resolves.toBeUndefined();
  });
});
