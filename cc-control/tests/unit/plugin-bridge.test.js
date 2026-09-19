import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pluginAssets = require('../../server/shared/plugin-assets.cjs');

import {
  planEntry, resolvePrompt, stateTemplatePath, taskWrapup, taskSettle, contextCheck,
  batchDispatch, batchReconcile, subagentDispatch, subagentRedispatch, subagentResend, gateFixPrompt,
} from '../../server/shared/prompts.js';

/**
 * plugin-bridge（server 侧 prompts.js）— 「取模板 + 填占位符」
 *
 * 随旧树退役重写。旧版在临时目录伪造一份 prompts.json、再 mock 根路径去读它 —— 那套 fixture
 * 已经不成立：模板**随包分发**，根由 shared/plugin-assets.cjs 单源推导（不再由调用方传根）。
 *
 * 现在改为**以模板文件本身为期望值**：断言「产出 = 模板原文 + 占位符被替换」。
 * 这样提示词改文案不会误伤测试（旧版硬编码文案，一改就红），而 bridge 的职责（读哪一份、
 * 填哪些键）仍被钉住 —— 正是 `.awf/issues/008`「手抄提示词漂移」要防的那类。
 *
 * T-P1-04 起分两份来源：编排模板在 `server/templates/prompts.json`（并自动并入插件的
 * `platform-vars`），入口模板仍在插件 `prompts.json`。下面的 `fill()` 按同一规则复算期望值。
 */

const pluginRegistry = JSON.parse(fs.readFileSync(
  pluginAssets.pluginAssetPath('ai-workflow-code', 'prompts.json'), 'utf-8',
));
const orchestrationRegistry = JSON.parse(fs.readFileSync(
  path.join(pluginAssets.pkgRoot(), 'server', 'templates', 'prompts.json'), 'utf-8',
));
const ORCHESTRATION_KEYS = new Set([
  'task-wrapup', 'task-settle', 'context-check', 'batch-dispatch', 'batch-reconcile',
  'subagent-dispatch', 'subagent-resend', 'subagent-redispatch', 'gate-fix',
]);

/** bridge 声明的平台参数（kebab → camel），供期望值复算 */
function platformVars() {
  return Object.fromEntries(Object.entries(pluginRegistry['platform-vars'])
    .map(([k, v]) => [k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v]));
}

/** 按 bridge 的同一规则填占位符（split/join，非正则） */
function fill(key, vars = {}) {
  const orchestration = ORCHESTRATION_KEYS.has(key);
  const template = (orchestration ? orchestrationRegistry : pluginRegistry)[key].prompt;
  const all = orchestration ? { ...platformVars(), ...vars } : vars;
  let text = template;
  for (const [k, v] of Object.entries(all)) text = text.split(`{${k}}`).join(v ?? '');
  return text;
}

describe('resolvePrompt — 取模板 + 填值', () => {
  it('填值与模板原文一致（占位符全被替换）', async () => {
    expect(await resolvePrompt('plan-start', { desc: '需求 X' })).toBe(fill('plan-start', { desc: '需求 X' }));
  });

  it('变量值里的特殊字符不被当成替换模式（split/join 而非 RegExp）', async () => {
    const res = await resolvePrompt('plan-start', { desc: 'A $& / 需求 {x} 等' });
    expect(res).toBe(fill('plan-start', { desc: 'A $& / 需求 {x} 等' }));
    expect(res).toContain('A $& / 需求 {x} 等');
  });

  it('未知 key → 抛错（宁可失败也不发空提示词）', async () => {
    await expect(resolvePrompt('no-such-key')).rejects.toThrow('prompt template not found: no-such-key');
  });
});

describe('planEntry — 场景选模板（resume 优先于 description）', () => {
  it('有 description → plan-start', async () => {
    expect(await planEntry('搭建测试基础设施', false)).toBe(fill('plan-start', { desc: '搭建测试基础设施' }));
  });

  it('无 description → plan-default', async () => {
    expect(await planEntry(undefined, false)).toBe(fill('plan-default'));
  });

  it('--resume 优先，忽略新描述', async () => {
    expect(await planEntry('任意文本', true)).toBe(fill('plan-resume'));
  });
});

describe('收尾/上下文/批次/门禁 —— 各模板填充', () => {
  it('taskWrapup 填 {taskId}', async () => {
    expect(await taskWrapup('T3')).toBe(fill('task-wrapup', { taskId: 'T3' }));
  });

  it('taskSettle 填 {taskId}', async () => {
    expect(await taskSettle('T3')).toBe(fill('task-settle', { taskId: 'T3' }));
  });

  it('contextCheck 填 {usage}', async () => {
    expect(await contextCheck('已用约 62%（statusline 实测）'))
      .toBe(fill('context-check', { usage: '已用约 62%（statusline 实测）' }));
  });

  it('batchDispatch 把任务数组排成「- <id> [<kind>] <title>\\n  提示词：<prompt>」清单', async () => {
    const res = await batchDispatch({
      batchId: 'B1',
      tasks: [
        { taskId: 'T1', title: '做 A', kind: 'dev', prompt: '/ai-workflow-code:w-dev <task>…' },
        { taskId: 'T2', title: '做 B', kind: 'review', prompt: '审查 A' },
      ],
    });
    expect(res).toBe(fill('batch-dispatch', {
      batchId: 'B1',
      tasks: '- T1 [dev] 做 A\n  提示词：/ai-workflow-code:w-dev <task>…\n- T2 [review] 做 B\n  提示词：审查 A',
    }));
    expect(res).toContain('本批次编号：B1');
  });

  it('batchDispatch 也接受已排好版的字符串（原样透传）', async () => {
    const res = await batchDispatch({ batchId: 'B2', tasks: '（调用方自己排的版）' });
    expect(res).toContain('（调用方自己排的版）');
  });

  it('batchReconcile 填 {batchId}', async () => {
    expect(await batchReconcile('B1')).toBe(fill('batch-reconcile', { batchId: 'B1' }));
  });

  it('subagentResend 填 {agentId} + {reason}', async () => {
    expect(await subagentResend({ agentId: 'a1', reason: 'no valid RESULT' }))
      .toBe(fill('subagent-resend', { agentId: 'a1', reason: 'no valid RESULT' }));
  });

  it('gateFixPrompt 填 {fixId} + {fixTarget}（命令字面活在模板里）', async () => {
    expect(await gateFixPrompt({ fixId: 'R1-F1', fixTarget: '修 x' }))
      .toBe(fill('gate-fix', { fixId: 'R1-F1', fixTarget: '修 x' }));
  });
});

describe('subagentDispatch / subagentRedispatch — 派发提示词的**协议要件**', () => {
  // 这几条是派发协议的要件（改文案可以，丢要件不行）。2026-09-13 的卡死事故正是「要件被误解」
  // 造成：旧文案「严禁重复派发同一任务」被模型当成「有派发记录就别派」的理由 → 见
  // .awf/bugs/dispatch-without-subagent-hangs-run.md
  it('subagentDispatch：填 taskId/taskTitle/taskPrompt，且保留四种要件', async () => {
    const res = await subagentDispatch({ taskId: 'R1', taskTitle: '审查 math 标题', taskPrompt: '审查 math' });
    expect(res).toBe(fill('subagent-dispatch', { taskId: 'R1', taskTitle: '审查 math 标题', taskPrompt: '审查 math' }));
    expect(res).toContain('subagent_type: ai-workflow-core:awf-worker'); // 约束身份化到 awf-worker
    expect(res).toContain('你的任务 ID 是 R1'); // 子 Agent prompt 开头声明任务 ID，防错写
    expect(res).toContain('NEEDS_INPUT'); // 决策上抛协议
    expect(res).toContain('AskUserQuestion'); // 主 Agent 收到 NEEDS_INPUT 必须问用户
  });

  it('subagentDispatch：不再出现「严禁重复派发同一任务」这类会被当成不派理由的话术', async () => {
    const res = await subagentDispatch({ taskId: 'T3', taskTitle: 't', taskPrompt: 'p' });
    expect(res).not.toContain('严禁重复派发同一任务');
  });

  it('subagentRedispatch：点明上一回合没起子 Agent，并要求立刻补救', async () => {
    const res = await subagentRedispatch({ taskId: 'T3', taskPrompt: '做事' });
    expect(res).toBe(fill('subagent-redispatch', { taskId: 'T3', taskPrompt: '做事' }));
    expect(res).toContain('没有任何子 Agent 被派生');
    expect(res).toContain('你的任务 ID 是 T3');
    expect(res).not.toContain('{taskId}'); // 占位符必须被填掉，不能被当成协议字面发出去
  });
});

describe('stateTemplatePath — 插件资产路径（包根单源）', () => {
  it('指向已安装插件的 awf-state 模板，且文件真实存在', () => {
    const p = stateTemplatePath();
    expect(p.endsWith('state.template.json')).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
  });
});
