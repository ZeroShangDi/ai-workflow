import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mockExecSync, mockSpawn } from '../helpers/mock-child-process.js';

const { mockFindNextTask, mockLoadState } = vi.hoisted(() => ({
  mockFindNextTask: vi.fn(() => null),
  mockLoadState: vi.fn(() => null),
}));

vi.mock('../../src/cli/state.js', () => ({
  loadState: mockLoadState,
  findNextTask: mockFindNextTask,
  saveState: vi.fn(),
}));

vi.mock('../../src/cli/auto-selector.js', () => ({
  autoSelect: vi.fn(() => Promise.resolve({ index: 1 })),
}));

vi.mock('../../src/cli/paths.js', () => ({
  getPaths: vi.fn(() => ({
    projectRoot: '/tmp/mock-project',
    claudePlugins: '/tmp/mock-plugins',
    ccSettings: '/tmp/mock-settings.json',
    tmuxServer: '/tmp/server.cjs',
    bootstrapScript: '/tmp/bootstrap.sh',
  })),
  pluginCmd: vi.fn((cmd) => `/ai-workflow:${cmd}`),
  PLUGIN_NS: 'ai-workflow',
}));

const httpState = vi.hoisted(() => ({
  statusResponse: JSON.stringify({ state: 'ready' }),
  sendResponse: JSON.stringify({ ok: true }),
}));

vi.mock('node:http', async () => {
  const { EventEmitter: EE } = await import('node:events');

  function fakeGet(url, cb) {
    const req = new EE();
    req.setTimeout = vi.fn();
    req.destroy = vi.fn();
    req.abort = vi.fn();

    if (typeof url === 'string' && url.includes('/status')) {
      setImmediate(() => {
        const res = new EE();
        try { cb(res); } catch (e) { /* ok */ }
        setImmediate(() => { res.emit('data', httpState.statusResponse); res.emit('end'); });
      });
    } else {
      setImmediate(() => {
        const res = new EE();
        try { cb(res); } catch (e) { /* ok */ }
        setImmediate(() => { res.emit('data', '{}'); res.emit('end'); });
      });
    }
    return req;
  }

  function fakeRequest(url, opts, cb) {
    const req = new EE();
    req.write = vi.fn();
    req.end = vi.fn();
    const handler = typeof opts === 'function' ? opts : cb;

    setImmediate(() => {
      const res = new EE();
      try { handler(res); } catch (e) { /* ok */ }
      const body = (typeof url === 'string' && url.includes('/send'))
        ? httpState.sendResponse : '{}';
      setImmediate(() => { res.emit('data', body); res.emit('end'); });
    });
    return req;
  }

  const mod = { get: fakeGet, request: fakeRequest };
  return { ...mod, default: mod };
});

import { runCommand } from '../../src/cli/run.js';

function stateWith(overrides) {
  return { currentState: 'CODE', plan: { tasks: [] }, ...overrides };
}

function tasksDone(tasks) {
  return tasks.map((t) => ({ ...t, status: 'done' }));
}

describe('runCommand', () => {
  beforeEach(() => {
    vi.spyOn(process, 'cwd').mockReturnValue('/tmp/mock-cwd');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    httpState.statusResponse = JSON.stringify({ state: 'ready' });
    httpState.sendResponse = JSON.stringify({ ok: true });

    mockExecSync.mockImplementation(() => Buffer.from(''));
    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter();
      proc.unref = vi.fn();
      return proc;
    });

    mockLoadState.mockReset();
    mockFindNextTask.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── TC1 ──

  it('TC1: state.json 不存在 → 退出', async () => {
    mockLoadState.mockReturnValue(null);
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    await expect(runCommand(undefined, {})).rejects.toThrow('process.exit');
  });

  // ── TC2 ──

  it('TC2: state.json 正常加载 → 进入主流程', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(() => {});

    const tasks = [{ id: 'T1', desc: 't1', status: 'pending', prompt: 'do it' }];
    // loadState sequence: initial → runLoop → waitForTaskDone (done!) → runLoop → final
    mockLoadState
      .mockReturnValueOnce(stateWith({ plan: { tasks } }))
      .mockReturnValueOnce(stateWith({ plan: { tasks } }))
      .mockReturnValue(stateWith({ plan: { tasks: tasksDone(tasks) }, currentState: 'FINISH' }));
    mockFindNextTask
      .mockReturnValueOnce(tasks[0])
      .mockReturnValue(null);

    const promise = runCommand(undefined, {});
    await vi.advanceTimersByTimeAsync(5000);
    await promise;
    vi.useRealTimers();

    expect(mockLoadState).toHaveBeenCalled();
  });

  // ── TC10 ──

  it('TC10: 无 pending 任务时 break', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(() => {});

    const tasks = [{ id: 'T1', desc: 't1', status: 'done' }];
    mockLoadState.mockReturnValue(stateWith({ plan: { tasks } }));
    mockFindNextTask.mockReturnValue(null);

    const promise = runCommand(undefined, {});
    await vi.advanceTimersByTimeAsync(2000);
    await promise;
    vi.useRealTimers();

    expect(mockFindNextTask).toHaveBeenCalled();
  });

  // ── TC6 ──

  it('TC6: SIGINT 注册清理处理器', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'exit').mockImplementation(() => {});

    const tasks = [{ id: 'T1', desc: 't1', status: 'done' }];
    mockLoadState.mockReturnValue(stateWith({ plan: { tasks } }));
    mockFindNextTask.mockReturnValue(null);

    const onSpy = vi.spyOn(process, 'on');

    const promise = runCommand(undefined, {});
    await vi.advanceTimersByTimeAsync(2000);
    await promise;
    vi.useRealTimers();

    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  });

  // ── TC12 ──

  it('TC12: /send 返回非 ok → timeout', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(() => {});

    httpState.sendResponse = JSON.stringify({ ok: false, error: 'session busy' });

    const tasks = [{ id: 'T1', desc: 't1', status: 'pending', prompt: 'p' }];
    mockLoadState
      .mockReturnValueOnce(stateWith({ plan: { tasks } }))
      .mockReturnValueOnce(stateWith({ plan: { tasks } }))
      .mockReturnValue(stateWith({ plan: { tasks: tasksDone(tasks) }, currentState: 'FINISH' }));
    mockFindNextTask
      .mockReturnValueOnce(tasks[0])
      .mockReturnValueOnce(tasks[0])
      .mockReturnValue(null);

    const promise = runCommand(undefined, {});
    await vi.advanceTimersByTimeAsync(3000);
    await promise;
    vi.useRealTimers();
  });

  // ── TC3 ──

  it('TC3: ensureServer 成功启动', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(() => {});

    httpState.statusResponse = JSON.stringify({ state: 'ready' });

    const tasks = [{ id: 'T1', desc: 't1', status: 'pending', prompt: 'p' }];
    mockLoadState
      .mockReturnValueOnce(stateWith({ plan: { tasks } }))
      .mockReturnValueOnce(stateWith({ plan: { tasks } }))
      .mockReturnValue(stateWith({ plan: { tasks: tasksDone(tasks) }, currentState: 'FINISH' }));
    mockFindNextTask
      .mockReturnValueOnce(tasks[0])
      .mockReturnValue(null);

    const promise = runCommand(undefined, {});
    await vi.advanceTimersByTimeAsync(5000);
    await promise;
    vi.useRealTimers();

    expect(mockSpawn).toHaveBeenCalledWith('node', ['/tmp/server.cjs'], expect.any(Object));
  });

  // ── TC17 ──

  it('TC17: 超时后回查 state 发现 done → 继续', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(() => {});

    httpState.sendResponse = JSON.stringify({ ok: false, error: 'timeout' });

    const tasks = [{ id: 'T1', desc: 't1', status: 'done', prompt: 'p' }];
    mockLoadState
      .mockReturnValueOnce(stateWith({ plan: { tasks } }))
      .mockReturnValueOnce(stateWith({ plan: { tasks } }))
      .mockReturnValue(stateWith({ plan: { tasks }, currentState: 'FINISH' }));
    mockFindNextTask
      .mockReturnValueOnce(tasks[0])
      .mockReturnValue(null);

    const promise = runCommand(undefined, {});
    await vi.advanceTimersByTimeAsync(3000);
    await promise;
    vi.useRealTimers();
  });

  // ── TC16 ──

  it('TC16: 连续 2 次超时 → 跳过任务', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(() => {});

    httpState.sendResponse = JSON.stringify({ ok: false, error: 'busy' });

    const tasks = [{ id: 'T1', desc: 't1', status: 'pending', prompt: 'p' }];
    mockLoadState
      .mockReturnValueOnce(stateWith({ plan: { tasks } }))
      .mockReturnValueOnce(stateWith({ plan: { tasks } }))
      .mockReturnValueOnce(stateWith({ plan: { tasks } }))
      .mockReturnValue(stateWith({ plan: { tasks: tasksDone(tasks) }, currentState: 'FINISH' }));
    mockFindNextTask
      .mockReturnValueOnce(tasks[0])
      .mockReturnValueOnce(tasks[0])
      .mockReturnValueOnce(tasks[0])
      .mockReturnValue(null);

    const promise = runCommand(undefined, {});
    await vi.advanceTimersByTimeAsync(5000);
    await promise;
    vi.useRealTimers();
  });
});
