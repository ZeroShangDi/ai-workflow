import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSession } = require('../../server/runtime/session.cjs');
const { createProjectRuntime } = require('../../server/runtime/index.cjs');
const { createMockTmux } = require('../../server/mock/index.cjs');

const tmpRoots = [];
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-layered-server-'));
  fs.mkdirSync(path.join(root, '.awf'), { recursive: true });
  tmpRoots.push(root);
  return root;
}
afterEach(() => {
  while (tmpRoots.length) fs.rmSync(tmpRoots.pop(), { recursive: true, force: true });
});

describe('server 分层 · 会话态（Session）', () => {
  it('setBusy / setReady，waitReady 在转 ready 时唤醒', async () => {
    const s = createSession({ sid: 'run-1' });
    expect(s.state).toBe('ready');
    s.setBusy();
    expect(s.state).toBe('busy');
    const waiting = s.waitReady(1000);
    setTimeout(() => s.setReady(), 10);
    expect(await waiting).toBe(true);
    expect(s.state).toBe('ready');
  });

  it('waitReady 超时返回 false（不抛）', async () => {
    const s = createSession({});
    s.setBusy();
    expect(await s.waitReady(20)).toBe(false);
  });

  it('上下文快照标记一次性消费', () => {
    const s = createSession({});
    expect(s.consumeContextReady()).toBe(false);
    s.setContextReady();
    expect(s.contextReady).toBe(true);
    expect(s.consumeContextReady()).toBe(true);
    expect(s.consumeContextReady()).toBe(false);
  });

  it('决策续跑指令一次性消费', () => {
    const s = createSession({});
    s.setDecisionResume({ decision_id: 'D-1', answer: 'A' });
    expect(s.consumeDecisionResume()).toEqual({ decision_id: 'D-1', answer: 'A' });
    expect(s.consumeDecisionResume()).toBeNull();
  });
});

describe('server 分层 · 项目上下文与 runtime 的边界', () => {
  it('ctx 只装身份/路径/出口，不再承载运行态', () => {
    const root = makeRoot();
    const rt = createProjectRuntime({ projectRoot: root, tmuxFactory: () => createMockTmux() });

    // 出口在位
    expect(typeof rt.ctx.tmux.hasSession).toBe('function');
    expect(typeof rt.ctx.stores.state.readSync).toBe('function');
    expect(typeof rt.ctx.logger.logPrompt).toBe('function');

    // 运行态**不在** ctx 上 —— 这是本次分层的核心
    for (const field of ['state', 'decisionPending', 'waiters', 'runHost', 'taskChannel', 'metricsCache', 'agents']) {
      expect(field in rt.ctx).toBe(false);
    }

    // 运行态各有归属
    expect(rt.session.state).toBe('ready');
    expect(rt.observability.agents instanceof Map).toBe(true);

    rt.reset();
  });

  it('每个 sid 一个独立会话槽（原 run-slot 职责）', () => {
    const root = makeRoot();
    const rt = createProjectRuntime({ projectRoot: root, tmuxFactory: () => createMockTmux() });
    const a = rt.sessionFor('sid-a');
    const b = rt.sessionFor('sid-b');
    a.setBusy();
    expect(a.state).toBe('busy');
    expect(b.state).toBe('ready');
    expect(rt.sessionFor('sid-a')).toBe(a); // 同一个 sid 复用同一槽
    expect(rt.sessionFor('')).toBeNull();
    rt.reset();
  });

  it('reset 把运行态收干净', () => {
    const root = makeRoot();
    const rt = createProjectRuntime({ projectRoot: root, tmuxFactory: () => createMockTmux() });
    rt.session.setBusy();
    rt.sessionFor('sid-x').setBusy();
    rt.observability.trackAgent('a1', { status: 'running' });
    rt.reset();
    expect(rt.session.state).toBe('ready');
    expect(rt.sessions.size).toBe(0);
    expect(rt.observability.agents.size).toBe(0);
  });
});
