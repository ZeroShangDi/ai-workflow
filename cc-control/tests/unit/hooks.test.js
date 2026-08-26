import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const settingsPath = path.resolve(__dirname, '../../plugin/config.json');

function loadConfig() {
  const raw = fs.readFileSync(settingsPath, 'utf-8');
  return { config: JSON.parse(raw), raw };
}

describe('plugin config.json hooks', () => {
  // ── TC1: 文件存在且为合法 JSON ──

  it('TC1: 文件存在且为合法 JSON', () => {
    expect(fs.existsSync(settingsPath)).toBe(true);

    const { config } = loadConfig();
    expect(config).toBeDefined();
    expect(config.hooks).toBeDefined();
  });

  // ── TC2: 包含 7 个 Hook 事件键 ──

  it('TC2: 包含 7 个 Hook 事件键（含子 agent 观测）', () => {
    const { config } = loadConfig();
    const keys = Object.keys(config.hooks);

    expect(keys).toContain('SessionStart');
    expect(keys).toContain('UserPromptSubmit');
    expect(keys).toContain('Stop');
    expect(keys).toContain('SubagentStart');
    expect(keys).toContain('SubagentStop');
    expect(keys).toContain('PreToolUse');
    expect(keys).toContain('PostToolUse');
    expect(keys).toHaveLength(7);
  });

  // ── TC3: 每个 Hook 的 curl 命令完整性 ──

  it('TC3: 每个 Hook 的 curl 命令完整性', () => {
    const { config } = loadConfig();

    for (const [eventName, hookEntries] of Object.entries(config.hooks)) {
      expect(hookEntries.length).toBeGreaterThanOrEqual(1);
      const entry = hookEntries[0];
      expect(entry.hooks).toBeDefined();
      expect(entry.hooks.length).toBeGreaterThanOrEqual(1);

      const cmd = entry.hooks[0].command;
      expect(entry.hooks[0].type).toBe('command');
      expect(cmd).toContain('curl');
      expect(cmd).toContain('http://127.0.0.1:__PORT__/hook');
      expect(cmd).toContain('>/dev/null 2>&1');
    }
  });

  // ── TC4: __PORT__ 占位符存在 ──

  it('TC4: __PORT__ 占位符存在', () => {
    const { raw } = loadConfig();
    const matches = raw.match(/__PORT__/g);
    expect(matches.length).toBeGreaterThanOrEqual(5);
  });

  // ── TC5: PreToolUse matcher 为 "AskUserQuestion" ──

  it('TC5: PreToolUse matcher 为 "AskUserQuestion"', () => {
    const { config } = loadConfig();

    expect(config.hooks.PreToolUse[0].matcher).toBe('AskUserQuestion');

    // 其他 4 个 hook 无 matcher
    expect(config.hooks.SessionStart[0].matcher).toBeUndefined();
    expect(config.hooks.UserPromptSubmit[0].matcher).toBeUndefined();
    expect(config.hooks.Stop[0].matcher).toBeUndefined();
    expect(config.hooks.PostToolUse[0].matcher).toBeUndefined();
  });

  // ── TC18: SessionStart curl 命令（M2：透传 stdin 携带 session_id）──

  it('TC18: SessionStart curl 命令格式验证（透传 stdin）', () => {
    const { config } = loadConfig();
    const cmd = config.hooks.SessionStart[0].hooks[0].command;

    expect(cmd).toContain('curl');
    expect(cmd).toContain('-X POST');
    expect(cmd).toContain('?event=SessionStart');
    expect(cmd).toContain('-d @-'); // 透传原始 payload（server 据此记录 mainSessionId）
    expect(cmd).toContain("sh -c '");
    expect(cmd).toContain('; exit 0');
  });

  // ── TC19: Stop curl 与 SessionStart 一致（透传，server 按 session_id 过滤）──

  it('TC19: Stop curl 格式验证（透传 stdin）', () => {
    const { config } = loadConfig();
    const cmd = config.hooks.Stop[0].hooks[0].command;

    expect(cmd).toContain('curl');
    expect(cmd).toContain('-X POST');
    expect(cmd).toContain('?event=Stop');
    expect(cmd).toContain('-d @-'); // 透传 session_id，子 agent Stop 不误翻主闩锁
    expect(cmd).toContain("sh -c '");
    expect(cmd).toContain('; exit 0');
  });

  // ── TC20: PreToolUse curl 使用 sh -c + exit 0 ──

  it('TC20: PreToolUse curl 使用 sh -c + exit 0', () => {
    const { config } = loadConfig();
    const cmd = config.hooks.PreToolUse[0].hooks[0].command;

    expect(cmd).toContain("sh -c '");
    expect(cmd).toContain("; exit 0'");
    expect(cmd).not.toContain('|| true');
  });

  // ── TC21: 所有 curl 都有 -m 2 和容错（统一透传 sh -c + exit 0）──

  it('TC21: 所有 curl 都有 -m 2 和容错（统一 sh -c + exit 0）', () => {
    const { config } = loadConfig();

    for (const [, hookEntries] of Object.entries(config.hooks)) {
      const cmd = hookEntries[0].hooks[0].command;
      expect(cmd).toContain('-m 2');
      expect(cmd).toContain('>/dev/null 2>&1');
      // 容错：sh -c ...; exit 0（透传类）或 || true（PostToolUse）
      expect(cmd).toMatch(/; exit 0'|\|\| true/);
    }
  });
});
