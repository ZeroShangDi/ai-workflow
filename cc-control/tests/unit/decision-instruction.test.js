import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import decisionInstruction from '../../server/features/decision/instruction.cjs';

const { readDecisionInstruction, decisionInstructionPath, decisionPluginDir, DECISION_PLUGIN_NAME } = decisionInstruction;
const REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * server 决策模式指令读取：定位 decision 插件（经 plugin/config.json 注册表解析，不写死目录）
 * 并读取 decision/mode-instruction.md。
 *
 * 随旧树退役调整：本模块的三个导出**不再接受 pkgRoot 参数** —— 插件资产随包分发，包根由
 * `shared/plugin-assets.cjs` 单源推导（旧版让调用方传根，正是「.awf 布局多份知情者」的老毛病）。
 * 因此「未注册 → 抛错」这条无法再靠传一个假根来构造，它的覆盖归
 * `tests/unit/server-plugin-assets.test.js`（`pluginDir('不存在') → 抛 /未注册/`）。
 */

describe('decision-instruction — 定位 decision 插件并读取决策指令', () => {
  it('目录经 config.json marketplace 解析，等于注册的 decision 插件 dir', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'plugin', 'config.json'), 'utf-8'));
    const entry = cfg.marketplace.plugins.find((p) => p.name === DECISION_PLUGIN_NAME);
    expect(entry).toBeTruthy();
    expect(decisionPluginDir()).toBe(entry.dir);
  });

  it('读取到 decision/mode-instruction.md，含决策模式硬约束与方法注记', () => {
    const text = readDecisionInstruction();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('AWF_DECISION_RESULT');
    expect(text).toContain('禁止再向用户提问');
    expect(text).toContain('answer');
    expect(text).toContain('闭合前禁再问');
    expect(text).toContain('decision-core'); // 方法注记
  });

  it('指令路径 = plugin/<注册 dir>/decision/mode-instruction.md（文件真实存在）', () => {
    const p = decisionInstructionPath();
    expect(fs.existsSync(p)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'plugin', 'config.json'), 'utf-8'));
    const dir = cfg.marketplace.plugins.find((x) => x.name === DECISION_PLUGIN_NAME).dir;
    expect(p.endsWith(path.join('plugin', dir, 'decision', 'mode-instruction.md'))).toBe(true);
  });

  it('包根由模块位置推导（server 直接无参调用即可读到）', () => {
    expect(readDecisionInstruction().length).toBeGreaterThan(0);
  });
});
