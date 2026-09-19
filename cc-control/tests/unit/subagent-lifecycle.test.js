import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSubagentRecorder, createSubagentLifecycle } = require('../../server/run/subagent.cjs');
const { createObservability } = require('../../server/observability/index.cjs');

/**
 * 子 Agent 生命周期处理器（平台无关）—— T-P3-01。
 *
 * 立场：cc 经 HTTP hook、DSH 经平台事件总线，**入口不同、落账语义必须同一份**。
 * 本文件为**替身单测**：真实两平台链路分别由 tests/unit (hook) 与真机夹具覆盖。
 */

function makeHarness({ mainSessionId = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-lifecycle-'));
  const settled = [];
  const subagent = createSubagentRecorder({
    paths: {
      event: path.join(dir, 'subagent-events.jsonl'),
      failed: path.join(dir, 'subagent-failed.jsonl'),
      needsInput: path.join(dir, 'subagent-needs-input.jsonl'),
    },
    stores: { state: { updateSync: () => false } },
  });
  // 落账正文被替换成记录调用（本文件只验「谁被落账、按什么优先级」，state 写入由别处覆盖）
  subagent.settle = (body) => { settled.push(body); return { ok: true, taskId: 'T1', status: 'done' }; };
  const observability = createObservability({ paths: { event: path.join(dir, 'events.jsonl') } });
  const metas = [];
  const h = createSubagentLifecycle({
    subagent,
    observability,
    session: { mainSessionId },
    onMeta: (key, body, status) => metas.push({ key, status }),
    onSettle: () => {},
  });
  const readEvents = () => fs.readFileSync(path.join(dir, 'subagent-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { h, settled, observability, metas, readEvents, dir };
}

describe('子 Agent 生命周期（平台无关处理器）', () => {
  it('起 → 建基线 + 留档；停 → 用末条文本落账', () => {
    const { h, settled, observability, metas, readEvents } = makeHarness();
    const start = h.started({ agent_id: 'c1', session_id: 's-main' });
    expect(start).toEqual({ handled: true, key: 'c1' });
    expect(observability.agents.get('c1').status).toBe('running');
    expect(metas).toEqual([{ key: 'c1', status: 'running' }]);

    const body = { agent_id: 'c1', session_id: 's-main', last_assistant_message: 'RESULT: {"taskId":"T1","status":"done"}' };
    const stop = h.stopped(body);
    expect(stop.handled).toBe(true);
    expect(settled).toEqual([body]); // 落账拿到的就是平台给的末条文本
    expect(observability.agents.get('c1').status).toBe('stopped');
    expect(readEvents().map((e) => e.event)).toEqual(['SubagentStart', 'SubagentStop']);
  });

  // 没有基线就结算 = 可能把别的 agent 的 RESULT 记到本项目任务上（宁可漏，不可错）
  it('没记过 SubagentStart 的 stop → 不落账（untracked）', () => {
    const { h, settled } = makeHarness();
    const r = h.stopped({ agent_id: 'ghost', session_id: 's-main', last_assistant_message: 'RESULT: {"taskId":"T1","status":"done"}' });
    expect(r).toMatchObject({ handled: false });
    expect(r.reason).toContain('untracked');
    expect(settled).toEqual([]);
  });

  it('外部会话（session_id 不是主会话）→ 起停都只留档、不动记账与状态', () => {
    const { h, settled, observability, metas, readEvents } = makeHarness({ mainSessionId: 's-main' });
    expect(h.started({ agent_id: 'x', session_id: 's-other' })).toMatchObject({ handled: false });
    expect(observability.agents.get('x')).toBeUndefined();
    expect(metas).toEqual([]);
    expect(h.stopped({ agent_id: 'x', session_id: 's-other', last_assistant_message: 'RESULT: {"taskId":"T1","status":"done"}' }))
      .toMatchObject({ handled: false });
    expect(settled).toEqual([]);
    expect(readEvents().map((e) => e.event)).toEqual(['SubagentStart', 'SubagentStop']); // 留档仍然做
  });

  it('NEEDS_INPUT 优先于 RESULT（有求援就不结算）', () => {
    const { h, settled } = makeHarness();
    h.started({ agent_id: 'c1', session_id: 's-main' });
    const r = h.stopped({
      agent_id: 'c1',
      session_id: 's-main',
      last_assistant_message: 'NEEDS_INPUT: {"taskId":"T1","question":"选哪个？"}',
    });
    expect(r.needsInput).toMatchObject({ taskId: 'T1', question: '选哪个？' });
    expect(settled).toEqual([]);
  });

  it('落账失败但可恢复 → 记 failure（补发判据）；明确不可恢复 → 只丢弃', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-lifecycle-fail-'));
    const failedPath = path.join(dir, 'subagent-failed.jsonl');
    const subagent = createSubagentRecorder({
      paths: { event: path.join(dir, 'e.jsonl'), failed: failedPath, needsInput: path.join(dir, 'n.jsonl') },
      stores: { state: { updateSync: () => false } },
    });
    subagent.settle = () => ({ ok: false, reason: 'task T1 not found' }); // 可恢复
    const observability = createObservability({ paths: { event: path.join(dir, 'events.jsonl') } });
    const h = createSubagentLifecycle({ subagent, observability, session: {} });
    h.started({ agent_id: 'c1', session_id: 's' });
    h.stopped({ agent_id: 'c1', session_id: 's', last_assistant_message: 'RESULT: {"taskId":"T1","status":"done"}' });
    expect(fs.existsSync(failedPath)).toBe(true);

    fs.rmSync(failedPath, { force: true });
    subagent.settle = () => ({ ok: false, reason: 'already done', recoverable: false });
    h.stopped({ agent_id: 'c1', session_id: 's', last_assistant_message: 'RESULT: {"taskId":"T1","status":"done"}' });
    expect(fs.existsSync(failedPath)).toBe(false); // 重发也没用 → 不算失败
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
