import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// run.js（T1-058 薄化后）：提交 run → 订阅事件/状态展示 → 人机应答中继 → 收尾。
// 编排在 server run host；本套件 mock run-client/session/子进程，聚焦 run.js 保留的
// 控制流（mode 复位、--resume 闩锁、环境拉起、异常保留现场）与新的 submit/observe/relay。

// 本套件无真实 tmux/SessionStart → 会话就绪等待直接放行（该等待由 session-ready-wait 单测覆盖）
process.env.CC_SESSION_READY_TIMEOUT_MS = '0';

const m = vi.hoisted(() => ({
  loadState: vi.fn(() => null),
  installProjectMcp: vi.fn(() => ({ written: false, servers: [] })),
  generateRunSettings: vi.fn(() => ({ statusLine: {} })), // T1-065 已移除 crossSessionInbound（inbox 死代码）
  waitWhilePaused: vi.fn(async () => {}),
  getStatus: vi.fn(async () => ({ state: 'ready' })),
  httpPost: vi.fn(async () => ({})),
  httpPostJson: vi.fn(async () => ({ ok: true })),
  autoSelect: vi.fn(async () => ({ index: 1 })),
  waitForReady: vi.fn(async () => true),
  execSync: vi.fn(() => Buffer.from('')),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  client: {
    submitRun: vi.fn(async () => ({ ok: true, runId: 'default', mode: 'single' })),
    pollRunEvents: vi.fn(async () => ({ events: [], tailSeq: 0, afterSeq: 0 })),
    runSnapshot: vi.fn(async () => ({ ok: true, run: { status: 'done', counts: { total: 1, done: 1, blocked: 0 } } })),
    setRunMode: vi.fn(async () => ({ ok: true })),
  },
}));

vi.mock('../../src/lib/state.js', () => ({ loadState: m.loadState }));
vi.mock('../../src/lib/run-config.js', () => ({ loadRunConfig: vi.fn(() => ({ agents: { max: 1 } })) }));
vi.mock('../../src/lib/pause.js', () => ({ waitWhilePaused: m.waitWhilePaused }));
vi.mock('../../src/lib/profile.js', () => ({ installProjectMcp: m.installProjectMcp }));
vi.mock('../../src/lib/run-context.cjs', () => ({
  buildRunContext: vi.fn(() => ({
    sid: null, session: 'cc', runSessionName: 'cc', port: 8787,
    projectRoot: '/tmp/mock-cwd', infraRoot: '/tmp/mock-project',
    serverScriptPath: '/tmp/server.cjs', bootstrapScriptPath: '/tmp/bootstrap.sh',
    runSettingsPath: '/tmp/mock-project/.awf/run-settings.json',
  })),
  projectSid: vi.fn(() => 'p12ab'),
}));
vi.mock('../../src/server/run-settings.cjs', () => ({ generateRunSettings: m.generateRunSettings }));
vi.mock('../../src/cli/run-client.js', () => ({ createRunClient: vi.fn(() => m.client) }));
vi.mock('../../src/lib/session/client.js', () => ({
  httpPost: m.httpPost,
  httpPostJson: m.httpPostJson,
  autoSelect: m.autoSelect,
  waitForReady: m.waitForReady,
  getStatus: m.getStatus,
  projectQuery: () => '',
  SERVER_PORT: 8787,
}));

const mkdir = vi.hoisted(() => vi.fn());
const writeFile = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', () => ({ default: { mkdir, writeFile }, mkdir, writeFile }));

vi.mock('node:child_process', () => ({ spawn: m.spawn, execSync: m.execSync }));

import { runCommand } from '../../src/cli/run.js';

function stateWith(overrides) {
  return { currentState: 'CODE', tasks: [], ...overrides };
}

/** 默认：宿主空闲（无 run 列表）；按 runId 查 → 已 done（观察环即刻收敛） */
function hostIdleDone() {
  m.client.runSnapshot.mockImplementation(async ({ runId } = {}) => (
    runId
      ? { ok: true, run: { runId, status: 'done', counts: { total: 1, done: 1, blocked: 0 } } }
      : { ok: true, runs: [] }
  ));
}

describe('runCommand（T1-058 薄化：提交 + 观察 + 收尾）', () => {
  beforeEach(() => {
    vi.spyOn(process, 'cwd').mockReturnValue('/tmp/mock-cwd');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    m.loadState.mockReset().mockReturnValue(stateWith({ mode: 'run' }));
    m.getStatus.mockReset().mockResolvedValue({ state: 'ready' });
    m.httpPost.mockReset().mockResolvedValue({});
    m.httpPostJson.mockReset().mockResolvedValue({ ok: true });
    m.autoSelect.mockReset().mockResolvedValue({ index: 1 });
    m.waitWhilePaused.mockReset().mockResolvedValue();
    m.execSync.mockReset().mockReturnValue(Buffer.from(''));
    m.spawn.mockReset().mockReturnValue({ unref: vi.fn() });
    m.installProjectMcp.mockReset().mockReturnValue({ written: false, servers: [] });

    m.client.submitRun.mockReset().mockResolvedValue({ ok: true, runId: 'default', mode: 'single' });
    m.client.pollRunEvents.mockReset().mockResolvedValue({ events: [], tailSeq: 0, afterSeq: 0 });
    m.client.runSnapshot.mockReset();
    m.client.setRunMode.mockReset().mockResolvedValue({ ok: true });
    hostIdleDone();
    mkdir.mockReset();
    writeFile.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function boot(runCommandPromise, ms) {
    return vi.advanceTimersByTimeAsync(ms || 2000);
  }

  it('TC1: state.json 不存在 → 退出', async () => {
    m.loadState.mockReturnValue(null);
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    await expect(runCommand(undefined, {})).rejects.toThrow('process.exit');
  });

  it('TC2: 环境拉起 → 提交 run → 观察至 done → mode idle + 清理', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(() => {});
    m.loadState.mockReturnValue(stateWith({ mode: 'plan', currentState: 'FINISH' }));
    m.getStatus.mockResolvedValueOnce(false); // ensureServer 探测无已有 server → 走拉起

    const promise = runCommand(undefined, {});
    await boot(promise);

    // 环境拉起：spawn server
    expect(m.spawn).toHaveBeenCalledWith('node', ['/tmp/server.cjs'], expect.any(Object));
    // 经 run-client 提交 run
    expect(m.client.submitRun).toHaveBeenCalledWith({});
    // mode：plan → run（启动）→ idle（收尾）
    expect(m.client.setRunMode).toHaveBeenCalledWith('run');
    expect(m.client.setRunMode).toHaveBeenCalledWith('idle');
    // 收尾清理
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('工作流结束'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('已停止运行会话'));
  });

  it('TC2b: 观察循环消费宿主事件并展示（task.done 渲染）', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(() => {});
    m.loadState.mockReturnValue(stateWith({ mode: 'run', currentState: 'CODE' }));
    // 第一帧提交后事件：task.started/done + run.stopped(done)
    let calls = 0;
    m.client.pollRunEvents.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return { events: [], tailSeq: 0, afterSeq: 0 }; // 提交前种子
      if (calls === 2) return {
        afterSeq: 3, tailSeq: 3,
        events: [
          { seq: 1, runId: 'default', type: 'run.started', payload: { mode: 'single' } },
          { seq: 2, runId: 'default', type: 'task.started', payload: { taskId: 'T1', title: '做 A', chain: ['DEV', 'COMMIT'] } },
          { seq: 3, runId: 'default', type: 'task.done', payload: { taskId: 'T1' } },
        ],
      };
      return { events: [], afterSeq: 3, tailSeq: 3 };
    });

    const promise = runCommand(undefined, {});
    await boot(promise);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('任务 T1: 做 A'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('工作流结束'));
  });

  it('TC2c: run 提交失败（host 未就绪/重复）→ 保留现场（不 idle、不清理）', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(() => {});
    m.loadState.mockReturnValue(stateWith({ mode: 'run' }));
    m.client.submitRun.mockResolvedValue({ ok: false, error: '宿主正在驱动 run default' });

    const promise = runCommand(undefined, {});
    const rejected = expect(promise).rejects.toThrow('宿主正在驱动 run default');
    await boot(promise);
    await rejected;

    expect(m.client.setRunMode).not.toHaveBeenCalledWith('idle');
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('已停止运行会话'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('保留 tmux 与 Session Server'));
  });

  it('TC2d: run 宿主以 error 收尾 → 保留现场（不标 idle）', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(() => {});
    m.loadState.mockReturnValue(stateWith({ mode: 'run' }));
    m.client.submitRun.mockResolvedValue({ ok: true, runId: 'default', mode: 'single' });
    m.client.runSnapshot.mockResolvedValue({ ok: true, run: { runId: 'default', status: 'error', error: 'executor 失败', counts: {} } });

    const promise = runCommand(undefined, {});
    const rejected = expect(promise).rejects.toThrow('executor 失败');
    await boot(promise);
    await rejected;

    expect(m.client.setRunMode).not.toHaveBeenCalledWith('idle');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('保留 tmux 与 Session Server'));
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('工作流结束'));
  });

  it('TC2e: 正常完成但 idle 写入失败 → 保留现场', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(() => {});
    m.loadState.mockReturnValue(stateWith({ mode: 'run', currentState: 'FINISH' }));
    m.client.setRunMode.mockResolvedValue({ ok: false });

    const promise = runCommand(undefined, {});
    const rejected = expect(promise).rejects.toThrow('无法将 mode 设置为 idle');
    await boot(promise);
    await rejected;

    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('已停止运行会话'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('保留 tmux 与 Session Server'));
  });

  it('TC2f: --resume 重启暂停中的 CLI 时保留 pause 闩锁（不切 run）', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(() => {});
    m.loadState.mockReturnValue(stateWith({ mode: 'pause', currentState: 'FINISH' }));
    m.client.runSnapshot.mockResolvedValue({ ok: true, run: { runId: 'default', status: 'done', counts: {} } });

    const promise = runCommand(undefined, { resume: true });
    await boot(promise);

    expect(m.client.setRunMode).not.toHaveBeenCalledWith('run');
  });

  it('TC6: SIGINT/SIGTERM 注册清理处理器', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'exit').mockImplementation(() => {});
    m.loadState.mockReturnValue(stateWith({ mode: 'run' }));
    const onSpy = vi.spyOn(process, 'on');

    const promise = runCommand(undefined, {});
    await boot(promise);

    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  });

  it('TC7: server 已存在且属本项目 → 复用（不 spawn 不 kill）', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(() => {});
    m.loadState.mockReturnValue(stateWith({ mode: 'run' }));
    m.getStatus.mockResolvedValue({ state: 'ready', projectRoot: '/tmp/mock-cwd' });

    const promise = runCommand(undefined, {});
    await boot(promise);

    expect(m.spawn).not.toHaveBeenCalledWith('node', ['/tmp/server.cjs'], expect.any(Object));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('复用现有服务'));
    expect(m.client.setRunMode).toHaveBeenCalledWith('idle');
  });

  it('TC8: 端口被其他项目 server 占用 → 复用（单 server 多项目，?p 路由；不 spawn 不 kill）', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(() => {});
    m.loadState.mockReturnValue(stateWith({ mode: 'run' }));
    m.getStatus.mockResolvedValue({ state: 'ready', projectRoot: '/tmp/other' });

    const promise = runCommand(undefined, {});
    await boot(promise);

    expect(m.spawn).not.toHaveBeenCalledWith('node', ['/tmp/server.cjs'], expect.any(Object));
    expect(m.execSync).not.toHaveBeenCalledWith(expect.stringContaining('lsof'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('复用现有服务'));
    expect(m.client.setRunMode).toHaveBeenCalledWith('idle');
  });
});

describe('runCommand 重连（T1-059 --resume/--attach）', () => {
  /** 宿主有活跃 run（CLI 中断但宿主仍在驱动） */
  function hostActive(counts = { done: 1, blocked: 0, total: 2 }) {
    m.client.runSnapshot.mockImplementation(async ({ runId } = {}) => (
      runId
        ? { ok: true, run: { runId, status: 'done', counts: { ...counts, total: counts.total } } }
        : { ok: true, runs: [{ runId: 'default', status: 'running', counts }] }
    ));
  }

  beforeEach(() => {
    vi.spyOn(process, 'cwd').mockReturnValue('/tmp/mock-cwd');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    m.loadState.mockReset().mockReturnValue(stateWith({ mode: 'run' }));
    m.getStatus.mockReset().mockResolvedValue({ state: 'ready' });
    m.waitWhilePaused.mockReset().mockResolvedValue();
    m.execSync.mockReset().mockReturnValue(Buffer.from(''));
    m.spawn.mockReset().mockReturnValue({ unref: vi.fn() });
    m.client.submitRun.mockReset().mockResolvedValue({ ok: true, runId: 'default', mode: 'single' });
    m.client.pollRunEvents.mockReset().mockResolvedValue({ events: [], tailSeq: 0, afterSeq: 0 });
    m.client.runSnapshot.mockReset();
    m.client.setRunMode.mockReset().mockResolvedValue({ ok: true });
    hostIdleDone();
  });

  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  function bootWith(promise) {
    return vi.advanceTimersByTimeAsync(2000);
  }

  function boot(runPromise) {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(() => {});
    const p = runPromise();
    const b = bootWith(p);
    return { p, b };
  }

  it('RC1: --resume 且宿主有活跃 run → 挂接续观（不重复提交），读落盘进度后收敛 done + idle', async () => {
    hostActive();
    const { p, b } = boot(() => runCommand(undefined, { resume: true }));
    await b;
    await p;

    expect(m.client.submitRun).not.toHaveBeenCalled(); // 关键：不重复提交（宿主单槽）
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('挂接 run default'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('1/2 done'));
    expect(m.client.setRunMode).toHaveBeenCalledWith('idle');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('工作流结束'));
  });

  it('RC2: --resume 且宿主空闲 → 提交续跑 store 剩余任务（续接）', async () => {
    // 默认 hostIdleDone：宿主无活跃 run
    const { p, b } = boot(() => runCommand(undefined, { resume: true }));
    await b;
    await p;

    expect(m.client.submitRun).toHaveBeenCalledWith({});
    expect(m.client.setRunMode).toHaveBeenCalledWith('idle');
  });

  it('RC3: --attach 且宿主有活跃 run → 挂接（不提交）', async () => {
    hostActive({ done: 0, blocked: 0, total: 3 });
    const { p, b } = boot(() => runCommand(undefined, { attach: true }));
    await b;
    await p;

    expect(m.client.submitRun).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('挂接 run default'));
    expect(m.client.setRunMode).toHaveBeenCalledWith('idle');
  });

  it('RC4: --attach 但宿主空闲 → 报错保留现场（不提交、不 idle）', async () => {
    const { p, b } = boot(() => runCommand(undefined, { attach: true }));
    const rejected = expect(p).rejects.toThrow('宿主无活跃 run');
    await b;
    await rejected;

    expect(m.client.submitRun).not.toHaveBeenCalled();
    expect(m.client.setRunMode).not.toHaveBeenCalledWith('idle');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('保留 tmux 与 Session Server'));
  });

  it('RC5: fresh 却撞上宿主活跃 run → 防御性转挂接（不重复提交）', async () => {
    hostActive();
    const { p, b } = boot(() => runCommand(undefined, {}));
    await b;
    await p;

    expect(m.client.submitRun).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('宿主已有活跃 run'));
    expect(m.client.setRunMode).toHaveBeenCalledWith('idle');
  });

  it('RC6: T1-073 --attach -R r1 → 挂接指定 run（不提交），收敛 done', async () => {
    m.client.runSnapshot.mockImplementation(async ({ runId: id } = {}) => (
      id === 'r1'
        ? { ok: true, run: { runId: 'r1', status: 'done', counts: { total: 2, done: 2, blocked: 0 }, mode: 'single' } }
        : { ok: true, runs: [{ runId: 'r1', status: 'running', counts: { done: 1, blocked: 0, total: 2 }, mode: 'single' }] }
    ));
    const { p, b } = boot(() => runCommand(undefined, { attach: true, runId: 'r1' }));
    await b;
    await p;

    expect(m.client.submitRun).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('挂接指定 run r1'));
    expect(m.client.setRunMode).toHaveBeenCalledWith('idle');
  });

  it('RC7: T1-073 --attach -R 不存在 run → 报错保留现场（不提交不 idle）', async () => {
    // 默认 hostIdleDone：宿主无该 run
    const { p, b } = boot(() => runCommand(undefined, { attach: true, runId: 'zzz' }));
    const rejected = expect(p).rejects.toThrow('未找到 run zzz');
    await b;
    await rejected;

    expect(m.client.submitRun).not.toHaveBeenCalled();
    expect(m.client.setRunMode).not.toHaveBeenCalledWith('idle');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('保留 tmux 与 Session Server'));
  });
});
