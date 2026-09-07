import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DecisionStore, isoStamp } from '../../src/server/decision-store.cjs';

const tmpDirs = [];

function makeProject({ version = '0.2.0', runDirs = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-dstore-'));
  tmpDirs.push(root);
  const awf = path.join(root, '.awf');
  fs.mkdirSync(awf, { recursive: true });
  fs.writeFileSync(path.join(awf, 'state.json'), JSON.stringify({ version }));
  const logs = path.join(awf, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  for (const name of runDirs) fs.mkdirSync(path.join(logs, name), { recursive: true });
  return root;
}

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

const NEW_RUN = '0.2.0-2026-09-07T00-50-00';
const OLD_RUN = '0.2.0-2026-09-07T00-40-00';

describe('DecisionStore — 追加式 jsonl / runStamp / override', () => {
  it('runs 目录 mkdir；runStamp 对齐 .awf/logs 最新 run（非旧 run）', () => {
    const root = makeProject({ runDirs: [OLD_RUN, NEW_RUN] });
    const store = new DecisionStore(root);
    expect(store.runStamp()).toBe(NEW_RUN);

    const r = store.append({ decision_id: 'D-1', answer: '走 A', status: 'pending_review' });
    expect(r.appended).toBe(true);
    expect(r.runStamp).toBe(NEW_RUN);
    expect(fs.existsSync(path.join(root, '.awf', 'decisions', 'runs', `${NEW_RUN}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(root, '.awf', 'decisions', 'runs', `${OLD_RUN}.jsonl`))).toBe(false);
  });

  it('写读：行级 JSON 含 runStamp；listRuns/listAll 聚合', () => {
    const root = makeProject({ runDirs: [NEW_RUN] });
    const store = new DecisionStore(root);
    const rec = { decision_id: 'D-2', answer: 'B', type: 'resolved' };
    store.append(rec);

    const raw = fs.readFileSync(store.fileFor(NEW_RUN), 'utf8').trim().split('\n');
    expect(raw).toHaveLength(1);
    expect(JSON.parse(raw[0])).toEqual({ runStamp: NEW_RUN, ...rec });

    const runs = store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].runStamp).toBe(NEW_RUN);
    expect(runs[0].entries).toHaveLength(1);
    expect(store.listAll()).toHaveLength(1);
  });

  it('追加不覆盖：不同 decision_id 累积多行，历史保留', () => {
    const root = makeProject({ runDirs: [NEW_RUN] });
    const store = new DecisionStore(root);
    store.append({ decision_id: 'D-3', answer: 'x' });
    store.append({ decision_id: 'D-4', answer: 'y' });
    const lines = fs.readFileSync(store.fileFor(NEW_RUN), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).decision_id).toBe('D-3');
    expect(JSON.parse(lines[1]).decision_id).toBe('D-4');
  });

  it('幂等：同 decision_id 重复 append → 跳过不重复落盘', () => {
    const root = makeProject({ runDirs: [NEW_RUN] });
    const store = new DecisionStore(root);
    const rec = { decision_id: 'D-5', answer: 'x' };
    expect(store.append(rec).appended).toBe(true);
    const second = store.append({ ...rec });
    expect(second.appended).toBe(false);
    expect(fs.readFileSync(store.fileFor(NEW_RUN), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('聚合跨 run：多个 run 文件倒序读取（新 run 在前）', () => {
    const root = makeProject({ runDirs: [OLD_RUN, NEW_RUN] });
    const store = new DecisionStore(root);
    // 旧 run 先落一条（直接写文件模拟历史 run）
    fs.mkdirSync(store.runsDir, { recursive: true });
    fs.appendFileSync(store.fileFor(OLD_RUN), `${JSON.stringify({ runStamp: OLD_RUN, decision_id: 'D-old' })}\n`);
    store.append({ decision_id: 'D-new', answer: 'new' });

    const runs = store.listRuns();
    expect(runs.map((r) => r.runStamp)).toEqual([NEW_RUN, OLD_RUN]);
    expect(runs[0].entries.map((e) => e.decision_id)).toEqual(['D-new']);
    expect(runs[1].entries.map((e) => e.decision_id)).toEqual(['D-old']);
  });

  it('override：追加 decision_overridden 事件到原 decision 所在 run 文件，不覆盖原记录', () => {
    const root = makeProject({ runDirs: [OLD_RUN, NEW_RUN] });
    const store = new DecisionStore(root);
    store.append({ decision_id: 'D-6', answer: 'orig' });
    const res = store.override('D-6', { instruction: '改成 Z', original_answer: 'orig' });

    expect(res.runStamp).toBe(NEW_RUN);
    const lines = fs.readFileSync(store.fileFor(NEW_RUN), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    // 原记录不变
    expect(JSON.parse(lines[0])).toMatchObject({ decision_id: 'D-6', answer: 'orig' });
    // 追加的是 override 事件
    const evt = JSON.parse(lines[1]);
    expect(evt.event).toBe('decision_overridden');
    expect(evt.decision_id).toBe('D-6');
    expect(evt.instruction).toBe('改成 Z');
    expect(store.listAll().some((e) => e.event === 'decision_overridden')).toBe(true);
  });

  it('override 目标不存在 → 抛错', () => {
    const root = makeProject({ runDirs: [NEW_RUN] });
    const store = new DecisionStore(root);
    expect(() => store.override('D-404', {})).toThrow(/不存在/);
  });

  it('version 缺失（无 state.json）→ runStamp null、append 拒绝', () => {
    const root = makeProject({ version: '0.2.0', runDirs: [] });
    // 移除 state.json
    fs.rmSync(path.join(root, '.awf', 'state.json'));
    const store = new DecisionStore(root);
    expect(store.runStamp()).toBeNull();
    expect(store.append({ decision_id: 'D-7' }).appended).toBe(false);
  });

  it('isoStamp 与 run-logger 同形（ISO 去 :/. 前 19 位）', () => {
    expect(isoStamp()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
  });
});
