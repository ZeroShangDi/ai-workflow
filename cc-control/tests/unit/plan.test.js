import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockSpawn } from '../helpers/mock-child-process.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// 版本号写入（setupVersion / saveState）在 src/cli/plan.js 暂时禁用，相关 mock 与用例一并移除。
// 重新启用版本处理时，需补回 version.js / state.js 的 vi.mock 及对应测试。

vi.mock('../../src/lib/ui/log.js', () => ({ logger: mockLogger }));
vi.mock('../../src/lib/paths.js', () => ({
  getPaths: vi.fn(() => ({
    projectRoot: '/tmp/mock-project',
    claudePlugins: '/tmp/mock-plugins',
    ccSettings: '/tmp/mock-settings.json',
  })),
  pluginCmd: vi.fn((cmd) => `/ai-workflow:${cmd}`),
  PLUGIN_NS: 'ai-workflow',
}));

import { planCommand } from '../../src/cli/plan.js';

function createMockProc() {
  const listeners = {};
  const proc = {
    on: vi.fn((event, cb) => { listeners[event] = cb; }),
  };
  return { proc, listeners };
}

describe('planCommand', () => {
  let mockProc;
  let listeners;

  beforeEach(() => {
    vi.spyOn(process, 'cwd').mockReturnValue('/tmp/mock-cwd');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    mockProc = createMockProc();
    listeners = mockProc.listeners;
    mockSpawn.mockReturnValue(mockProc.proc);

    mockLogger.info.mockReset();
    mockLogger.success.mockReset();
    mockSpawn.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── helpers ──

  function resolveClose(code = 0) {
    return new Promise((resolve) => {
      setImmediate(() => {
        listeners.close(code);
        resolve();
      });
    });
  }

  function rejectError(msg = 'spawn claude ENOENT') {
    return new Promise((resolve) => {
      setImmediate(() => {
        listeners.error(new Error(msg));
        resolve();
      });
    });
  }

  // ── 正常流程 ──

  it('TC1: 有 description 正常执行', async () => {
    const promise = planCommand('搭建测试基础设施', { resume: false });

    await resolveClose(0);
    await promise;

    // 版本号写入（setupVersion/saveState）已禁用，仅验证 spawn 与 prompt 拼接
    const spawnArgs = mockSpawn.mock.calls[0][1];
    expect(spawnArgs).toContain('/ai-workflow:w-plan 搭建测试基础设施');
  });

  it('TC2: 无 description 默认 prompt', async () => {
    const promise = planCommand(undefined, { resume: false });

    await resolveClose(0);
    await promise;

    const spawnArgs = mockSpawn.mock.calls[0][1];
    expect(spawnArgs).toContain('/ai-workflow:w-plan 请开始需求规划');
  });

  it('TC3: --resume 恢复流程', async () => {
    const promise = planCommand('任意文本', { resume: true });

    await resolveClose(0);
    await promise;

    const spawnArgs = mockSpawn.mock.calls[0][1];
    expect(spawnArgs).toContain('/ai-workflow:w-plan --resume 请恢复上次规划会话，继续对齐需求');
  });

  // ── 进程生命周期 ──

  it('TC4: spawn 正常退出 code=0', async () => {
    const promise = planCommand('test', { resume: false });

    await resolveClose(0);
    await promise;

    expect(mockLogger.success).toHaveBeenCalledWith('规划会话结束');
  });

  it('TC5: spawn 正常退出 code=null', async () => {
    const promise = planCommand('test', { resume: false });

    await resolveClose(null);
    await promise;

    expect(mockLogger.success).toHaveBeenCalledWith('规划会话结束');
  });

  it('TC6: spawn 异常退出 code≠0', async () => {
    const promise = planCommand('test', { resume: false });

    await resolveClose(1);

    await expect(promise).rejects.toThrow('claude 异常退出，code: 1');
    expect(mockLogger.success).not.toHaveBeenCalled();
  });

  it('TC7: spawn error 事件（claude 未安装）', async () => {
    const promise = planCommand('test', { resume: false });

    await rejectError('spawn claude ENOENT');

    await expect(promise).rejects.toThrow('无法启动 claude: spawn claude ENOENT');
  });

  // ── 参数分支 ──

  it('TC10: prompt 参数三种分支验证', async () => {
    // 有 description
    const p1 = planCommand('需求描述', { resume: false });
    await resolveClose(0);
    await p1;
    expect(mockSpawn.mock.calls[0][1]).toContain('/ai-workflow:w-plan 需求描述');

    // 无 description
    const p2 = planCommand(undefined, { resume: false });
    await resolveClose(0);
    await p2;
    expect(mockSpawn.mock.calls[1][1]).toContain('/ai-workflow:w-plan 请开始需求规划');

    // --resume
    const p3 = planCommand('任意', { resume: true });
    await resolveClose(0);
    await p3;
    expect(mockSpawn.mock.calls[2][1]).toContain('/ai-workflow:w-plan --resume 请恢复上次规划会话，继续对齐需求');
  });

  // ── spawn 参数验证 ──

  it('TC11: spawn args 验证', async () => {
    const promise = planCommand('test', { resume: false });

    await resolveClose(0);
    await promise;

    const [cmd, args, opts] = mockSpawn.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toContain('--settings');
    expect(args).toContain('/tmp/mock-cwd/.claude/settings.json');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(opts.stdio).toBe('inherit');
    expect(opts.cwd).toBe('/tmp/mock-cwd');
  });
});
