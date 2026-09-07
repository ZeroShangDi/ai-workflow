import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import decisionConfig from '../../src/lib/decision-config.cjs';
import { loadRunConfig } from '../../src/lib/run-config.js';

const { isDecisionEnabled } = decisionConfig;

// server/CLI 共用 decision 判定（单一来源防漂移）：缺省 false，仅接受布尔。
// 与 run-config 委托同一实现 → 语义必然一致。

const tmpDirs = [];

function tmpProject(configText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-decisioncfg-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.awf'), { recursive: true });
  if (configText !== undefined) fs.writeFileSync(path.join(dir, '.awf', 'config.json'), configText);
  return dir;
}

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('isDecisionEnabled(projectRoot) — server 侧判定', () => {
  it('缺省：config.json 缺失 → false', () => {
    expect(isDecisionEnabled(tmpProject())).toBe(false);
  });

  it('缺省：存在 config 但无 run.decision → false', () => {
    expect(isDecisionEnabled(tmpProject(JSON.stringify({ run: { agents: { max: 2 } } })))).toBe(false);
  });

  it('显式 true → true', () => {
    expect(isDecisionEnabled(tmpProject(JSON.stringify({ run: { decision: { enabled: true } } })))).toBe(true);
  });

  it('显式 false → false', () => {
    expect(isDecisionEnabled(tmpProject(JSON.stringify({ run: { decision: { enabled: false } } })))).toBe(false);
  });

  it('非法值（字符串/数字）→ 回落 false', () => {
    expect(isDecisionEnabled(tmpProject(JSON.stringify({ run: { decision: { enabled: 'true' } } })))).toBe(false);
    expect(isDecisionEnabled(tmpProject(JSON.stringify({ run: { decision: { enabled: 1 } } })))).toBe(false);
  });

  it('非法 JSON → false', () => {
    expect(isDecisionEnabled(tmpProject('{ not valid json'))).toBe(false);
  });

  it('与 CLI loadRunConfig 同默认（防漂移）：缺省与显式 true 判定一致', () => {
    const missing = tmpProject(JSON.stringify({ run: {} }));
    expect(isDecisionEnabled(missing)).toBe(loadRunConfig(missing).decision.enabled);

    const on = tmpProject(JSON.stringify({ run: { decision: { enabled: true } } }));
    expect(isDecisionEnabled(on)).toBe(loadRunConfig(on).decision.enabled);
    expect(isDecisionEnabled(on)).toBe(true);
  });
});
