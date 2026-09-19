import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');

import {
  planEntry, taskWrapup, taskSettle, contextCheck,
  batchDispatch, batchReconcile, subagentDispatch, subagentRedispatch, subagentResend, gateFixPrompt,
} from '../../server/shared/prompts.js';

/**
 * 提示词 golden（T-P1-04 迁移守卫）
 *
 * 背景：T-P1-04 把**编排模板**从 `plugin/plugin-code/prompts.json` 迁到
 * `server/templates/prompts.json`，并把插件标识抽成 `platform-vars` 参数。这种搬迁最容易出的错
 * 不是报错，而是**悄悄改了一个字**（少一个换行、丢一句协议要件）—— 而提示词就是行为
 * （.awf/bugs/dispatch-without-subagent-hangs-run.md 就是这么来的）。
 *
 * 因此这里冻结搬迁前的**渲染产物**（`tests/fixtures/prompts-golden.json`，2026-09-19 采集）：
 * 只要模板/参数搬迁后逐字节一致即通过。
 *
 * 有意改提示词时：确认改动意图后同步更新该 fixture（这是**有意的摩擦** —— 让提示词变更显式化，
 * 而不是被模板重构顺手带走）。重采方式：用与本文件 `CASES` 相同的调用渲染一遍，写回
 * `tests/fixtures/prompts-golden.json`。
 */

const GOLDEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/prompts-golden.json'), 'utf-8'));

/** 与采集 fixture 时完全相同的调用与变量（改这里等于改期望，需同时换 fixture） */
const CASES = {
  'plan-start': () => planEntry('需求D', false),
  'plan-resume': () => planEntry('需求D', true),
  'plan-default': () => planEntry(undefined, false),
  'task-wrapup': () => taskWrapup('T1'),
  'task-settle': () => taskSettle('T1'),
  'context-check': () => contextCheck('已用约 10%（statusline 实测）'),
  'batch-dispatch': () => batchDispatch({ batchId: 'B1', tasks: '- T1 [dev] 做A\n  提示词：p1\n- T2 [review] 做B\n  提示词：p2' }),
  'batch-reconcile': () => batchReconcile('B1'),
  'subagent-dispatch': () => subagentDispatch({ taskId: 'T1', taskTitle: '标题A', taskPrompt: '做A' }),
  'subagent-resend': () => subagentResend({ agentId: 'a1', reason: 'no valid RESULT' }),
  'subagent-redispatch': () => subagentRedispatch({ taskId: 'T1', taskPrompt: '做A' }),
  'gate-fix': () => gateFixPrompt({ fixId: 'F1', fixTarget: '修X' }),
};

describe('提示词渲染 golden（T-P1-04 迁移守卫）', () => {
  it('fixture 与用例表覆盖同一批 key（漏一个等于没守）', () => {
    expect(Object.keys(GOLDEN).sort()).toEqual(Object.keys(CASES).sort());
  });

  for (const [key, render] of Object.entries(CASES)) {
    it(`${key}：渲染结果与冻结文本逐字节一致`, async () => {
      expect(await render()).toBe(GOLDEN[key]);
    });
  }

  it('编排提示词不留未替换的平台参数占位符（platform-vars 确实被填进去）', async () => {
    for (const key of ['subagent-dispatch', 'subagent-redispatch', 'gate-fix', 'context-check', 'batch-dispatch']) {
      const text = await CASES[key]();
      // 只查 T-P1-04 抽出来的平台参数：提示词里还有 `NEEDS_INPUT: {json}` 这类协议字面量，不能一概而论
      expect(text, `${key} 残留平台参数占位符`)
        .not.toMatch(/\{(workerAgentType|devCommand|contextSkill|architectureSkill|reviewArchitectureSkill)\}/);
    }
  });
});
