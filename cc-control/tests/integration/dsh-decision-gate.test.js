import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createProjectRuntime } = require('../../server/runtime/index.cjs');

/**
 * DSH 的**回合末门阀**（决策）—— T-P3-02 / V07 的第一半。
 *
 * cc 的门阀挂在 Stop hook 上（用 `ccOutput.decision='block'` 让 cc 用 reason 继续跑）；
 * DSH 没有回灌通道 → AWF 必须**把门阀指令再发一条 prompt 回去**。因此插件在 `session.ready`
 * 里带上本轮末条文本（`lastAssistantMessage`），runtime 在 READY 分支上跑门阀。
 *
 * 本文件是**替身级装配验证**（假 bridge 喂平台事件）；真实「模型输出 <AWF_DECISION_REQUIRED> →
 * 门阀接管 → 结论落盘」由真机夹具覆盖（会派模型）。
 */

let root; let rt; let handlers; let prompts;
const READY = { type: 'session.ready' };

const DECISION_TEXT = '我先问一下。\n<AWF_DECISION_REQUIRED>要不要继续？</AWF_DECISION_REQUIRED>';

function makeFakeBridge() {
  handlers = new Set();
  prompts = [];
  const facts = { sessionExists: true, reachable: true, ready: true, cwd: root };
  return {
    connected: () => true,
    lastFacts: () => ({ ...facts }),
    noteFacts: () => ({ ...facts }),
    pendingCount: () => 0,
    detachedReason: () => null,
    onEvent: (h) => { handlers.add(h); return () => handlers.delete(h); },
    async request(op, args) {
      if (op === 'session.prompt') {
        prompts.push(args?.text ?? '');
        // 平台真实行为：受理 → 跑一轮 → 回合结束（这里立刻回 ready，免得测试等超时）
        queueMicrotask(() => { for (const h of [...handlers]) h({ cwd: root, ...READY, lastAssistantMessage: null }); });
      }
      return { commandId: `c-${op}`, op, delivery: 'accepted', ok: true, result: { accepted: true } };
    },
  };
}

const emit = (payload) => { for (const h of [...handlers]) h({ cwd: root, ...payload }); };

beforeAll(() => {
  process.env.CC_READY_TIMEOUT_MS = '3000'; // 装配期快照，必须在 runtime 之前设
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-dsh-gate-'));
  fs.mkdirSync(path.join(root, '.awf'), { recursive: true });
  fs.writeFileSync(path.join(root, '.awf', 'config.json'), JSON.stringify({
    runtime: { adapter: 'dsh' },
    run: { decision: { enabled: true, mode: 'auto' } },
  }));
  fs.writeFileSync(path.join(root, '.awf', 'state.json'), JSON.stringify({
    mode: 'run', version: '0.2.0', currentState: 'CODE', milestones: [], plan: {},
    tasks: [{ id: 'T1', kind: 'dev', status: 'active', deps: [], wbsRef: 'W1', acceptance: 'x' }],
  }));
  rt = createProjectRuntime({ projectRoot: root, adapterDeps: { bridge: makeFakeBridge() } });
});

afterAll(() => {
  rt?.reset?.();
  delete process.env.CC_READY_TIMEOUT_MS;
  fs.rmSync(root, { recursive: true, force: true });
});

const waitFor = async (fn, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
};

describe('DSH · 回合末门阀（决策）', () => {
  it('这轮末条文本带 <AWF_DECISION_REQUIRED> → 门阀登场：进 deciding 相位 + 指令发回会话', async () => {
    expect(rt.ctx.adapter).toBe('dsh');
    emit({ ...READY, lastAssistantMessage: DECISION_TEXT });

    expect(await waitFor(() => prompts.length > 0)).toBe(true);
    // 发回去的是「决策模式」指令（决策插件资产），不是原文照抄
    expect(prompts[0]).not.toBe(DECISION_TEXT);
    expect(prompts[0].length).toBeGreaterThan(20);
    expect(rt.session.decisionGate?.phase).toBe('deciding');
  });

  it('普通回合（无决策标记）→ 门阀不动，一条都不发', async () => {
    prompts.length = 0;
    emit({ ...READY, lastAssistantMessage: '任务做完了，收工。' });
    await new Promise((r) => setTimeout(r, 200));
    expect(prompts).toEqual([]);
  });

  it('旧插件（事件里没有末条文本）→ 不跑门阀（不猜、不发）', async () => {
    prompts.length = 0;
    emit({ ...READY });
    await new Promise((r) => setTimeout(r, 200));
    expect(prompts).toEqual([]);
  });
});
