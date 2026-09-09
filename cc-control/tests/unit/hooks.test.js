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

// 单 server 多项目：全部事件走 gateway（统一转发 /hook 并附 ?p/&sid），不再区分裸 curl；
// gateway 只把 server 返回的 ccOutput 透传 stdout（其余事件无 ccOutput → 无输出、不阻断）。
const GATEWAY_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolUse'];
const CURL_EVENTS = [];

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

  // ── TC3: Hook 命令形态 — gateway 事件走 node gateway.cjs，其余走裸 curl ──

  it('TC3: gateway 事件指向 gateway.cjs；其余事件保持裸 curl', () => {
    const { config } = loadConfig();

    for (const eventName of GATEWAY_EVENTS) {
      const cmd = config.hooks[eventName][0].hooks[0].command;
      expect(config.hooks[eventName][0].hooks[0].type).toBe('command');
      expect(cmd).toContain('node');
      expect(cmd).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/gateway.cjs');
      expect(cmd).toContain('__PORT__'); // 端口单源（渲染时 → 字面量）
      expect(cmd).not.toContain('curl');
    }

    for (const eventName of CURL_EVENTS) {
      const cmd = config.hooks[eventName][0].hooks[0].command;
      expect(config.hooks[eventName][0].hooks[0].type).toBe('command');
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

  it('TC18: SessionStart 命令走 gateway（透传 stdin 携带 session_id；多项目统一附 ?p/&sid）', () => {
    const { config } = loadConfig();
    const cmd = config.hooks.SessionStart[0].hooks[0].command;

    expect(cmd).toContain('node');
    expect(cmd).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/gateway.cjs');
    expect(cmd).toContain('__PORT__');
    expect(cmd).not.toContain('curl');
  });

  // ── TC19: Stop 命令改走 gateway（转发 /hook + ccOutput 透传），不再裸 curl ──

  it('TC19: Stop 命令指向 gateway（透传 stdin、由 server 决定是否返回 ccOutput）', () => {
    const { config } = loadConfig();
    const cmd = config.hooks.Stop[0].hooks[0].command;

    expect(cmd).toContain('node');
    expect(cmd).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/gateway.cjs');
    expect(cmd).toContain('__PORT__');
    expect(cmd).not.toContain('curl');
    expect(cmd).not.toContain('sh -c');
  });

  // ── TC20: PreToolUse 命令改走 gateway，matcher 仍为 AskUserQuestion ──

  it('TC20: PreToolUse 命令指向 gateway 且 matcher 为 AskUserQuestion', () => {
    const { config } = loadConfig();
    const entry = config.hooks.PreToolUse[0];
    const cmd = entry.hooks[0].command;

    expect(entry.matcher).toBe('AskUserQuestion');
    expect(cmd).toContain('node');
    expect(cmd).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/gateway.cjs');
    expect(cmd).toContain('__PORT__');
    expect(cmd).not.toContain('curl');
  });

  // ── TC21: 裸 curl 事件都有 -m 2 和容错（统一透传 sh -c + exit 0）──

  it('TC21: 裸 curl 事件都有 -m 2 和容错（统一 sh -c + exit 0）', () => {
    const { config } = loadConfig();

    for (const eventName of CURL_EVENTS) {
      const cmd = config.hooks[eventName][0].hooks[0].command;
      expect(cmd).toContain('-m 2');
      expect(cmd).toContain('>/dev/null 2>&1');
      // 容错：sh -c ...; exit 0（透传类）或 || true（PostToolUse）
      expect(cmd).toMatch(/; exit 0'|\|\| true/);
    }
  });
});
