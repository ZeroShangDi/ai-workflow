import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const { mockLaunch } = vi.hoisted(() => ({ mockLaunch: vi.fn() }));

vi.mock('../../src/lib/ui/log.js', () => ({ logger: mockLogger }));
// plugin-bridge 为插件边界模块，单测 mock（真实逻辑见 plugin-bridge.test.js）
vi.mock('../../src/lib/plugin-bridge.js', () => ({
  planEntry: vi.fn((description, resume) => {
    if (resume) return '/ai-workflow-code:w-plan --resume 请恢复上次规划会话，继续对齐需求';
    if (description) return `/ai-workflow-code:w-plan ${description}`;
    return '/ai-workflow-code:w-plan 请开始需求规划';
  }),
}));
// claude 字面已移入 interactive adapter：plan.js 只委托 launchInteractiveClaude
vi.mock('../../src/adapters/interactive.cjs', () => ({
  launchInteractiveClaude: mockLaunch,
  projectSettingsPath: (c) => `${c}/.claude/settings.json`,
}));

import { planCommand } from '../../src/cli/plan.js';

describe('planCommand', () => {
  beforeEach(() => {
    vi.spyOn(process, 'cwd').mockReturnValue('/tmp/mock-cwd');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockLaunch.mockReset();
    mockLaunch.mockResolvedValue();
    mockLogger.info.mockReset();
    mockLogger.success.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const lastLaunch = () => mockLaunch.mock.calls.at(-1)[0];

  it('TC1: 有 description 正常执行（委托 adapter 带 prompt）', async () => {
    await planCommand('搭建测试基础设施', { resume: false });
    expect(lastLaunch().cwd).toBe('/tmp/mock-cwd');
    expect(lastLaunch().prompt).toContain('/ai-workflow-code:w-plan 搭建测试基础设施');
    expect(mockLogger.success).toHaveBeenCalledWith('规划会话结束');
  });

  it('TC2: 无 description 默认 prompt', async () => {
    await planCommand(undefined, { resume: false });
    expect(lastLaunch().prompt).toContain('/ai-workflow-code:w-plan 请开始需求规划');
  });

  it('TC3: --resume 恢复流程', async () => {
    await planCommand('任意文本', { resume: true });
    expect(lastLaunch().prompt).toContain('/ai-workflow-code:w-plan --resume 请恢复上次规划会话，继续对齐需求');
  });

  it('TC4/5: adapter resolve → success 记录', async () => {
    await planCommand('test', { resume: false });
    expect(mockLogger.success).toHaveBeenCalledWith('规划会话结束');
  });

  it('TC6: adapter reject（code≠0）→ 抛错且不记录 success', async () => {
    mockLaunch.mockRejectedValueOnce(new Error('claude 异常退出，code: 1'));
    await expect(planCommand('test', { resume: false })).rejects.toThrow('claude 异常退出，code: 1');
    expect(mockLogger.success).not.toHaveBeenCalled();
  });

  it('TC7: adapter error（claude 未安装）→ 抛错', async () => {
    mockLaunch.mockRejectedValueOnce(new Error('无法启动 claude: spawn claude ENOENT'));
    await expect(planCommand('test', { resume: false })).rejects.toThrow('无法启动 claude: spawn claude ENOENT');
  });

  it('TC10: prompt 三种分支分别委托', async () => {
    await planCommand('需求描述', { resume: false });
    await planCommand(undefined, { resume: false });
    await planCommand('任意', { resume: true });
    expect(mockLaunch).toHaveBeenCalledTimes(3);
    expect(mockLaunch.mock.calls[0][0].prompt).toContain('/ai-workflow-code:w-plan 需求描述');
    expect(mockLaunch.mock.calls[1][0].prompt).toContain('/ai-workflow-code:w-plan 请开始需求规划');
    expect(mockLaunch.mock.calls[2][0].prompt).toContain('--resume');
  });

  it('TC11: 委托 adapter 且传 cwd（claude 参数由 adapter 负责）', async () => {
    await planCommand('test', { resume: false });
    const arg = mockLaunch.mock.calls[0][0];
    expect(arg.cwd).toBe('/tmp/mock-cwd');
    expect(typeof arg.prompt).toBe('string');
    // --settings/--dangerously-skip-permissions 等 claude 字面不再出现在 cli（见 interactive-adapter）
  });
});
