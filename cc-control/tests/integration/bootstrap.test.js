import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BOOTSTRAP = path.join(ROOT, 'scripts', 'bootstrap.sh');
const TEMPLATE_HOOKS = path.join(ROOT, 'src', 'server', 'hooks', 'settings.json');
const TEMPLATE_MCP = path.join(ROOT, 'src', 'mcp', 'mcp.json.template');
const SYSTEM_PATH = '/usr/bin:/bin';

// ── 临时环境 + PATH stub（tmux/claude/sleep 记日志，不真正执行）──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bootstrap-test-'));
const STUBBIN = path.join(TMP, 'bin');
const STUB_LOG = path.join(TMP, 'stub.log');
const WORKDIR = path.join(TMP, 'work');
fs.mkdirSync(STUBBIN, { recursive: true });
fs.mkdirSync(WORKDIR, { recursive: true });

function writeStub(name, body) {
  fs.writeFileSync(path.join(STUBBIN, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

writeStub('tmux', `
echo "tmux $*" >> "$STUB_LOG"
if [ "$1" = "has-session" ]; then
  [ "\${STUB_HAS_SESSION:-0}" = "1" ] && exit 0 || exit 1
fi
exit 0
`);
writeStub('claude', `
echo "claude $*" >> "$STUB_LOG"
exit 0
`);
writeStub('sleep', 'exit 0'); // 消除脚本尾部 sleep 3 的等待

// 生成只含指定 stub 的 bin 目录（模拟 tmux/claude 缺失）
function subsetBin(names) {
  const dir = fs.mkdtempSync(path.join(TMP, 'bin-'));
  for (const n of names) fs.copyFileSync(path.join(STUBBIN, n), path.join(dir, n));
  return dir;
}

function runBootstrap({ script = BOOTSTRAP, binDir = STUBBIN, env = {} } = {}) {
  return spawnSync('bash', [script], {
    env: {
      ...process.env,
      PATH: `${binDir}:${SYSTEM_PATH}`,
      STUB_LOG,
      STUB_HAS_SESSION: '0', // 默认 session 不存在 → 走创建分支
      CC_WORKDIR: WORKDIR,
      ...env,
    },
    encoding: 'utf8',
    timeout: 30000,
  });
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));

beforeEach(() => {
  fs.writeFileSync(STUB_LOG, '');
  fs.rmSync(WORKDIR, { recursive: true, force: true });
  fs.mkdirSync(WORKDIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('环境检查', () => {
  it('TC1: tmux 未安装 → exit 1', () => {
    const res = runBootstrap({ binDir: subsetBin(['claude', 'sleep']) });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('tmux not found. Install with: brew install tmux');
    expect(fs.existsSync(path.join(WORKDIR, '.claude'))).toBe(false); // 渲染未执行
  });

  it('TC2: claude 未安装 → exit 1', () => {
    const res = runBootstrap({ binDir: subsetBin(['tmux', 'sleep']) });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('claude not found on PATH');
    expect(fs.existsSync(path.join(WORKDIR, '.claude'))).toBe(false);
  });
});

describe('配置渲染', () => {
  it('TC3: settings.json __PORT__ 替换正确（CC_PORT=9999）', () => {
    const res = runBootstrap({ env: { CC_PORT: '9999' } });
    expect(res.status).toBe(0);
    const settings = fs.readFileSync(path.join(WORKDIR, '.claude', 'settings.json'), 'utf-8');
    expect(settings).not.toContain('__PORT__');
    expect(settings).toContain('http://127.0.0.1:9999/hook');
    // 原模板不变
    expect(fs.readFileSync(TEMPLATE_HOOKS, 'utf-8')).toContain('__PORT__');
  });

  it('TC4: .mcp.json __TOOLS__ 替换正确', () => {
    runBootstrap();
    const mcp = fs.readFileSync(path.join(WORKDIR, '.mcp.json'), 'utf-8');
    expect(mcp).toContain(`${ROOT}/src/mcp/awf-state/server.cjs`);
    expect(mcp).toContain(`${ROOT}/src/mcp/awf-session/server.cjs`);
    expect(mcp).toContain(`${ROOT}/src/mcp/awf-oneshot/server.cjs`);
    expect(fs.readFileSync(TEMPLATE_MCP, 'utf-8')).toContain('__TOOLS__');
  });

  it('TC5: .mcp.json __WORKDIR__ 替换正确', () => {
    const customWork = path.join(TMP, 'custom-work');
    runBootstrap({ env: { CC_WORKDIR: customWork } });
    const parsed = readJson(path.join(customWork, '.mcp.json'));
    expect(parsed.mcpServers['awf-state'].env.AWF_PROJECT_ROOT).toBe(customWork);
  });

  it('TC6: .mcp.json 渲染后 JSON 合法（3 个 server）', () => {
    runBootstrap();
    const parsed = readJson(path.join(WORKDIR, '.mcp.json'));
    expect(Object.keys(parsed.mcpServers)).toEqual(['awf-state', 'awf-session', 'awf-oneshot']);
    for (const s of Object.values(parsed.mcpServers)) {
      expect(s.command).toBe('node');
      expect(Array.isArray(s.args)).toBe(true);
    }
  });
});

describe('Session 管理', () => {
  it('TC7: session 不存在 → 创建（new-session + claude 命令）', () => {
    const res = runBootstrap();
    expect(res.status).toBe(0);
    const log = fs.readFileSync(STUB_LOG, 'utf-8');
    expect(log).toContain(`tmux has-session -t cc`);
    expect(log).toContain(`tmux new-session -d -s cc -x 200 -y 50 -c ${WORKDIR}`);
    expect(log).toContain('claude --plugin-dir');
    expect(log).toContain('--permission-mode bypassPermissions');
  });

  it('TC8: session 已存在 → exit 0 不创建', () => {
    const res = runBootstrap({ env: { STUB_HAS_SESSION: '1' } });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("tmux session 'cc' already exists");
    const log = fs.readFileSync(STUB_LOG, 'utf-8');
    expect(log).toContain('has-session -t cc');
    expect(log).not.toContain('new-session');
  });

  it('TC9: CC_SESSION 环境变量 → 自定义名称', () => {
    runBootstrap({ env: { CC_SESSION: 'my-workflow' } });
    const log = fs.readFileSync(STUB_LOG, 'utf-8');
    expect(log).toContain('has-session -t my-workflow');
    expect(log).toContain('new-session -d -s my-workflow');
  });

  it('TC10: tmux new-session 参数验证', () => {
    runBootstrap();
    const log = fs.readFileSync(STUB_LOG, 'utf-8');
    const line = log.split('\n').find((l) => l.startsWith('tmux new-session'));
    expect(line).toContain('-d');
    expect(line).toContain('-s cc');
    expect(line).toContain('-x 200 -y 50');
    expect(line).toContain(`-c ${WORKDIR}`);
    expect(line).toContain('claude --plugin-dir');
  });
});

describe('边界', () => {
  it('TC11: WORKDIR 不存在 → mkdir -p 递归创建', () => {
    const nested = path.join(TMP, 'nested', 'deep', 'work');
    const res = runBootstrap({ env: { CC_WORKDIR: nested } });
    expect(res.status).toBe(0);
    expect(fs.existsSync(path.join(nested, '.claude', 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(nested, '.mcp.json'))).toBe(true);
  });

  it('TC12: CC_PORT 自定义端口 → settings + .mcp.json 均替换', () => {
    runBootstrap({ env: { CC_PORT: '9999' } });
    const settings = fs.readFileSync(path.join(WORKDIR, '.claude', 'settings.json'), 'utf-8');
    expect(settings).toContain('http://127.0.0.1:9999/hook');
    expect(settings).not.toContain('__PORT__');
    const mcp = readJson(path.join(WORKDIR, '.mcp.json'));
    expect(mcp.mcpServers['awf-session'].env.AWF_BASE).toBe('http://127.0.0.1:9999');
  });

  it('TC13: trust prompt 消除（sleep 3 + send-keys Enter）', () => {
    const res = runBootstrap();
    expect(res.status).toBe(0);
    const log = fs.readFileSync(STUB_LOG, 'utf-8');
    expect(log).toContain('send-keys -t cc Enter');
    const src = fs.readFileSync(BOOTSTRAP, 'utf-8');
    expect(src).toContain('sleep 3');
  });

  it('TC14: 特殊字符路径（WORKDIR 与 ROOT 均含空格）', () => {
    // (a) WORKDIR 含空格
    const spacedWork = path.join(TMP, 'my work', 'proj');
    runBootstrap({ env: { CC_WORKDIR: spacedWork } });
    expect(fs.existsSync(path.join(spacedWork, '.mcp.json'))).toBe(true);
    expect(readJson(path.join(spacedWork, '.mcp.json')).mcpServers['awf-state'].env.AWF_PROJECT_ROOT).toBe(spacedWork);

    // (b) ROOT 含空格（拷贝脚本 + 模板到带空格的项目目录，验证 sed | 分隔符与引号保护）
    const spacedProject = path.join(TMP, 'my project', 'cc-control');
    fs.mkdirSync(path.join(spacedProject, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(spacedProject, 'src', 'server', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(spacedProject, 'src', 'mcp'), { recursive: true });
    fs.copyFileSync(BOOTSTRAP, path.join(spacedProject, 'scripts', 'bootstrap.sh'));
    fs.copyFileSync(TEMPLATE_HOOKS, path.join(spacedProject, 'src', 'server', 'hooks', 'settings.json'));
    fs.copyFileSync(TEMPLATE_MCP, path.join(spacedProject, 'src', 'mcp', 'mcp.json.template'));

    const res = runBootstrap({ script: path.join(spacedProject, 'scripts', 'bootstrap.sh') });
    expect(res.status).toBe(0);
    const mcp = fs.readFileSync(path.join(WORKDIR, '.mcp.json'), 'utf-8');
    expect(mcp).toContain(`${spacedProject}/src/mcp/awf-state/server.cjs`);
    expect(() => JSON.parse(mcp)).not.toThrow();
  });
});
