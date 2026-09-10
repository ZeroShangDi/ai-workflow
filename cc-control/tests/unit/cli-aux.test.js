import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mockExecSync, mockExec, mockSpawn } from '../helpers/mock-child-process.js';

const { mockLogger, mockLogStep, mockFs } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockLogStep: vi.fn(),
  mockFs: {
    mkdir: vi.fn(),
    stat: vi.fn(),
    lstat: vi.fn(),
    symlink: vi.fn(),
    unlink: vi.fn(),
    readlink: vi.fn(),
    rm: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
}));

vi.mock('../../src/lib/ui/log.js', () => ({ logger: mockLogger, logStep: mockLogStep }));
vi.mock('node:fs/promises', () => ({ ...mockFs, default: mockFs }));
vi.mock('../../src/lib/paths.js', () => ({
  getPaths: vi.fn(() => ({
    projectRoot: '/tmp/mock-project',
    claudePlugins: '/tmp/mock-claude-plugins',
    ccSettings: '/tmp/mock-settings.json',
    tmuxServer: '/tmp/server.cjs',
    bootstrapScript: '/tmp/bootstrap.sh',
  })),
  pluginCmd: vi.fn((cmd) => `/ai-workflow-code:${cmd}`),
  PLUGIN_NS: 'ai-workflow-code',
}));

// run-context 装配器注入（替代旧 getPaths 的 server/bootstrap 注入点）
vi.mock('../../src/lib/run-context.cjs', () => ({
  buildRunContext: vi.fn(() => ({
    sid: null,
    session: 'cc',
    runSessionName: 'cc',
    port: 8787,
    projectRoot: '/tmp/mock-project',
    infraRoot: '/tmp/mock-project',
    serverScriptPath: '/tmp/server.cjs',
    bootstrapScriptPath: '/tmp/bootstrap.sh',
    runSettingsPath: '/tmp/mock-project/.awf/run-settings.json',
  })),
  projectSid: vi.fn(() => 'p123'),
}));

// ── http mock for server check ──
const httpCheckState = vi.hoisted(() => ({ ok: true, timeout: false }));
// 优雅关闭探测（serverCommand stop 的 requestShutdown 用全局 fetch）——
// 必须 stub：否则会真的去打 127.0.0.1:8787，命中并发测试文件/本机真 run 的服务 → 跨文件污染。
const fetchState = vi.hoisted(() => ({ shutdownOk: false, calls: [] }));

vi.mock('node:http', async () => {
  const { EventEmitter: EE } = await import('node:events');
  const fake = {
    get(url, cb) {
      const req = new EE();
      let timeoutCb;
      req.setTimeout = (ms, fn) => { timeoutCb = fn; };
      req.destroy = vi.fn();
      queueMicrotask(() => {
        if (httpCheckState.ok) {
          const res = new EE();
          res.statusCode = 200;
          cb(res);
          queueMicrotask(() => { res.emit('data', JSON.stringify({ state: 'ready' })); res.emit('end'); });
        } else if (httpCheckState.timeout) {
          timeoutCb?.();
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
    mockLogStep.mockReset();
    mockExecSync.mockReset();
    mockExecSync.mockImplementation(() => Buffer.from(''));
    mockExec.mockReset();
    mockExec.mockImplementation((_c, _o, cb) => cb(null, '', ''));
    mockSpawn.mockReset();
    mockSpawn.mockImplementation(() => {
      const p = new EventEmitter();
      p.unref = vi.fn();
      return p;
    });
    Object.values(mockFs).forEach((f) => f.mockReset());
    httpCheckState.ok = true;
    httpCheckState.timeout = false;
    fetchState.shutdownOk = false;
    fetchState.calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      fetchState.calls.push({ url: String(url), opts });
      return { ok: fetchState.shutdownOk };
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ═══════════════════ plugin ═══════════════════

  describe('pluginCommand', () => {
    const PROFILE_PLUGINS = JSON.stringify({
      plugins: ['superpowers@claude-plugins-official', 'figma@claude-plugins-official', 'ai-workflow-code@ai-workflow-dev'],
    });

    it('TC1: install — 全局正常安装（从 settings.json.plugins 读取）', async () => {
      mockFs.readlink.mockRejectedValue(new Error('ENOENT')); // 无旧 symlink
      mockFs.unlink.mockResolvedValue();
      mockFs.readFile.mockResolvedValue(PROFILE_PLUGINS);
      mockExecSync.mockImplementation((cmd) => (cmd.includes('cat') ? Buffer.from('{"plugins":{}}') : Buffer.from('')));

      await pluginCommand('install', { scope: 'global' });

      expect(mockExec).toHaveBeenCalledWith(
        'claude plugin install ai-workflow-code@ai-workflow-dev',
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockLogStep).toHaveBeenCalledWith('ai-workflow-code', 'ok', '已安装');
    });

    it('TC2: install — 已用户级安装则跳过', async () => {
      mockFs.readlink.mockRejectedValue(new Error('ENOENT'));
      mockFs.readFile.mockResolvedValue(PROFILE_PLUGINS);
      mockExecSync.mockImplementation((cmd) => {
        if (cmd.includes('cat')) return Buffer.from(JSON.stringify({ plugins: {
          'superpowers@claude-plugins-official': [{ scope: 'user' }],
          'figma@claude-plugins-official': [{ scope: 'user' }],
          'ai-workflow-code@ai-workflow-dev': [{ scope: 'user' }],
        } }));
        return Buffer.from('');
      });

      await pluginCommand('install', { scope: 'global' });

      expect(mockExec).not.toHaveBeenCalled();
      expect(mockLogStep).toHaveBeenCalledWith('ai-workflow-code', 'skip', '已安装');
    });

    it('TC3: uninstall — 全局正常卸载', async () => {
      mockFs.readFile.mockResolvedValue(PROFILE_PLUGINS);

      await pluginCommand('uninstall', { scope: 'global' });

      expect(mockExec).toHaveBeenCalledWith(
        'claude plugin uninstall ai-workflow-code@ai-workflow-dev',
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockLogStep).toHaveBeenCalledWith('ai-workflow-code', 'ok', '已卸载');
    });

    it('TC4: install — exec 失败报错不阻断', async () => {
      mockFs.readlink.mockRejectedValue(new Error('ENOENT'));
      mockFs.unlink.mockResolvedValue();
      mockFs.readFile.mockResolvedValue(PROFILE_PLUGINS);
      mockExecSync.mockImplementation((cmd) => (cmd.includes('cat') ? Buffer.from('{"plugins":{}}') : Buffer.from('')));
      mockExec.mockImplementation((_c, _o, cb) => cb(new Error('boom')));

      await pluginCommand('install', { scope: 'global' });

      expect(mockLogStep).toHaveBeenCalledWith('ai-workflow-code', 'error', expect.stringContaining('安装失败'));
    });

    it('TC5: uninstall — exec 失败报错不阻断', async () => {
      mockFs.readFile.mockResolvedValue(PROFILE_PLUGINS);
      mockExec.mockImplementation((_c, _o, cb) => cb(new Error('boom')));

      await pluginCommand('uninstall', { scope: 'global' });

      expect(mockLogStep).toHaveBeenCalledWith('ai-workflow-code', 'error', expect.stringContaining('卸载失败'));
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

    it('TC11: stop — 优雅关闭探测失败时 kill tmux + lsof 端口兜底', async () => {
      await serverCommand('stop');

      expect(mockExecSync).toHaveBeenCalledWith(expect.stringContaining('tmux kill-session'), expect.any(Object));
      expect(mockExecSync).toHaveBeenCalledWith(expect.stringContaining('lsof'), expect.any(Object));
      expect(mockLogger.success).toHaveBeenCalledWith('已停止');
    });

    it('TC11b: stop — 优雅关闭成功则不再 kill-by-port', async () => {
      fetchState.shutdownOk = true;

      await serverCommand('stop');

      expect(fetchState.calls[0].url).toContain('/shutdown');
      expect(mockExecSync).toHaveBeenCalledWith(expect.stringContaining('tmux kill-session'), expect.any(Object));
      expect(mockExecSync).not.toHaveBeenCalledWith(expect.stringContaining('lsof'), expect.any(Object));
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
    // 多项目作用域：打开的 URL 带 ?p=<cwd>（缺 p 会落到 server 的 boot 项目）
    const SCOPE = 'p=%2Ftmp%2Fmock-cwd';

    it('TC16: dashboard — 打开带项目作用域的 URL', async () => {
      await openCommand('dashboard');

      expect(mockLogger.info).toHaveBeenCalledWith(`打开 dashboard: http://localhost:8787/?${SCOPE}`);
      // openBrowser calls spawn('open', [url], ...)
      expect(mockSpawn).toHaveBeenCalledWith('open', [`http://localhost:8787/?${SCOPE}`], expect.any(Object));
    });

    it('TC17: ui 已废弃（T1-094）——作为目标报错', async () => {
      vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
      await expect(openCommand('ui')).rejects.toThrow('exit');
      expect(mockLogger.error).toHaveBeenCalledWith('未知目标: ui，可用: tree | dashboard');
    });

    it('TC18: tree — 指向 web WBS-Tree 视图（?view=wbs-tree + 项目作用域）', async () => {
      await openCommand('tree');

      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('WBS-Tree'));
      expect(mockSpawn).toHaveBeenCalledWith('open', [`http://localhost:8787/?view=wbs-tree&${SCOPE}`], expect.any(Object));
      expect(mockFs.writeFile).not.toHaveBeenCalled(); // 不再生成 w-tree.html
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
        expect(call[1]).toEqual([`http://localhost:8787/?${SCOPE}`]);
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
      expect(mockLogger.error).toHaveBeenCalledWith('未知目标: invalid，可用: tree | dashboard');
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
