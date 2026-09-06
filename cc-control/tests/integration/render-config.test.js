import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const RENDER = path.join(ROOT, 'scripts', 'render-config.mjs');
const PLUGIN_CONFIG = path.join(ROOT, 'plugin', 'config.json');
const NODE = process.execPath;

// ── 独立沙箱渲染（--workdir 模式，已从 bootstrap.sh 拆出，手动调用）──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-render-config-test-'));

function render(workdir, port) {
  const args = [RENDER, '--workdir', workdir];
  if (port) args.push('--port', String(port));
  return spawnSync(NODE, args, { encoding: 'utf8' });
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('render-config --workdir 独立沙箱渲染', () => {
  it('TC1: settings.json __PORT__ 替换正确（--port 9999）', () => {
    const work = path.join(TMP, 'w1');
    const res = render(work, 9999);
    expect(res.status).toBe(0);
    const settings = fs.readFileSync(path.join(work, '.claude', 'settings.json'), 'utf-8');
    expect(settings).not.toContain('__PORT__');
    expect(settings).toContain('http://127.0.0.1:9999/hook');
    // 唯一配置源不变（hooks 仍用 __PORT__ 占位）
    expect(fs.readFileSync(PLUGIN_CONFIG, 'utf-8')).toContain('__PORT__');
  });

  it('TC2: .mcp.json 相对路径渲染为绝对路径', () => {
    const work = path.join(TMP, 'w2');
    render(work);
    const mcp = fs.readFileSync(path.join(work, '.mcp.json'), 'utf-8');
    expect(mcp).toContain(`${ROOT}/plugin/core/mcp/awf-state/server.cjs`);
    expect(mcp).toContain(`${ROOT}/plugin/core/mcp/awf-session/server.cjs`);
    expect(mcp).toContain(`${ROOT}/plugin/core/mcp/awf-oneshot/server.cjs`);
    // 配置源 mcp args 保持相对路径
    expect(fs.readFileSync(PLUGIN_CONFIG, 'utf-8')).toContain('./mcp/awf-state/server.cjs');
  });

  it('TC3: .mcp.json awf-state 不携带 AWF_PROJECT_ROOT（server 用 cwd 回退）', () => {
    const work = path.join(TMP, 'w3');
    render(work);
    const parsed = readJson(path.join(work, '.mcp.json'));
    expect(parsed.mcpServers['awf-state'].env).toBeUndefined();
  });

  it('TC4: .mcp.json 渲染后 JSON 合法（3 个 server）', () => {
    const work = path.join(TMP, 'w4');
    render(work);
    const parsed = readJson(path.join(work, '.mcp.json'));
    expect(Object.keys(parsed.mcpServers)).toEqual(['awf-state', 'awf-session', 'awf-oneshot']);
    for (const s of Object.values(parsed.mcpServers)) {
      expect(s.command).toBe('node');
      expect(Array.isArray(s.args)).toBe(true);
    }
  });

  it('TC5: workdir 不存在 → 递归创建', () => {
    const nested = path.join(TMP, 'nested', 'deep', 'work');
    const res = render(nested);
    expect(res.status).toBe(0);
    expect(fs.existsSync(path.join(nested, '.claude', 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(nested, '.mcp.json'))).toBe(true);
  });

  it('TC6: --port 自定义 → settings + .mcp.json 均替换', () => {
    const work = path.join(TMP, 'w6');
    render(work, 9999);
    const settings = fs.readFileSync(path.join(work, '.claude', 'settings.json'), 'utf-8');
    expect(settings).toContain('http://127.0.0.1:9999/hook');
    expect(settings).not.toContain('__PORT__');
    const mcp = readJson(path.join(work, '.mcp.json'));
    expect(mcp.mcpServers['awf-session'].env.AWF_BASE).toBe('http://127.0.0.1:9999');
  });

  it('TC7: 特殊字符路径（workdir 含空格）', () => {
    const spacedWork = path.join(TMP, 'my work', 'proj');
    render(spacedWork);
    expect(fs.existsSync(path.join(spacedWork, '.mcp.json'))).toBe(true);
    expect(readJson(path.join(spacedWork, '.mcp.json')).mcpServers['awf-state'].env).toBeUndefined();
  });

  it('TC8: 特殊字符路径（ROOT 含空格，拷贝脚本 + config + 共享模块到带空格目录）', () => {
    const spacedProject = path.join(TMP, 'my project', 'cc-control');
    fs.mkdirSync(path.join(spacedProject, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(spacedProject, 'plugin'), { recursive: true });
    fs.mkdirSync(path.join(spacedProject, 'src', 'lib'), { recursive: true });
    fs.copyFileSync(RENDER, path.join(spacedProject, 'scripts', 'render-config.mjs'));
    fs.copyFileSync(PLUGIN_CONFIG, path.join(spacedProject, 'plugin', 'config.json'));
    fs.copyFileSync(
      path.join(ROOT, 'src', 'lib', 'plugin-config.js'),
      path.join(spacedProject, 'src', 'lib', 'plugin-config.js'),
    );

    const work = path.join(TMP, 'w-spaced-root');
    const res = spawnSync(NODE, [path.join(spacedProject, 'scripts', 'render-config.mjs'), '--workdir', work], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    const mcp = fs.readFileSync(path.join(work, '.mcp.json'), 'utf-8');
    expect(mcp).toContain(`${spacedProject}/plugin/core/mcp/awf-state/server.cjs`);
    expect(() => JSON.parse(mcp)).not.toThrow();
  });
});
