import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pluginAssets = require('../../server/shared/plugin-assets.cjs');
const runtimeConfig = require('../../server/shared/runtime-config.cjs');
const decisionInstruction = require('../../server/features/decision/instruction.cjs');
const decisionConfig = require('../../server/features/decision/config.cjs');

const REPO = path.resolve(new URL('../..', import.meta.url).pathname);

// 插件目录怎么摆、资产在哪 —— 这是**外部形状**（插件系统说了算），
// 故只能有一个地方知道：shared/plugin-assets.cjs。本文件钉住「只有它知道」和「消费方都走它」。

describe('server · 插件资产定位原语', () => {
  it('按注册表解析插件目录，不写死目录名', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'plugin', 'config.json'), 'utf-8'));
    const entry = cfg.marketplace.plugins.find((p) => p.name === 'ai-workflow-decision');
    expect(entry).toBeTruthy();
    expect(pluginAssets.pluginDir('ai-workflow-decision')).toBe(entry.dir);
  });

  it('未注册的插件名 → 抛错（不静默返回猜测路径）', () => {
    expect(() => pluginAssets.pluginDir('ai-workflow-nonexistent')).toThrow(/未注册/);
  });

  it('pluginConfigPath 指向真实存在的注册表', () => {
    const p = pluginAssets.pluginConfigPath();
    expect(fs.existsSync(p)).toBe(true);
    expect(path.basename(p)).toBe('config.json');
  });

  it('readPluginAsset 读到插件内资产原文', () => {
    const text = pluginAssets.readPluginAsset('ai-workflow-decision', 'decision', 'mode-instruction.md');
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('AWF_DECISION_RESULT');
  });

  it('消费方都经原语定位（不再各自拼 plugin/ 路径）', () => {
    // prompts.js 的 state 模板 / runtime-config 的 config 路径 / decision 的指令路径
    expect(runtimeConfig.runtimeConfigPath()).toBe(pluginAssets.pluginConfigPath());
    const tpl = pluginAssets.pluginAssetPath('ai-workflow-core', 'mcp', 'awf-state', 'state.template.json');
    expect(fs.existsSync(tpl)).toBe(true);
  });
});

describe('server · decision 指令与开关', () => {
  it('决策模式指令落在 plugin/<注册 dir>/decision/ 下且可读', () => {
    const p = decisionInstruction.decisionInstructionPath();
    expect(fs.existsSync(p)).toBe(true);
    expect(p.endsWith(path.join('plugin', decisionInstruction.decisionPluginDir(), 'decision', 'mode-instruction.md'))).toBe(true);
    expect(decisionInstruction.readDecisionInstruction()).toContain('AWF_DECISION_RESULT');
  });

  it('开关：缺 .awf/config.json → false（缺省关）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-decision-cfg-'));
    try {
      expect(decisionConfig.isDecisionEnabled(root)).toBe(false);
      fs.mkdirSync(path.join(root, '.awf'), { recursive: true });
      fs.writeFileSync(path.join(root, '.awf', 'config.json'), '{ 坏 JSON');
      expect(decisionConfig.isDecisionEnabled(root)).toBe(false); // 非法 JSON 也回落关
      fs.writeFileSync(path.join(root, '.awf', 'config.json'), JSON.stringify({ run: { decision: { enabled: true } } }));
      expect(decisionConfig.isDecisionEnabled(root)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
