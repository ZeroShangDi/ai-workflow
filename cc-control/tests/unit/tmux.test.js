import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// 注入 mock execFileSync（tmux.cjs 为原生 CJS，vi.mock 无法拦截其内部 require）
const mockExecFileSync = vi.fn();

beforeAll(() => {
  global.__CC_EXEC_FILE_SYNC__ = mockExecFileSync;
});

afterAll(() => {
  delete global.__CC_EXEC_FILE_SYNC__;
});

beforeEach(() => {
  delete process.env.CC_SESSION;
  mockExecFileSync.mockReset();
  mockExecFileSync.mockReturnValue(''); // 默认成功
});

// 重新加载模块（SESSION 在模块顶层读取，需 resetModules 才能测试 CC_SESSION）
async function loadTmux() {
  vi.resetModules();
  return import('../../src/server/tmux.cjs');
}

const ENC = { encoding: 'utf8' };

describe('tmux.cjs', () => {
  it('TC1: hasSession 存在 → true', async () => {
    const tmux = await loadTmux();
    expect(tmux.hasSession()).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith('tmux', ['has-session', '-t', 'cc'], ENC);
  });

  it('TC2: hasSession 不存在 → false（catch 不抛）', async () => {
    const tmux = await loadTmux();
    mockExecFileSync.mockImplementation(() => { throw new Error('no session'); });
    expect(tmux.hasSession()).toBe(false);
    expect(tmux.hasSession()).toBe(false); // 再次调用仍正常
  });

  it('TC3: sendText 正确拼装 args（-l literal 模式）', async () => {
    const tmux = await loadTmux();
    tmux.sendText('hello world');
    expect(mockExecFileSync).toHaveBeenCalledWith('tmux', ['send-keys', '-t', 'cc', '-l', 'hello world'], ENC);
  });

  it('TC4: sendEnter 正确拼装 args', async () => {
    const tmux = await loadTmux();
    tmux.sendEnter();
    expect(mockExecFileSync).toHaveBeenCalledWith('tmux', ['send-keys', '-t', 'cc', 'Enter'], ENC);
  });

  it('TC5: capture 正确拼装 args 并返回 stdout', async () => {
    const tmux = await loadTmux();
    mockExecFileSync.mockReturnValue('pane content');
    expect(tmux.capture()).toBe('pane content');
    expect(mockExecFileSync).toHaveBeenCalledWith('tmux', ['capture-pane', '-t', 'cc', '-p'], ENC);
  });

  it('TC6: sendText 异常向上传播（不 catch）', async () => {
    const tmux = await loadTmux();
    mockExecFileSync.mockImplementation(() => { throw new Error('tmux broken'); });
    expect(() => tmux.sendText('x')).toThrow('tmux broken');
  });

  it('TC7: SESSION 默认值为 cc', async () => {
    const tmux = await loadTmux();
    expect(tmux.SESSION).toBe('cc');
    tmux.sendText('x');
    expect(mockExecFileSync).toHaveBeenCalledWith('tmux', ['send-keys', '-t', 'cc', '-l', 'x'], ENC);
  });

  it('TC8: CC_SESSION 环境变量覆盖 SESSION', async () => {
    process.env.CC_SESSION = 'my-session';
    const tmux = await loadTmux();
    expect(tmux.SESSION).toBe('my-session');
    tmux.sendText('x');
    expect(mockExecFileSync).toHaveBeenCalledWith('tmux', ['send-keys', '-t', 'my-session', '-l', 'x'], ENC);
    tmux.sendEnter();
    expect(mockExecFileSync).toHaveBeenCalledWith('tmux', ['send-keys', '-t', 'my-session', 'Enter'], ENC);
  });
});
