import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadRunConfig } from '../../server/run/config.js';

// run 运行时配置：**只读 run.agents**（编排配额，本模块的变化轴）。
//
// 曾经它还顺带返回 run.decision.enabled —— 那是 decision 能力的开关，与「怎么配并发」无关；
// 既无人消费，又让配额加载器背上别人的变化轴。现归 features/decision 自判
// （isDecisionEnabled，见 tests/unit/decision-config.test.js），本模块不再有该字段。

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

describe('run.agents — 配额加载 / 默认合并', () => {
  it('缺省：config.json 缺失 → 四级配额全 1（单任务串行，零行为变化）', () => {
    const cfg = loadRunConfig(tmpProject());
    expect(cfg.agents).toEqual({ max: 1, maxModules: 1, maxPerModule: 1, maxPerFeature: 1 });
  });

  it('显式配置 → 逐键生效，未配的键回落 1', () => {
    const cfg = loadRunConfig(tmpProject(JSON.stringify({ run: { agents: { max: 4, maxModules: 2 } } })));
    expect(cfg.agents).toEqual({ max: 4, maxModules: 2, maxPerModule: 1, maxPerFeature: 1 });
  });

  it('非法值（字符串 / 0 / 负数 / 非整数）→ 该键回落 1，不污染调度器配额', () => {
    const cfg = loadRunConfig(tmpProject(JSON.stringify({
      run: { agents: { max: '4', maxModules: 0, maxPerModule: -2, maxPerFeature: 1.5 } },
    })));
    expect(cfg.agents).toEqual({ max: 1, maxModules: 1, maxPerModule: 1, maxPerFeature: 1 });
  });

  it('非法 JSON → 全部回落默认', () => {
    const cfg = loadRunConfig(tmpProject('{ not valid json'));
    expect(cfg.agents).toEqual({ max: 1, maxModules: 1, maxPerModule: 1, maxPerFeature: 1 });
  });

  it('不再返回 decision 段：决策开关归 features/decision 单源，配额加载器不背它的变化轴', () => {
    const cfg = loadRunConfig(tmpProject(JSON.stringify({ run: { decision: { enabled: true } } })));
    expect(cfg.decision).toBeUndefined();
    expect(Object.keys(cfg)).toEqual(['agents']);
  });
});
