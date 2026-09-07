import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadRunConfig } from '../../src/lib/run-config.js';

// run-config 决策开关语义（W1-009 / M2）：
// - run.decision.enabled 缺省 false（不配置 = 关 = 旧上抛逻辑）
// - 仅接受布尔；显式 true 生效；非法值回落 false
// - 与 run.agents 配额并存，互不影响

const tmpDirs = [];

function tmpProject(configText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-runconfig-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.awf'), { recursive: true });
  if (configText !== undefined) fs.writeFileSync(path.join(dir, '.awf', 'config.json'), configText);
  return dir;
}

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('run.decision.enabled — 加载 / 默认合并', () => {
  it('缺省：config.json 缺失 → decision.enabled=false（agents 亦回落默认）', () => {
    const cfg = loadRunConfig(tmpProject());
    expect(cfg.decision.enabled).toBe(false);
    expect(cfg.agents.max).toBe(1);
  });

  it('缺省：存在 config 但无 run.decision → enabled=false', () => {
    const cfg = loadRunConfig(tmpProject(JSON.stringify({ run: { agents: { max: 2 } } })));
    expect(cfg.decision.enabled).toBe(false);
    expect(cfg.agents.max).toBe(2); // 并行配额不受影响
  });

  it('显式 true → enabled=true', () => {
    const cfg = loadRunConfig(tmpProject(JSON.stringify({ run: { decision: { enabled: true } } })));
    expect(cfg.decision.enabled).toBe(true);
  });

  it('显式 false → enabled=false', () => {
    const cfg = loadRunConfig(tmpProject(JSON.stringify({ run: { decision: { enabled: false } } })));
    expect(cfg.decision.enabled).toBe(false);
  });

  it('非法值（字符串/数字）→ 回落 false（仅接受布尔）', () => {
    expect(loadRunConfig(tmpProject(JSON.stringify({ run: { decision: { enabled: 'true' } } }))).decision.enabled).toBe(false);
    expect(loadRunConfig(tmpProject(JSON.stringify({ run: { decision: { enabled: 1 } } }))).decision.enabled).toBe(false);
  });

  it('非法 JSON → 全部回落默认（decision 关）', () => {
    const cfg = loadRunConfig(tmpProject('{ not valid json'));
    expect(cfg.decision.enabled).toBe(false);
    expect(cfg.agents.max).toBe(1);
  });
});
