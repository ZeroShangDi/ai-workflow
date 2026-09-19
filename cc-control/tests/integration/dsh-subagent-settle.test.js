import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createProjectRuntime } = require('../../server/runtime/index.cjs');

/**
 * DSH 平台的**子 Agent 结果落账**（T-P3-01）—— 跨「平台事件 → 适配器 → 领域事件 → 落账」整条装配。
 *
 * 这一段在 cc 上由 hook 路由（`SubagentStart/Stop`）驱动，DSH 没有 hook：插件上报 `agent.started/stopped`
 * （带末条 assistant 文本）→ 适配器翻译 → 项目总线 → **与 cc 同一个**平台无关处理器落账。
 *
 * 本文件是**替身级**装配验证（假 bridge 触发事件）；真实「主会话真派出子 Agent 并回 RESULT」由
 * `scripts/probe/dsh/roundtrip.cjs --subagent` 真机覆盖。
 */

let root; let rt; let handlers;

/** 假指令通道：只用于把平台事件喂进适配器 */
function makeFakeBridge() {
  handlers = new Set();
  const facts = { sessionExists: true, reachable: true, ready: true, cwd: root };
  return {
    connected: () => true,
    lastFacts: () => ({ ...facts }),
    noteFacts: () => ({ ...facts }),
    pendingCount: () => 0,
    detachedReason: () => null,
    onEvent: (h) => { handlers.add(h); return () => handlers.delete(h); },
    async request(op) { return { commandId: `c-${op}`, op, delivery: 'accepted', ok: true, result: {} }; },
  };
}

const emit = (payload) => { for (const h of [...handlers]) h({ cwd: root, ...payload }); };

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-dsh-settle-'));
  fs.mkdirSync(path.join(root, '.awf'), { recursive: true });
  fs.writeFileSync(path.join(root, '.awf', 'config.json'), JSON.stringify({ runtime: { adapter: 'dsh' } }));
  fs.writeFileSync(path.join(root, '.awf', 'state.json'), JSON.stringify({
    mode: 'run',
    version: '0.2.0',
    currentState: 'CODE',
    milestones: [],
    plan: {},
    tasks: [{ id: 'T1', kind: 'dev', status: 'active', deps: [], wbsRef: 'W1', acceptance: 'x' }],
  }));
  rt = createProjectRuntime({ projectRoot: root, adapterDeps: { bridge: makeFakeBridge() } });
});

afterAll(() => {
  rt?.reset?.();
  fs.rmSync(root, { recursive: true, force: true });
});

const readState = () => JSON.parse(fs.readFileSync(path.join(root, '.awf', 'state.json'), 'utf8'));
const readEvents = () => {
  const p = path.join(root, '.awf', 'logs', 'subagent-events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

describe('DSH · 子 Agent 结果落账（平台事件 → 总线 → 落账）', () => {
  it('适配器确实按 dsh 解析（否则后面验的不是这条路）', () => {
    expect(rt.ctx.adapter).toBe('dsh');
  });

  it('agent.started 建基线 → agent.stopped 用末条文本把 RESULT 落进 state.json', () => {
    emit({ type: 'agent.started', agentId: 'child-1', parentSessionId: 's-main' });
    expect(readEvents().map((e) => e.event)).toEqual(['SubagentStart']);

    emit({
      type: 'agent.stopped',
      agentId: 'child-1',
      parentSessionId: 's-main',
      lastAssistantMessage: 'RESULT: {"taskId":"T1","status":"done","result":"子 Agent 产出","files":["a.js"]}',
    });

    const t = readState().tasks.find((x) => x.id === 'T1');
    expect(t.status).toBe('done');            // 真落账（不是「收到事件」就算了）
    expect(t.exec.result).toBe('子 Agent 产出');
    expect(t.exec.files).toEqual(['a.js']);
    expect(readEvents().map((e) => e.event)).toEqual(['SubagentStart', 'SubagentStop']);
  });

  it('没起过基线的 stop → 不落账（防把别的 agent 的 RESULT 记到本项目）', () => {
    const before = readState();
    emit({
      type: 'agent.stopped',
      agentId: 'ghost',
      parentSessionId: 's-main',
      lastAssistantMessage: 'RESULT: {"taskId":"T2","status":"done"}',
    });
    expect(readState()).toEqual(before); // state 一个字节没动
  });

  it('无末条文本的 stop → 明确跳过（不假装结算）', () => {
    emit({ type: 'agent.started', agentId: 'child-2', parentSessionId: 's-main' });
    const before = readState();
    emit({ type: 'agent.stopped', agentId: 'child-2', parentSessionId: 's-main', lastAssistantMessage: null });
    expect(readState()).toEqual(before);
  });

  it('别的项目 cwd 的事件不该被本项目接（进程级共享通道的项目过滤）', () => {
    const before = readState();
    for (const h of [...handlers]) {
      h({ type: 'agent.started', agentId: 'other-1', parentSessionId: 's-x', cwd: `${root}-elsewhere` });
      h({
        type: 'agent.stopped',
        agentId: 'other-1',
        parentSessionId: 's-x',
        cwd: `${root}-elsewhere`,
        lastAssistantMessage: 'RESULT: {"taskId":"T2","status":"done"}',
      });
    }
    expect(readState()).toEqual(before);
  });
});
