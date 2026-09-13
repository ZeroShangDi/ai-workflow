import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { answerDecision } = require('../../cli/lib/decision.cjs');
const decisionConfig = require('../../server/features/decision/config.cjs');
const { createDecisionHandler } = require('../../server/features/decision/handler.cjs');

// 决策链路：一个决策事件出现后**谁来答**（三路由，配置决定），以及**必须都落记录**（复盘）。

const pending = { decisionId: 'D-1', question: '用哪个 API 版本？', options: ['v1', 'v2'], type: 'choice', source: 'AskUserQuestion' };
const noSleep = () => Promise.resolve();

/** 记录 /respond 调用的客户端替身 */
function fakeClient() {
  const calls = [];
  return { calls, respond: async (value, answeredBy) => { calls.push({ value, answeredBy }); return { ok: true }; } };
}

/** 只有 isTTY=true 的 stdin 才被当作「终端有人」 */
const ttyStdin = (answer) => {
  const readline = require('node:readline');
  return { isTTY: true, ...readline.createInterface({ input: process.stdin, output: process.stdout }) };
};

describe('cli · 决策三路由', () => {
  it('auto：等倒计时后默认选第一项，以 answeredBy=auto 落账', async () => {
    const client = fakeClient();
    let slept = 0;
    const r = await answerDecision({ pending, client, mode: 'auto', sleepFn: (ms) => { slept = ms; return Promise.resolve(); } });
    expect(slept).toBe(5000);
    expect(r).toMatchObject({ answered: true, by: 'auto' });
    expect(client.calls[0]).toMatchObject({ answeredBy: 'auto' });
  });

  it('ai：CLI 不抢答（决策内核在会话内处理）', async () => {
    const client = fakeClient();
    const r = await answerDecision({ pending, client, mode: 'ai', sleepFn: noSleep });
    expect(r.answered).toBe(false);
    expect(r.by).toBe('ai');
    expect(client.calls).toHaveLength(0);
  });

  it('manual + 非 TTY：不抢答，留给前端页面（决策挂在服务端 pending 上，谁答都行）', async () => {
    const client = fakeClient();
    const r = await answerDecision({ pending, client, mode: 'manual', stdin: { isTTY: false }, sleepFn: noSleep });
    expect(r.answered).toBe(false);
    expect(r.reason).toMatch(/非 TTY/);
    expect(client.calls).toHaveLength(0);
  });

  it('manual + TTY：问终端并把选中的**选项文本**回传，answeredBy=human', async () => {
    const client = fakeClient();
    const stdin = { isTTY: true };
    const rl = require('node:readline');
    const orig = rl.createInterface;
    rl.createInterface = () => ({ question: (_q, cb) => cb('2'), close: () => {} });
    try {
      const r = await answerDecision({ pending, client, mode: 'manual', stdin, stdout: { write: () => {} }, sleepFn: noSleep });
      expect(r).toMatchObject({ answered: true, by: 'human', value: 'v2' });
      expect(client.calls[0]).toMatchObject({ value: 'v2', answeredBy: 'human' });
    } finally {
      rl.createInterface = orig;
      expect(stdin.isTTY).toBe(true);
    }
  });
});

describe('server · 决策策略配置', () => {
  it('非法/缺省：enabled 为真 → ai，否则 → auto（保真旧 CLI 对 AskUserQuestion 的 5s 自动选）', () => {
    expect(decisionConfig.decisionModeFrom({})).toBe('auto');
    expect(decisionConfig.decisionModeFrom({ run: { decision: { enabled: true } } })).toBe('ai');
    expect(decisionConfig.decisionModeFrom({ run: { decision: { mode: 'manual' } } })).toBe('manual');
    expect(decisionConfig.decisionModeFrom({ run: { decision: { mode: '乱写' } } })).toBe('auto');
  });

  it('decisionMode(projectRoot) 读 .awf/config.json', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-decision-mode-'));
    try {
      expect(decisionConfig.decisionMode(root)).toBe('auto'); // 无文件 → 缺省
      fs.mkdirSync(path.join(root, '.awf'), { recursive: true });
      fs.writeFileSync(path.join(root, '.awf', 'config.json'), JSON.stringify({ run: { decision: { mode: 'manual' } } }));
      expect(decisionConfig.decisionMode(root)).toBe('manual');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('server · 决策记录（不管走哪条路由都要留痕）', () => {
  /** 只要 setDecision / nextId 的会话替身 + 捕获记录的 store 替身 */
  function harness({ enabled = false } = {}) {
    const records = [];
    let seq = 0;
    const session = {
      decisionSeqGen: { nextId: () => `D-${++seq}` },
      decisionGate: null,
      decisionPending: null,
      setDecision(d) { this.decisionPending = d; },
      clearDecision() { this.decisionPending = null; },
      setDecisionResume() {}, setReady() {},
    };
    const handler = createDecisionHandler({
      session,
      logger: { logDecision: () => {}, captureFromTranscript: () => {} },
      // 假 store 必须**忠实模拟真 store 的去重口径**，否则会掩盖缺陷（2026-09-13 实测：
      // 旧替身 append 恒返回 true，把「answered 被 requested 挡掉」这个真 bug 藏了整整一轮）。
      // 真 store：append 按 decision_id 跨事件去重；appendEvent 按 (decision_id, event) 去重。
      newDecisionStore: () => ({
        // 口径与真 store 一致（都扫**已落记录**）：
        //   append      —— 同 decision_id 已落过（**不分事件**）→ 跳过
        //   appendEvent —— 同 (decision_id, event) 已落过 → 跳过
        // 旧替身用的是「一个 Set 混装两种键」，两种键永不碰撞 → 把 answered 被 requested 挡掉
        // 这个真 bug 藏了整整一轮（2026-09-13 实测）。
        append: (r) => {
          if (r.decision_id && records.some((x) => x.decision_id === r.decision_id)) return { appended: false };
          records.push(r);
          return { appended: true };
        },
        appendEvent: (r) => {
          if (records.some((x) => x.decision_id === r.decision_id && x.event === r.event)) return { appended: false };
          records.push(r);
          return { appended: true };
        },
      }),
      decisionEnabled: () => enabled,
      stores: {},
    });
    return { handler, records, session };
  }

  it('捕获决策即落 decision_requested（此前只存内存，答完就无迹可查）', () => {
    const { handler, records } = harness();
    handler.onAskUserQuestion({ tool_input: { questions: [{ question: '用哪版？', options: [{ label: 'v1' }, { label: 'v2' }] }] } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ event: 'decision_requested', source: 'AskUserQuestion' });
    expect(records[0].request).toMatchObject({ question: '用哪版？', options: ['v1', 'v2'] });
  });

  it('同一 decision_id 的 requested 与 answered **都要落**（真实时序：先问后答）', () => {
    // 回归守卫（2026-09-13 实测的真 bug）：记录写入若用 store.append，而 append 是**按 decision_id
    // 跨事件**去重的 —— 于是 requested 一落，同一次决策的 answered 就被静默丢弃，
    // 「谁答的」永远查不到。生命周期事件必须用 appendEvent（按 (decision_id, event) 去重）。
    const { handler, records } = harness();
    handler.onAskUserQuestion({ tool_input: { questions: [{ question: '用哪版？', options: [{ label: 'v1' }, { label: 'v2' }] }] } });
    const decisionId = records[0].decision_id;
    handler.recordAnswered({ decisionId, value: 'v1', answeredBy: 'human' });

    expect(records.map((r) => r.event)).toEqual(['decision_requested', 'decision_answered']);
    expect(records[1]).toMatchObject({ decision_id: decisionId, answered_by: 'human', value: 'v1' });
  });

  it('应答落 decision_answered，answered_by 区分路由（人 / 自动 / AI）', () => {
    // 三次**不同**决策，各走一条路由 —— 同一次决策只能被答一次（同 (id,event) 会被 store 去重挡掉），
    // 故不能用「同一 decisionId 答两次」来表达「路由可区分」。
    const { handler, records } = harness();
    handler.recordAnswered({ decisionId: 'D-1', value: '1', answeredBy: 'auto' });
    handler.recordAnswered({ decisionId: 'D-2', value: 'v2', answeredBy: 'human' });
    handler.recordAnswered({ decisionId: 'D-3', value: 'v3', answeredBy: 'ai' });
    expect(records.map((r) => [r.event, r.answered_by, r.value])).toEqual([
      ['decision_answered', 'auto', '1'],
      ['decision_answered', 'human', 'v2'],
      ['decision_answered', 'ai', 'v3'],
    ]);
  });

  it('门阀开（ai 路由）时 AskUserQuestion 被 deny，不进 capture 分支', () => {
    const { handler, records } = harness({ enabled: true });
    const out = handler.onAskUserQuestion({ tool_input: { questions: [{ question: 'q', options: [{ label: 'a' }] }] } });
    expect(out).toBeTruthy();       // 有 ccOutput（deny）
    expect(records).toHaveLength(0); // 没有捕获 → 不落 requested
  });
});
