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
    // 只查 T-P1-04/T-P3-01 抽出来的平台参数：提示词里还有 `NEEDS_INPUT: {json}` 这类协议字面量，不能一概而论
    const PLATFORM_PLACEHOLDERS = /\{(workerAgentType|workerSpawn|agentTool|askUserTool|agentMessageTool|workerPromptNote|devCommand|contextSkill|architectureSkill|reviewArchitectureSkill)\}/;
    for (const key of ['subagent-dispatch', 'subagent-redispatch', 'gate-fix', 'context-check', 'batch-dispatch']) {
      const text = await CASES[key]();
      expect(text, `${key} 残留平台参数占位符`).not.toMatch(PLATFORM_PLACEHOLDERS);
    }
    // 平台参数的值可以引用别的平台参数（如 worker-spawn 里的 {workerAgentType}）—— 两遍填要真填掉
    const dsh = await subagentDispatch({ taskId: 'T1', taskPrompt: '做A', adapter: 'dsh' });
    expect(dsh).not.toMatch(PLATFORM_PLACEHOLDERS);
  });
});

/**
 * 平台措辞（T-P3-01）：同一份编排模板，按**各平台插件包自己声明的** platform-vars
 * 填各自的工具名与参数。
 * cc：`Agent 工具（subagent_type: …）` / `AskUserQuestion` / `SendMessage`；
 * DSH：`awf_worker 工具`（平台没有 subagent_type，命名身份靠专用工具实例）/
 *      `ask_user_question` / `send_message`；输出协议固化在 awf_worker 身份里，不重复写进正文。
 * 这里**不冻结 DSH 全文**（它是新文案，会随实测调整），只钉住「换平台确实换了措辞」这条结构断言。
 */
describe('平台参数住在各自的插件包（不再交叉）', () => {
  const ccVars = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/adapters/cc/plugin/plugin-code/prompts.json'), 'utf8'));
  const dshVars = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/adapters/dsh/plugin/prompts.json'), 'utf8'));

  it('cc 的 prompts.json 里不再有 dsh 的口径（不交叉）', () => {
    expect(ccVars['platform-vars-dsh']).toBeUndefined();
    expect(JSON.stringify(ccVars)).not.toContain('awf_worker');
  });

  it('dsh 的插件包自带一份完整 platform-vars（缺项会报错，不回落 cc）', () => {
    const cc = Object.keys(ccVars['platform-vars']).sort();
    const dsh = Object.keys(dshVars['platform-vars']).sort();
    expect(dsh).toEqual(cc); // 键集必须一致：少一个就是漏配，多一个说明模板不再需要它
  });

  it('dsh 的 plan 入口模板声明了取哪条命令的正文', () => {
    expect(dshVars['plan-entry'].command).toBe('w-plan');
    expect(dshVars['platform-vars']['plan-entry-mode']).toBe('expand-command');
    expect(ccVars['platform-vars']['plan-entry-mode']).toBe('command');
  });
});

describe('plan 入口按平台选形态（cc 斜杠命令 vs dsh 展开指令）', () => {
  it('cc：入口仍是斜杠命令（行为不变）', async () => {
    const t = await planEntry('需求D', false, { adapter: 'cc' });
    expect(t).toBe('/ai-workflow-code:w-plan 需求D');
  });

  // 以前这里内联过一份「浓缩规划指令」—— 那是 commands/w-plan.md 的缩水副本，
  // 命令改了它不会跟着变（两份真值）。现在入口**直接展开插件命令 md 的正文**。
  it('dsh：入口 = 插件 w-plan.md 的正文（单源）+ 需求原文；不发命令字面量', async () => {
    const t = await planEntry('设计一个 Prompt 模板系统', false, { adapter: 'dsh' });
    const md = fs.readFileSync(path.join(ROOT, 'server/adapters/dsh/plugin/commands/w-plan.md'), 'utf8');
    const body = md.slice(md.indexOf('\n---\n') + 5).trim(); // 去掉 frontmatter

    expect(t).not.toContain('/ai-workflow-code:w-plan'); // 平台不执行命令字面量，发了＝让模型猜
    expect(t).toContain(body);                            // 正文原样来自 md（单源，不是代码里的副本）
    expect(t.startsWith('---')).toBe(false);              // frontmatter 不该进提示词
    expect(t).not.toContain('empty-input:');
    expect(t).toContain('设计一个 Prompt 模板系统');        // 需求原文完整带上
    expect(t).toContain('不得截断');
  });

  it('dsh：入口正文随 md 变，不随代码变', async () => {
    // 断言「读的是文件」而不是「代码里有一份」：把 md 的首行当作指纹比一下
    const md = fs.readFileSync(path.join(ROOT, 'server/adapters/dsh/plugin/commands/w-plan.md'), 'utf8');
    const firstHeading = md.split('\n').find((l) => l.startsWith('# '));
    const t = await planEntry('X', false, { adapter: 'dsh' });
    expect(t).toContain(firstHeading);
  });

  it('dsh 无描述：明确要求先问清需求，而不是硬猜', async () => {
    const t = await planEntry(undefined, false, { adapter: 'dsh' });
    expect(t).toContain('ask_user_question');
    expect(t).toContain('要做什么');
  });

  it('dsh 恢复：点明这是恢复，不要从头重问', async () => {
    const t = await planEntry('继续上次', true, { adapter: 'dsh' });
    expect(t).toContain('恢复');
    expect(t).toContain('继续上次');
  });
});

describe('平台措辞按平台填（cc vs dsh）', () => {
  it('cc：用 Agent 工具 + subagent_type + AskUserQuestion/SendMessage', async () => {
    const t = await subagentDispatch({ taskId: 'T1', taskPrompt: '做A', adapter: 'cc' });
    expect(t).toContain('用 Agent 工具（subagent_type: ai-workflow-core:awf-worker, run_in_background: true）');
    expect(t).toContain('用 AskUserQuestion 问用户');
    expect(t).toContain('用 SendMessage 恢复该子 Agent');
  });

  // DSH 侧原先「没有 awf-worker 身份」是事实错误：命名身份靠一个独立的 tool-subagent 实例表达
  // （toolName=awf_worker + persona + toolFilter），协议正文同样固化在身份里，不再塞进任务正文。
  it('dsh：用 awf_worker 专用工具（无 subagent_type）+ ask_user_question/send_message + 协议走身份', async () => {
    const t = await subagentDispatch({ taskId: 'T1', taskPrompt: '做A', adapter: 'dsh' });
    expect(t).toContain('用 awf_worker 工具');
    expect(t).toContain('run_in_background: true');
    expect(t).not.toContain('subagent_type');
    expect(t).toContain('用 ask_user_question 问用户');
    expect(t).toContain('用 send_message 恢复该子 Agent');
    expect(t).toContain('输出格式已固化在 awf_worker 身份'); // 身份承载协议，正文不再重复一份
    expect(t).not.toContain('输出协议必须写进任务正文');

    const re = await subagentRedispatch({ taskId: 'T1', taskPrompt: '做A', adapter: 'dsh' });
    expect(re).toContain('用 awf_worker 工具');
    expect(re).not.toContain('subagent_type');

    const re2 = await subagentResend({ agentId: 'c1', reason: 'no valid RESULT', adapter: 'dsh' });
    expect(re2).toContain('用 send_message（to=该子 Agent）');

    const batch = await batchDispatch({ batchId: 'B1', tasks: '- T1 [dev] 做A\n  提示词：p1', adapter: 'dsh' });
    expect(batch).toContain('不得直接 ask_user_question');
    expect(batch).not.toContain('AskUserQuestion');
  });
});
