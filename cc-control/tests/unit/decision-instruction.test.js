import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import decisionInstruction from '../../src/server/decision-instruction.cjs';

const { readDecisionInstruction, decisionInstructionPath, decisionPluginDir, DECISION_PLUGIN_NAME } = decisionInstruction;
const REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

// server 决策模式指令读取：定位 decision 插件（config marketplace 解析，不写死目录）并读取 mode-instruction.md。

describe('decision-instruction — 定位 decision 插件并读取决策指令', () => {
  it('目录经 config.json marketplace 解析，等于注册的 decision 插件 dir', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'plugin', 'config.json'), 'utf-8'));
    const entry = cfg.marketplace.plugins.find((p) => p.name === DECISION_PLUGIN_NAME);
    expect(entry).toBeTruthy();
    expect(decisionPluginDir(REPO)).toBe(entry.dir);
  });

  it('读取到 decision/mode-instruction.md，含决策模式硬约束与方法注记', () => {
    const text = readDecisionInstruction(REPO);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('AWF_DECISION_RESULT');
    expect(text).toContain('禁止再向用户提问');
    expect(text).toContain('answer');
    expect(text).toContain('闭合前禁再问');
    expect(text).toContain('decision-core'); // 方法注记
  });

  it('指令路径 = plugin/<注册 dir>/decision/mode-instruction.md（文件真实存在）', () => {
    const p = decisionInstructionPath(REPO);
    expect(fs.existsSync(p)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'plugin', 'config.json'), 'utf-8'));
    const dir = cfg.marketplace.plugins.find((x) => x.name === DECISION_PLUGIN_NAME).dir;
    expect(p.endsWith(path.join('plugin', dir, 'decision', 'mode-instruction.md'))).toBe(true);
  });

  it('缺省 pkgRoot 由模块位置推导（server 直接无参调用也能读到）', () => {
    const byDefault = readDecisionInstruction(); // 不传 pkgRoot
    expect(byDefault.length).toBeGreaterThan(0);
    expect(byDefault).toBe(readDecisionInstruction(REPO));
  });

  it('决策插件未注册 → 定位抛错（不静默）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-decision-instr-'));
    try {
      fs.mkdirSync(path.join(tmp, 'plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, 'plugin', 'config.json'),
        JSON.stringify({ marketplace: { plugins: [{ dir: 'core', name: 'ai-workflow-core' }] } }),
      );
      expect(() => readDecisionInstruction(tmp)).toThrow(/未注册/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
