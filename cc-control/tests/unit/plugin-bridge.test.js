import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── fixture：临时项目里的插件 prompts.json（模拟 plugin/plugin-code/prompts.json）──
const FAKE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'cc-plugin-bridge-'));

const PROMPTS = {
  'plan-start': {
    prompt: '/ai-workflow-code:w-plan {desc}',
    description: 'awf plan 传入需求描述时的入口提示词',
  },
  'plan-resume': {
    prompt: '/ai-workflow-code:w-plan --resume 请恢复上次规划会话，继续对齐需求',
    description: 'awf plan --resume 恢复上次规划会话的入口提示词',
  },
  'plan-default': {
    prompt: '/ai-workflow-code:w-plan 请开始需求规划',
    description: 'awf plan 无描述时的默认入口提示词',
  },
  'task-wrapup': {
    prompt: '用 awf_task_status 标记 {taskId} done。用 awf_task_result 记录 {taskId} 的执行结果。只做这两步。',
    description: '任务未标记 done 时，补发的收尾 prompt（强制标记 + 记录）',
  },
  'context-check': {
    prompt: '上下文检查：当前占用：{usage}。只判断是否压缩，不做任何任务工作。低于 65% 回复 AWF_CONTEXT_OK，否则写快照并通知。',
    description: '每个任务执行前的上下文压缩检查',
  },
  'batch-dispatch': {
    prompt: '批次执行：本批次编号：{batchId}\n待执行任务：\n{tasks}\n并行派生子 Agent，子 Agent 不写 state。',
    description: '多任务批次派发',
  },
  'batch-reconcile': {
    prompt: '批次 {batchId} 尚有任务未标记 done，请核对收尾，不要重新执行。',
    description: '批次收尾 reconcile prompt',
  },
  'subagent-dispatch': {
    prompt: '请用 Agent 工具（subagent_type: ai-workflow-core:awf-worker, run_in_background: true）派生一个后台子 Agent 执行任务 {taskId}。只派生一个且只派生一次，严禁重复派发同一任务、严禁派生其他任务。子 Agent prompt（必须在开头声明『你的任务 ID 是 {taskId}』）：{taskPrompt}。【决策上抛】若子 Agent 返回 NEEDS_INPUT，你必须用 AskUserQuestion 问用户，获答后 SendMessage 恢复子 Agent。',
    description: '滑动窗口单任务派发',
  },
};

vi.mock('../../src/lib/paths.js', () => ({
  getPaths: vi.fn(() => ({ projectRoot: FAKE_ROOT })),
}));

import { planEntry, resolvePrompt, stateTemplatePath, taskWrapup, contextCheck, batchDispatch, batchReconcile, subagentDispatch } from '../../src/lib/plugin-bridge.js';

beforeAll(async () => {
  const dir = path.join(FAKE_ROOT, 'plugin', 'plugin-code');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'prompts.json'), JSON.stringify(PROMPTS, null, 2));
});

afterAll(async () => {
  await fs.rm(FAKE_ROOT, { recursive: true, force: true });
});

describe('planEntry — 场景选模板', () => {
  it('有 description → plan-start，填充 {desc}', async () => {
    expect(await planEntry('搭建测试基础设施', false)).toBe('/ai-workflow-code:w-plan 搭建测试基础设施');
  });

  it('无 description → plan-default', async () => {
    expect(await planEntry(undefined, false)).toBe('/ai-workflow-code:w-plan 请开始需求规划');
  });

  it('--resume → plan-resume（优先于 description）', async () => {
    expect(await planEntry('任意文本', true)).toBe('/ai-workflow-code:w-plan --resume 请恢复上次规划会话，继续对齐需求');
  });
});

describe('resolvePrompt — 模板读取与占位符', () => {
  it('填充 {desc}，description 内特殊字符原样保留', async () => {
    const res = await resolvePrompt('plan-start', { desc: 'A / 需求 {x} 等' });
    expect(res).toBe('/ai-workflow-code:w-plan A / 需求 {x} 等');
  });

  it('未知 key → 抛错', async () => {
    await expect(resolvePrompt('no-such-key')).rejects.toThrow('prompt template not found: no-such-key');
  });
});

describe('stateTemplatePath — 插件内部路径收敛', () => {
  it('从 getPaths().projectRoot 派生 awf-state 模板路径', () => {
    expect(stateTemplatePath()).toBe(path.join(FAKE_ROOT, 'plugin', 'core', 'mcp', 'awf-state', 'state.template.json'));
  });
});

describe('taskWrapup — 任务收尾 prompt', () => {
  it('填充 {taskId}，使用插件模板中的 MCP tool 指令', async () => {
    expect(await taskWrapup('T3')).toBe('用 awf_task_status 标记 T3 done。用 awf_task_result 记录 T3 的执行结果。只做这两步。');
  });
});

describe('contextCheck — 任务前上下文检查 prompt', () => {
  it('填充 {usage} 占位符（statusline 实测 / 未知回退）', async () => {
    expect(await contextCheck('已用约 62%（statusline 实测）')).toContain('当前占用：已用约 62%（statusline 实测）');
    expect(await contextCheck('未知（statusline 未配置，请自行估算）')).toContain('当前占用：未知（statusline 未配置，请自行估算）');
  });
});

describe('batchDispatch — 批次派发 prompt', () => {
  it('填充 {batchId}，把任务数组序列化为可读列表（taskId/kind/title/prompt）', async () => {
    const res = await batchDispatch({
      batchId: 'B1',
      tasks: [
        { taskId: 'T1', title: '做 A', kind: 'dev', prompt: '/ai-workflow-code:w-dev <task>…' },
        { taskId: 'T2', title: '做 B', kind: 'review', prompt: '审查 A' },
      ],
    });
    expect(res).toContain('本批次编号：B1');
    expect(res).toContain('- T1 [dev] 做 A');
    expect(res).toContain('提示词：/ai-workflow-code:w-dev <task>…');
    expect(res).toContain('- T2 [review] 做 B');
    expect(res).toContain('子 Agent 不写 state');
  });
});

describe('batchReconcile — 批次收尾 prompt', () => {
  it('填充 {batchId}，明确不重新执行', async () => {
    expect(await batchReconcile('B1')).toContain('批次 B1 尚有任务未标记 done');
    expect(await batchReconcile('B1')).toContain('不要重新执行');
  });
});

describe('subagentDispatch — 滑动窗口单任务派发', () => {
  it('填充 taskId + taskPrompt，用 awf-worker 类型 + 只派生一次 + 声明任务 ID + 决策上抛', async () => {
    const res = await subagentDispatch({ taskId: 'R1', taskPrompt: '审查 math' });
    expect(res).toContain('subagent_type: ai-workflow-core:awf-worker'); // 约束身份化到 awf-worker
    expect(res).toContain('执行任务 R1');
    expect(res).toContain('只派生一个且只派生一次'); // 防重复派发同一任务
    expect(res).toContain('严禁派生其他任务'); // 防擅自追加
    expect(res).toContain('你的任务 ID 是 R1'); // 子 Agent prompt 开头声明任务 ID 防错写
    expect(res).toContain('NEEDS_INPUT'); // 决策上抛协议
    expect(res).toContain('AskUserQuestion'); // 主 Agent 收到 NEEDS_INPUT 必须问用户
    expect(res).toContain('审查 math');
  });
});
