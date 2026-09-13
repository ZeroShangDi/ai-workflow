import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ports = require('../../server/adapters/ports.cjs');
const { installProfile, uninstallProfile, installProjectMcp, listDeclaredPlugins } = ports.profile;

// cc 项目配置注入（.claude/settings.json + .mcp.json）：形状全由 cc 决定，故住 adapters/cc，
// 经 ports 唯一门出。本文件钉住注入的合并/清理语义与「项目自己的配置不被吃掉」。

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-profile-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const readSettings = () => JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));

describe('server · cc 项目配置注入（profile）', () => {
  it('把插件清单合并进 .claude/settings.json，并解析 <pkg> 占位符', () => {
    const r = installProfile(root);
    expect(r.written).toBe(true);
    const s = readSettings();
    expect(s.enabledPlugins['ai-workflow-core'] ?? s.enabledPlugins['ai-workflow-core@ai-workflow-dev']).toBe(true);
    const mpPath = s.extraKnownMarketplaces['ai-workflow-dev'].source.path;
    expect(mpPath.endsWith('/plugin')).toBe(true);
    expect(mpPath).not.toContain('<pkg>'); // 占位符已解析
  });

  it('幂等：重复注入不产生重复项，也不覆盖项目已有配置', () => {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash'] } }));
    installProfile(root);
    installProfile(root);
    const s = readSettings();
    expect(s.permissions).toEqual({ allow: ['Bash'] }); // 项目自己的配置保留
    expect(new Set(s.plugins).size).toBe(s.plugins.length); // 数组无重复
  });

  it('注销是按注入模板的键精确清理 —— 只删注入过的东西', () => {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash'] } }));
    installProfile(root);
    const r = uninstallProfile(root);
    expect(r.written).toBe(true);
    const s = readSettings();
    expect(s.permissions).toEqual({ allow: ['Bash'] }); // 未被误删
    expect(s.enabledPlugins).toBeUndefined();
    expect(s.extraKnownMarketplaces).toBeUndefined();
  });

  it('项目 MCP 注册：绝对路径 + AWF_PROJECT_ROOT + {PORT} 替换，且保留项目已有 server', () => {
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { mine: { command: 'echo' } } }));
    const r = installProjectMcp(root, 8799);
    expect(r.servers.length).toBeGreaterThan(0);
    const m = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    expect(m.mcpServers.mine).toEqual({ command: 'echo' }); // 项目自己的 server 保留
    for (const name of r.servers) {
      const srv = m.mcpServers[name];
      expect(path.isAbsolute(srv.args[0])).toBe(true);   // 必须绝对路径（enabled-only 下唯一入口）
      expect(srv.env.AWF_PROJECT_ROOT).toBe(root);       // 单 server 多项目路由
    }
    expect(m.mcpServers['awf-session'].env.AWF_BASE).toBe('http://127.0.0.1:8799');
  });

  it('插件清单取自 plugin/settings.json（不在 CLI 里重列）', () => {
    const specs = listDeclaredPlugins();
    expect(specs).toContain('ai-workflow-core@ai-workflow-dev');
    expect(specs).toContain('ai-workflow-code@ai-workflow-dev');
  });

  it('经唯一门出：profile 登记在 NON_PORT_TOOLS（不是端口，但只从 ports.cjs 取）', () => {
    const entry = ports.NON_PORT_TOOLS.find((t) => t.name === 'profile');
    expect(entry?.file).toBe('adapters/cc/profile.cjs');
    expect(ports.PORT_NAMES).not.toContain('profile'); // 不是可替换的能力面
  });
});
