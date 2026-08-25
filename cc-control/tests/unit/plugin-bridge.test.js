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
};

vi.mock('../../src/lib/paths.js', () => ({
  getPaths: vi.fn(() => ({ projectRoot: FAKE_ROOT })),
}));

import { planEntry, resolvePrompt, stateTemplatePath, taskWrapup, contextCheck } from '../../src/lib/plugin-bridge.js';

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
