import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mockExecSync, mockSpawn } from '../helpers/mock-child-process.js';

const { mockLogger, mockFs } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockFs: {
    mkdir: vi.fn(),
    stat: vi.fn(),
    lstat: vi.fn(),
    symlink: vi.fn(),
    unlink: vi.fn(),
    rm: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
}));

vi.mock('../../src/cli/logger.js', () => ({ logger: mockLogger }));
vi.mock('node:fs/promises', () => ({ ...mockFs, default: mockFs }));
vi.mock('../../src/cli/paths.js', () => ({
  getPaths: vi.fn(() => ({
    projectRoot: '/tmp/mock-project',
    claudePlugins: '/tmp/mock-claude-plugins',
    ccSettings: '/tmp/mock-settings.json',
    tmuxServer: '/tmp/server.cjs',
    bootstrapScript: '/tmp/bootstrap.sh',
  })),
  pluginCmd: vi.fn((cmd) => `/ai-workflow:${cmd}`),
  PLUGIN_NS: 'ai-workflow',
}));

// ── http mock for server check ──
const httpCheckState = vi.hoisted(() => ({ ok: true, timeout: false }));

vi.mock('node:http', async () => {
  const { EventEmitter: EE } = await import('node:events');
  const fake = {
    get(url, cb) {
      const req = new EE();
      let timeoutCb;
      req.setTimeout = (ms, fn) => { timeoutCb = fn; };
      req.destroy = vi.fn();
      // Use queueMicrotask — works with both real and fake timers
      queueMicrotask(() => {
        if (httpCheckState.ok) {
          cb({ statusCode: 200 });
        } else if (httpCheckState.timeout) {
          timeoutCb?.(); // 触发 req.setTimeout 回调 → check() resolve(false)
        } else {
          req.emit('error', new Error('ECONNREFUSED'));
        }
      });
      return req;
    },
    request: vi.fn(),
  };
  return { ...fake, default: fake, get: fake.get, request: fake.request };
});

import { pluginCommand } from '../../src/cli/plugin.js';
import { serverCommand } from '../../src/cli/server.js';
import { openCommand } from '../../src/cli/open.js';
import { attachCommand } from '../../src/cli/attach.js';

function resetLogger() {
  Object.values(mockLogger).forEach((f) => f.mockReset());
}

describe('cli-aux', () => {
  beforeEach(() => {
    vi.spyOn(process, 'cwd').mockReturnValue('/tmp/mock-cwd');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    resetLogger();
    mockExecSync.mockReset();
    mockExecSync.mockImplementation(() => Buffer.from(''));
    mockSpawn.mockReset();
    mockSpawn.mockImplementation(() => {
      const p = new EventEmitter();
      p.unref = vi.fn();
      return p;
    });
    Object.values(mockFs).forEach((f) => f.mockReset());
    httpCheckState.ok = true;
    httpCheckState.timeout = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ═══════════════════ plugin ═══════════════════

  describe('pluginCommand', () => {
    it('TC1: install — 正常创建 symlink', async () => {
      mockFs.mkdir.mockResolvedValue();
      mockFs.stat.mockRejectedValue(new Error('ENOENT'));
      mockFs.symlink.mockResolvedValue();

      await pluginCommand('install');

      expect(mockFs.mkdir).toHaveBeenCalledWith('/tmp/mock-claude-plugins', { recursive: true });
      expect(mockFs.symlink).toHaveBeenCalledWith('/tmp/mock-project/plugin', '/tmp/mock-claude-plugins/ai-workflow');
      expect(mockLogger.success).toHaveBeenCalled();
    });

    it('TC2: install — 已存在则跳过', async () => {
      mockFs.mkdir.mockResolvedValue();
      mockFs.stat.mockResolvedValue({}); // exists

      await pluginCommand('install');

      expect(mockFs.symlink).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('插件已安装，跳过');
    });

    it('TC3: uninstall — 正常移除 symlink', async () => {
      mockFs.lstat.mockResolvedValue({ isSymbolicLink: () => true });
      mockFs.unlink.mockResolvedValue();

      await pluginCommand('uninstall');

      expect(mockFs.unlink).toHaveBeenCalledWith('/tmp/mock-claude-plugins/ai-workflow');
      expect(mockLogger.success).toHaveBeenCalledWith('已卸载');
    });

    it('TC4: uninstall — 目标为目录则递归删除', async () => {
      mockFs.lstat.mockResolvedValue({ isSymbolicLink: () => false });
      mockFs.rm.mockResolvedValue();

      await pluginCommand('uninstall');

      expect(mockFs.rm).toHaveBeenCalledWith('/tmp/mock-claude-plugins/ai-workflow', { recursive: true });
    });

    it('TC5: uninstall — 不存在则跳过', async () => {
      mockFs.lstat.mockRejectedValue(new Error('ENOENT'));

      await pluginCommand('uninstall');

      expect(mockLogger.info).toHaveBeenCalledWith('插件未安装');
      expect(mockFs.unlink).not.toHaveBeenCalled();
    });

    it('TC6: 无效 action → 报错退出', async () => {
      vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

      await expect(pluginCommand('invalid')).rejects.toThrow('exit');
      expect(mockLogger.error).toHaveBeenCalledWith('未知操作: invalid，可用: install | uninstall');
    });
  });

  // ═══════════════════ server ═══════════════════

  describe('serverCommand', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('TC7: start — 首次启动完整流程', async () => {
      httpCheckState.ok = false;

      mockExecSync.mockImplementation((cmd) => {
        if (cmd.includes('tmux has-session')) throw new Error('not found');
        return Buffer.from('');
      });

      const promise = serverCommand('start');
      // Advance past first check (fails) + sleep(500), then toggle to success
      await vi.advanceTimersByTimeAsync(600);
      httpCheckState.ok = true;
      await vi.advanceTimersByTimeAsync(20000);
      await promise;

      expect(mockSpawn).toHaveBeenCalledWith('node', ['/tmp/server.cjs'], expect.any(Object));
      expect(mockExecSync).toHaveBeenCalledWith(expect.stringContaining('bootstrap'), expect.any(Object));
    });

    it('TC8: start — 已运行则跳过 server 启动', async () => {
      httpCheckState.ok = true; // check() returns true
      mockExecSync.mockImplementation((cmd) => {
        if (cmd.includes('tmux has-session')) return Buffer.from(''); // session exists
        return Buffer.from('');
      });

      const promise = serverCommand('start');
      await vi.advanceTimersByTimeAsync(1000);
      await promise;

      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('TC9: start — tmux session 已存在跳过创建', async () => {
      httpCheckState.ok = true;
      mockExecSync.mockImplementation((cmd) => {
        if (cmd.includes('tmux has-session')) return Buffer.from(''); // exists
        return Buffer.from('');
      });

      const promise = serverCommand('start');
      await vi.advanceTimersByTimeAsync(1000);
      await promise;

      expect(mockExecSync).not.toHaveBeenCalledWith(expect.stringContaining('bootstrap'), expect.any(Object));
    });

    it('TC10: start — tmux session 不存在时创建', async () => {
      httpCheckState.ok = true;
      mockExecSync.mockImplementation((cmd) => {
        if (cmd.includes('tmux has-session')) throw new Error('not found');
        if (cmd.includes('bootstrap')) return Buffer.from('');
        return Buffer.from('');
      });

      const promise = serverCommand('start');
      await vi.advanceTimersByTimeAsync(1000);
      await promise;

      expect(mockExecSync).toHaveBeenCalledWith(expect.stringContaining('bootstrap'), expect.any(Object));
    });

    it('TC11: stop — tmux kill + 端口释放', async () => {
      await serverCommand('stop');

      expect(mockExecSync).toHaveBeenCalledWith(expect.stringContaining('tmux kill-session'), expect.any(Object));
      expect(mockExecSync).toHaveBeenCalledWith(expect.stringContaining('lsof'), expect.any(Object));
      expect(mockLogger.success).toHaveBeenCalledWith('已停止');
    });

    it('TC12: status — 运行中返回 URL', async () => {
      httpCheckState.ok = true;

      await serverCommand('status');

      expect(mockLogger.success).toHaveBeenCalledWith('tmux-http 运行中: http://localhost:8787');
    });

    it('TC13: status — 未运行返回提示', async () => {
      httpCheckState.ok = false;

      await serverCommand('status');

      expect(mockLogger.info).toHaveBeenCalledWith('tmux-http 未运行');
    });

    it('TC14: status — 200 → 运行中', async () => {
      httpCheckState.ok = true;
      await serverCommand('status');
      expect(mockLogger.success).toHaveBeenCalledWith('tmux-http 运行中: http://localhost:8787');
    });

    it('TC14b: check() 超时 → 未运行（2s timeout 回调）', async () => {
      httpCheckState.ok = false;
      httpCheckState.timeout = true;
      await serverCommand('status');
      expect(mockLogger.info).toHaveBeenCalledWith('tmux-http 未运行');
    });

    it('TC15: 无效 action → 报错退出', async () => {
      vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

      await expect(serverCommand('restart')).rejects.toThrow('exit');
      expect(mockLogger.error).toHaveBeenCalledWith('未知操作: restart，可用: start | stop | status');
    });
  });

  // ═══════════════════ open ═══════════════════

  describe('openCommand', () => {
    it('TC16: dashboard — 打开 URL', async () => {
      await openCommand('dashboard');

      expect(mockLogger.info).toHaveBeenCalledWith('打开 dashboard: http://localhost:8787');
      // openBrowser calls spawn('open', [url], ...)
      expect(mockSpawn).toHaveBeenCalledWith('open', ['http://localhost:8787'], expect.any(Object));
    });

    it('TC17: ui — 同 dashboard', async () => {
      await openCommand('ui');

      expect(mockLogger.info).toHaveBeenCalledWith('打开 dashboard: http://localhost:8787');
      expect(mockSpawn).toHaveBeenCalledWith('open', ['http://localhost:8787'], expect.any(Object));
    });

    it('TC18: tree — 正常渲染 HTML', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({ wbs: [{ name: 'Task 1' }] }));
      mockFs.writeFile.mockResolvedValue();

      await openCommand('tree');

      expect(mockFs.writeFile).toHaveBeenCalled();
      const html = mockFs.writeFile.mock.calls[0][1];
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Task 1');
      expect(mockSpawn).toHaveBeenCalledWith('open', [expect.stringContaining('w-tree.html')], expect.any(Object));
    });

    it('TC19: tree — wbs 为空时报错', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({})); // no wbs
      vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

      await expect(openCommand('tree')).rejects.toThrow('exit');
      expect(mockLogger.error).toHaveBeenCalledWith('尚未规划，请先执行 awf plan');
    });

    it('TC20: tree — state.json 不存在', async () => {
      mockFs.readFile.mockRejectedValue(new Error('ENOENT'));

      await expect(openCommand('tree')).rejects.toThrow('ENOENT');
    });

    it('TC21: openBrowser 平台选择 + spawn 参数', async () => {
      const original = process.platform;
      const cases = [
        ['darwin', 'open'],
        ['win32', 'start'],
        ['linux', 'xdg-open'],
      ];
      for (const [plat, cmd] of cases) {
        Object.defineProperty(process, 'platform', { value: plat, configurable: true });
        await openCommand('dashboard');
        const call = mockSpawn.mock.calls.at(-1);
        expect(call[0]).toBe(cmd);
        expect(call[1]).toEqual(['http://localhost:8787']);
        expect(call[2]).toEqual({ stdio: 'ignore', detached: true });
        // spawn 返回的 proc 调用了 unref
        const proc = mockSpawn.mock.results.at(-1).value;
        expect(proc.unref).toHaveBeenCalled();
      }
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    });

    it('TC22: 无效 target → 报错退出', async () => {
      vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

      await expect(openCommand('invalid')).rejects.toThrow('exit');
      expect(mockLogger.error).toHaveBeenCalledWith('未知目标: invalid，可用: tree | ui | dashboard');
    });
  });

  // ═══════════════════ attach ═══════════════════

  describe('attachCommand', () => {
    it('TC23: session 存在 → attach', async () => {
      mockExecSync.mockImplementation((cmd) => {
        if (cmd.includes('tmux has-session')) return Buffer.from('');
        if (cmd.includes('tmux attach')) return Buffer.from('');
      });

      await attachCommand();

      expect(mockLogger.info).toHaveBeenCalledWith("接入 session 'cc'（Ctrl-B D 脱离）...");
      expect(mockExecSync).toHaveBeenCalledWith('tmux attach -t cc', { stdio: 'inherit' });
    });

    it('TC24: session 不存在 → 报错退出', async () => {
      mockExecSync.mockImplementation((cmd) => {
        if (cmd.includes('tmux has-session')) throw new Error('not found');
      });
      vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

      await expect(attachCommand()).rejects.toThrow('exit');
      expect(mockLogger.error).toHaveBeenCalledWith("tmux session 'cc' 不存在，请先执行 awf run");
    });
  });
});
