import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pluginCommand, runPerSpec, execAsync } from '../../cli/commands/plugin.cjs';
import { serverCommand } from '../../cli/commands/server.cjs';
import { openCommand, TARGETS } from '../../cli/commands/open.cjs';
import { attachCommand } from '../../cli/commands/attach.cjs';
import { normalizeDescription } from '../../cli/commands/plan.cjs';

/**
 * cli-aux — 旁路命令（plugin / server / open / attach）
 *
 * ## 为什么这份测试长这样（重要）
 * 旧版靠 `vi.mock` 拦住 `ui/log`、`run-context`、`node:child_process`。**这套机制对新树不成立**：
 * 新 CLI 是 CJS（`.cjs` + `require()`），而 vitest 的 `vi.mock` 不拦截 CJS 模块里的 `require`
 * （旧 CLI 是 ESM，所以能拦）。`server.deps.inline` 也救不回来。
 *
 * 新树自己的惯例因此是「纯函数 / 真临时目录 / 显式注入端口」—— 本文件沿用：
 *   - plugin local：**真**跑一遍，断言真落盘的文件（比旧版 mock 断言更强）；
 *   - server stop/status/start：只 stub 全局 fetch（可用），不 spawn 真进程；
 *   - open：用命令自带的可注入 `browser` 参数换成无副作用的 `true`；
 *   - attach：只走「会话不存在 → 报错退出」这条（真调 tmux，但目标是必然不存在的会话）。
 *
 * 未覆盖的执行路径（真跑 `claude plugin …`、server start 的 spawn、open 的 spawn 参数、
 * attach 成功路径）已登记 `.awf/issues/014-cli-command-layer-untestable.md`。
 */

let TMP;

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-cliaux-'));
  fs.mkdirSync(path.join(dir, '.awf'), { recursive: true });
  return dir;
}

/** 造一个 fetch 应答：client.request 读 res.ok + res.text() */
function jsonRes(ok, body) {
  return { ok, status: ok ? 200 : 500, text: async () => JSON.stringify(body) };
}

describe('cli-aux', () => {
  let logs;
  let errors;
  const net = { probe: false, status: false, shutdown: false, calls: [] };

  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-cliaux-root-'));
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')); });

    net.probe = false;
    net.status = false;
    net.shutdown = false;
    net.calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url);
      net.calls.push(u);
      // 失败时 body 也必须带 ok:false —— client.request 会把 body 展开到返回值上，
      // 只把 HTTP 状态码设成 500 而 body 里写 ok:true 的话，ok 会被盖回 true（假成功）。
      if (u.includes('/probe')) return net.probe ? jsonRes(true, { ok: true }) : jsonRes(false, { ok: false, error: '无 /probe' });
      if (u.includes('/shutdown')) return net.shutdown ? jsonRes(true, { ok: true }) : jsonRes(false, { ok: false, error: '连接不可达' });
      return net.status ? jsonRes(true, { ok: true, state: 'ready' }) : jsonRes(false, { ok: false, error: '未运行' });
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  // ═══════════════════ plugin ═══════════════════

  describe('pluginCommand — 本地注册（真跑，真落盘）', () => {
    it('TC1: install → 项目 .claude/settings.json 与 .mcp.json 真被写入', async () => {
      const proj = tmpProject();
      vi.spyOn(process, 'cwd').mockReturnValue(proj);

      await pluginCommand('install');

      const settings = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'settings.json'), 'utf8'));
      expect(settings.enabledPlugins).toBeTruthy(); // 来自 plugin/settings.json 的安装清单
      const mcp = JSON.parse(fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8'));
      expect(Object.keys(mcp.mcpServers).sort()).toEqual(['awf-oneshot', 'awf-session', 'awf-state']);
      // 绝对路径 + 每条 server 都知道自己在哪个项目（单 server 多项目 ?p 路由的依据）
      expect(mcp.mcpServers['awf-state'].args.every((a) => path.isAbsolute(a))).toBe(true);
      expect(mcp.mcpServers['awf-state'].env.AWF_PROJECT_ROOT).toBe(proj);
      expect(logs.join('\n')).toContain('已本地注册');
      expect(logs.join('\n')).toContain('已注册项目 MCP');
    });

    it('TC2: install 幂等 —— 连跑两次不产生重复项', async () => {
      const proj = tmpProject();
      vi.spyOn(process, 'cwd').mockReturnValue(proj);
      await pluginCommand('install');
      const first = fs.readFileSync(path.join(proj, '.claude', 'settings.json'), 'utf8');
      await pluginCommand('install');
      expect(fs.readFileSync(path.join(proj, '.claude', 'settings.json'), 'utf8')).toBe(first);
    });

    it('TC3: uninstall → 按模板键精确清理，不留注入痕迹', async () => {
      const proj = tmpProject();
      vi.spyOn(process, 'cwd').mockReturnValue(proj);
      await pluginCommand('install');
      await pluginCommand('uninstall');
      const settings = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'settings.json'), 'utf8'));
      expect(settings.enabledPlugins).toBeUndefined();
      expect(logs.join('\n')).toContain('已注销');
    });

    it('TC4: uninstall 无可注销内容 → 明确说「无」，不假装成功', async () => {
      const proj = tmpProject();
      vi.spyOn(process, 'cwd').mockReturnValue(proj);
      await pluginCommand('uninstall');
      expect(logs.join('\n')).toContain('无可注销内容');
    });

    it('TC5: 未知 action → 报错退出（exit 2）', async () => {
      const code = [];
      vi.spyOn(process, 'exit').mockImplementation((c) => { code.push(c); throw new Error('exit'); });
      await expect(pluginCommand('invalid')).rejects.toThrow('exit');
      expect(code).toEqual([2]);
      expect(errors.join('\n')).toContain('未知操作：invalid');
    });
  });

  describe('runPerSpec — 全局批处理（逐 spec 逻辑，注入 run 故可测）', () => {
    it('TC6: 全部成功 → 汇总 2/2', async () => {
      const seen = [];
      await runPerSpec('安装', ['a', 'b'], async (s) => { seen.push(s); });
      expect(seen).toEqual(['a', 'b']);
      expect(logs.join('\n')).toContain('已全局安装 2/2 个插件');
    });

    it('TC7: 单个失败**不阻断**其余（旧 CLI 的保证，新 CLI 初版丢了，已补回）', async () => {
      const seen = [];
      await runPerSpec('安装', ['a', 'b'], async (s) => {
        seen.push(s);
        if (s === 'a') throw new Error('boom');
      });
      expect(seen).toEqual(['a', 'b']); // b 照跑
      expect(errors.join('\n')).toContain('安装失败 a：boom');
      expect(logs.join('\n')).toContain('已全局安装 1/2 个插件');
      expect(logs.join('\n')).toContain('失败：a'); // 部分失败必须看得见，不静默
    });

    it('TC8: execAsync 把 stderr 归一成 Error（供失败汇总用）', async () => {
      await expect(execAsync('node -e "process.exit(3)"')).rejects.toThrow();
    });
  });

  // ═══════════════════ server ═══════════════════

  describe('serverCommand', () => {
    it('TC9: start — 已在运行（/probe 通）→ 复用，不起第二个进程', async () => {
      net.probe = true;
      await serverCommand('start');
      expect(logs.join('\n')).toContain('已在运行');
      expect(net.calls.some((u) => u.includes('/probe'))).toBe(true);
    });

    it('TC10: start — 端口被**不兼容的旧版** server 占着 → 报错，不静默混用', async () => {
      net.probe = false;
      net.status = true; // 有 server 应答 /status，但没有 /probe
      await expect(serverCommand('start')).rejects.toThrow(/不兼容的旧版实现/);
    });

    it('TC11: stop — 请求 /shutdown', async () => {
      net.shutdown = true;
      await serverCommand('stop');
      expect(net.calls.some((u) => u.includes('/shutdown'))).toBe(true);
      expect(logs.join('\n')).toContain('已请求关闭');
    });

    it('TC12: stop — 关闭请求失败 → 如实报错（不谎报已停止）', async () => {
      net.shutdown = false;
      await serverCommand('stop');
      expect(logs.join('\n')).toContain('关闭失败');
    });

    it('TC13: status — 运行中打印 /status 快照', async () => {
      net.status = true;
      await serverCommand('status');
      expect(logs.join('\n')).toContain('"state": "ready"');
    });

    it('TC14: status — 未运行 → 提示端口', async () => {
      net.status = false;
      await serverCommand('status');
      expect(logs.join('\n')).toContain('未运行');
    });

    it('TC15: 未知 action → 报错退出（exit 2）', async () => {
      const code = [];
      vi.spyOn(process, 'exit').mockImplementation((c) => { code.push(c); throw new Error('exit'); });
      await expect(serverCommand('restart')).rejects.toThrow('exit');
      expect(code).toEqual([2]);
      expect(errors.join('\n')).toContain('未知动作：restart');
    });
  });

  // ═══════════════════ open ═══════════════════

  describe('openCommand', () => {
    it('TC16: 三个别名都有对应路径（与 CLAUDE.md 命令表一致）', () => {
      expect(Object.keys(TARGETS).sort()).toEqual(['dashboard', 'tree', 'ui']);
    });

    it('TC17: 打印带项目作用域的 URL（缺 ?p 会落到 server 的 boot 项目）', () => {
      const proj = tmpProject();
      vi.spyOn(process, 'cwd').mockReturnValue(proj);
      // browser 换成无副作用的 `true`（命令自带的可注入参数，不必为此加产线缝）
      openCommand('dashboard', { browser: 'true' });
      expect(logs.join('\n')).toContain(`http://localhost:8787/dashboard?p=${encodeURIComponent(proj)}`);
    });

    it('TC18: 未知 target → 报错退出（exit 2）', () => {
      const code = [];
      vi.spyOn(process, 'exit').mockImplementation((c) => { code.push(c); throw new Error('exit'); });
      expect(() => openCommand('invalid')).toThrow('exit');
      expect(code).toEqual([2]);
      expect(errors.join('\n')).toContain('未知页面：invalid');
    });
  });

  // ═══════════════════ attach ═══════════════════

  describe('attachCommand', () => {
    // 命令是 async：它先问 server 的 /probe「本项目有没有网页观看地址」（网页形态），
    // 没有才落到端口的 attach（终端形态）。这里 server 没起 → probe 拿不到 → 走 attach → 失败退出。
    it('TC19: 会话不存在 → 报错退出（exit 1），不静默吞掉', async () => {
      // 指向一个必然没有对应 tmux 会话的临时目录（会话名 = cc-<projectSid(该目录)>）
      vi.spyOn(process, 'cwd').mockReturnValue(tmpProject());
      const code = [];
      vi.spyOn(process, 'exit').mockImplementation((c) => { code.push(c); throw new Error('exit'); });
      await expect(attachCommand()).rejects.toThrow('exit');
      expect(code).toEqual([1]);
      expect(errors.join('\n')).toContain('无法接入会话');
    });
  });
});

// `awf plan` 的描述来自 shell 的位置参数：中文引号 `“…”` 不是 shell 的引号字符，
// 会被按空格切开 —— 只取第一个参数就会**静默截断**（真机踩到：模型只收到「设计一个」）。
describe('planCommand · 描述归一化', () => {
  it('多个位置参数拼回一句（中文引号场景）', () => {
    expect(normalizeDescription(['“设计一个', 'Prompt', '系统”'])).toBe('“设计一个 Prompt 系统”');
  });

  it('单参数原样保留；空/未提供 → undefined', () => {
    expect(normalizeDescription('设计一个系统')).toBe('设计一个系统');
    expect(normalizeDescription('   ')).toBeUndefined();
    expect(normalizeDescription(undefined)).toBeUndefined();
  });

  it('引号没闭合时打出「实际收到」的提示（截断必须看得见）', () => {
    const errors = [];
    vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')); });
    const out = normalizeDescription(['“设计一个']);
    expect(out).toBe('“设计一个');
    expect(errors.join('\n')).toContain('引号看起来没闭合');
    expect(errors.join('\n')).toContain('“设计一个');
  });
});
