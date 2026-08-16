import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mockExecSync, mockSpawn } from '../helpers/mock-child-process.js';

const { mockFindNextTask, mockLoadState } = vi.hoisted(() => ({
  mockFindNextTask: vi.fn(() => null),
  mockLoadState: vi.fn(() => null),
}));

vi.mock('../../src/lib/state.js', () => ({
  loadState: mockLoadState,
  findNextTask: mockFindNextTask,
  backupState: vi.fn(),
  saveState: vi.fn(),
}));

vi.mock('../../src/lib/session/client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    autoSelect: vi.fn(() => Promise.resolve({ index: 1 })),
    sleep: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('../../src/lib/paths.js', () => ({
  getPaths: vi.fn(() => ({
    projectRoot: '/tmp/mock-project',
    claudePlugins: '/tmp/mock-plugins',
    ccSettings: '/tmp/mock-settings.json',
    tmuxServer: '/tmp/server.cjs',
    bootstrapScript: '/tmp/bootstrap.sh',
  })),
}));

// plugin-bridge 为插件边界模块，单测 mock（真实逻辑见 plugin-bridge.test.js）
vi.mock('../../src/lib/plugin-bridge.js', () => ({
  taskWrapup: vi.fn((taskId) => `用 awf_task_status 标记 ${taskId} done。用 awf_task_result 记录 ${taskId} 的执行结果。只做这两步。`),
  taskSettle: vi.fn((taskId) => `任务 ${taskId} 尚未标记 done，请明确状态三选一。`),
}));

import { taskWrapup, taskSettle } from '../../src/lib/plugin-bridge.js';

const httpState = vi.hoisted(() => ({
  statusResponse: JSON.stringify({ state: 'ready' }),
  sendResponse: JSON.stringify({ ok: true }),
  statusSequence: null, // 按序返回 /status 响应，供「启动后变 busy」场景
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
        setImmediate(() => {
          const body = (httpState.statusSequence && httpState.statusSequence.length)
            ? httpState.statusSequence.shift()
            : httpState.statusResponse;
          res.emit('data', body); res.emit('end');
        });
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
  return { currentState: 'CODE', tasks: [], ...overrides };
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
    httpState.statusSequence = null;

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
    vi.useRealTimers(); // 防止断言失败时 fake timers 泄漏到后续测试
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

    const tasks = [{ id: 'T1', title: 't1', status: 'pending', prompt: 'do it' }];
    // loadState sequence: initial → runLoop → waitForTaskDone (done!) → runLoop → final
    mockLoadState
      .mockReturnValueOnce(stateWith({ tasks }))
      .mockReturnValueOnce(stateWith({ tasks }))
      .mockReturnValue(stateWith({ tasks: tasksDone(tasks), currentState: 'FINISH' }));
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

    const tasks = [{ id: 'T1', title: 't1', status: 'done' }];
    mockLoadState.mockReturnValue(stateWith({ tasks }));
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

    const tasks = [{ id: 'T1', title: 't1', status: 'done' }];
    mockLoadState.mockReturnValue(stateWith({ tasks }));
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

  it('TC12: /send 非 ok → timeout → 任务仍 pending 即将重试', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(() => {});

    httpState.sendResponse = JSON.stringify({ ok: false, error: 'session busy' });

    const tasks = [{ id: 'T1', title: 't1', status: 'pending', prompt: 'p' }];
    // 始终 pending：超时后回查仍 pending → 触发「即将重试」warn
    mockLoadState.mockReturnValue(stateWith({ tasks }));
    mockFindNextTask
      .mockReturnValueOnce(tasks[0])
      .mockReturnValueOnce(tasks[0])
      .mockReturnValue(null);

    const promise = runCommand(undefined, {});
    await vi.advanceTimersByTimeAsync(3000);
    await promise;
    vi.useRealTimers();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('/send 失败: session busy'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('任务 T1 仍为 pending，即将重试'));
  });

  // ── TC3 ──

  it('TC3: ensureServer 成功启动', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(() => {});

    httpState.statusResponse = JSON.stringify({ state: 'ready' });

    const tasks = [{ id: 'T1', title: 't1', status: 'pending', prompt: 'p' }];
    mockLoadState
      .mockReturnValueOnce(stateWith({ tasks }))
      .mockReturnValueOnce(stateWith({ tasks }))
      .mockReturnValue(stateWith({ tasks: tasksDone(tasks), currentState: 'FINISH' }));
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

  it('TC17: waitForReady 超时后回查 state 发现 done → 继续', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(() => {});

    // /send 成功，但 CC 一直 busy → waitForReady 超时(300s) → 回查任务 done → 不报错继续
    httpState.sendResponse = JSON.stringify({ ok: true });
    httpState.statusSequence = [JSON.stringify({ state: 'ready' })]; // ensureServer 启动检测
    httpState.statusResponse = JSON.stringify({ state: 'busy' });    // waitForReady 永不 ready

    const tasks = [{ id: 'T1', title: 't1', status: 'pending', prompt: 'p' }];
    const doneTasks = tasksDone(tasks);
    mockLoadState
      .mockReturnValueOnce(stateWith({ tasks }))       // runCommand 初始
      .mockReturnValueOnce(stateWith({ tasks }))       // runLoop 初始
      .mockReturnValue(stateWith({ tasks: doneTasks })); // checkTaskDone 回查 → done
    mockFindNextTask
      .mockReturnValueOnce(tasks[0])
      .mockReturnValue(null);

    const promise = runCommand(undefined, {});
    await vi.advanceTimersByTimeAsync(310000); // 超过 READY_TIMEOUT(300s)
    await promise;
    vi.useRealTimers();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('超时但任务 T1 已完成'));
  });

  // ── TC16 ──

  it('TC16: 连续 2 次超时 → 跳过任务', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(() => {});

    httpState.sendResponse = JSON.stringify({ ok: false, error: 'busy' });

    const tasks = [{ id: 'T1', title: 't1', status: 'pending', prompt: 'p' }];
    // 始终 pending：2 次超时后触发「跳过任务」error
    mockLoadState.mockReturnValue(stateWith({ tasks }));
    mockFindNextTask
      .mockReturnValueOnce(tasks[0])
      .mockReturnValueOnce(tasks[0])
      .mockReturnValueOnce(tasks[0])
      .mockReturnValueOnce(tasks[0])
      .mockReturnValue(null);

    const promise = runCommand(undefined, {});
    await vi.advanceTimersByTimeAsync(5000);
    await promise;
    vi.useRealTimers();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('任务 T1 仍为 pending，即将重试'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('连续 2 次超时，跳过任务 T1'));
  });

  // ── TC18 ──

  it('TC18: 任务未标记 done → 补发收尾 prompt（taskWrapup）', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(() => {});
    taskWrapup.mockClear();

    httpState.statusResponse = JSON.stringify({ state: 'ready' });
    httpState.sendResponse = JSON.stringify({ ok: true });

    const tasks = [{ id: 'T1', title: 't1', status: 'pending', prompt: 'p' }];
    const doneTasks = tasksDone(tasks);
    // loadState 调用序: runCommand(pending) → runLoop(pending) → ensureTaskDone 回查(pending→补发) → 收尾后回查(done) → runLoop 重载(done/FINISH)
    mockLoadState
      .mockReturnValueOnce(stateWith({ tasks }))
      .mockReturnValueOnce(stateWith({ tasks }))
      .mockReturnValueOnce(stateWith({ tasks }))
      .mockReturnValueOnce(stateWith({ tasks: doneTasks }))
      .mockReturnValue(stateWith({ tasks: doneTasks, currentState: 'FINISH' }));
    mockFindNextTask
      .mockReturnValueOnce(tasks[0])
      .mockReturnValue(null);

    const promise = runCommand(undefined, {});
    await vi.advanceTimersByTimeAsync(5000);
    await promise;
    vi.useRealTimers();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('任务 T1 未标记 done，补发收尾 prompt'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('收尾 prompt 已生效'));
    expect(taskWrapup).toHaveBeenCalledWith('T1');
  });

  // ── TC19 ──

  it('TC19: 收尾未生效 → 追问一轮 → 任务完成', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(() => {});
    taskWrapup.mockClear();
    taskSettle.mockClear();

    httpState.statusResponse = JSON.stringify({ state: 'ready' });
    httpState.sendResponse = JSON.stringify({ ok: true });

    const tasks = [{ id: 'T1', title: 't1', status: 'pending', prompt: 'p' }];
    const doneTasks = tasksDone(tasks);
    // loadState 调用序: runCommand → runLoop → settleTask 首查(pending) → wrapup 后查(pending) → 追问后查(done) → runLoop 重载(done/FINISH)
    mockLoadState
      .mockReturnValueOnce(stateWith({ tasks }))
      .mockReturnValueOnce(stateWith({ tasks }))
      .mockReturnValueOnce(stateWith({ tasks }))
      .mockReturnValueOnce(stateWith({ tasks }))
      .mockReturnValueOnce(stateWith({ tasks: doneTasks }))
      .mockReturnValue(stateWith({ tasks: doneTasks, currentState: 'FINISH' }));
    mockFindNextTask
      .mockReturnValueOnce(tasks[0])
      .mockReturnValue(null);

    const promise = runCommand(undefined, {});
    await vi.advanceTimersByTimeAsync(5000);
    await promise;
    vi.useRealTimers();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('任务 T1 仍为 pending，追问（第 1/3 轮）'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('任务 T1 已完成'));
    expect(taskSettle).toHaveBeenCalledWith('T1');
  });

  // ── TC20 ──

  it('TC20: 追问 3 轮仍未完成 → 标 blocked 跳过', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(() => {});
    taskWrapup.mockClear();
    taskSettle.mockClear();

    httpState.statusResponse = JSON.stringify({ state: 'ready' });
    httpState.sendResponse = JSON.stringify({ ok: true });

    const tasks = [{ id: 'T1', title: 't1', status: 'pending', prompt: 'p' }];
    // 始终 pending：wrapup 未生效 + 追问 3 轮均 pending → stuck → markTaskBlocked
    mockLoadState.mockReturnValue(stateWith({ tasks }));
    mockFindNextTask
      .mockReturnValueOnce(tasks[0])
      .mockReturnValue(null);

    const promise = runCommand(undefined, {});
    await vi.advanceTimersByTimeAsync(5000);
    await promise;
    vi.useRealTimers();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('任务 T1 多轮追问后仍未完成，标记 blocked 并跳过'));
    expect(taskSettle).toHaveBeenCalledTimes(3);
  });
});
