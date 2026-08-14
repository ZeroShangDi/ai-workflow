import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BOOTSTRAP = path.join(ROOT, 'scripts', 'bootstrap.sh');
const SYSTEM_PATH = '/usr/bin:/bin';

// ── 临时环境 + PATH stub（tmux/claude/node/sleep 记日志或空转，不真正执行）──
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
writeStub('node', 'exit 0'); // 仅满足 command -v node 前置检查
writeStub('sleep', 'exit 0'); // 消除脚本尾部 sleep 3 的等待

// 生成只含指定 stub 的 bin 目录（模拟 tmux/claude/node 缺失）
function subsetBin(names) {
  const dir = fs.mkdtempSync(path.join(TMP, 'bin-'));
  for (const n of names) fs.copyFileSync(path.join(STUBBIN, n), path.join(dir, n));
  return dir;
}

function runBootstrap({ binDir = STUBBIN, env = {} } = {}) {
  return spawnSync('bash', [BOOTSTRAP], {
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
    const res = runBootstrap({ binDir: subsetBin(['claude', 'node', 'sleep']) });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('tmux not found. Install with: brew install tmux');
  });

  it('TC2: claude 未安装 → exit 1', () => {
    const res = runBootstrap({ binDir: subsetBin(['tmux', 'node', 'sleep']) });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('claude not found on PATH');
  });

  it('TC3: node 未安装（MCP server 需要）→ exit 1', () => {
    const res = runBootstrap({ binDir: subsetBin(['tmux', 'claude', 'sleep']) });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('node not found on PATH');
  });
});

describe('插件加载链路', () => {
  it('TC4: 不渲染 settings.json/.mcp.json — 不覆盖项目注册', () => {
    const res = runBootstrap();
    expect(res.status).toBe(0);
    // 插件/hooks/MCP 由 .claude/settings.json 注册加载，bootstrap 不再写任何文件
    expect(fs.existsSync(path.join(WORKDIR, '.claude', 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(WORKDIR, '.mcp.json'))).toBe(false);
  });
});

describe('Session 管理', () => {
  it('TC5: session 不存在 → 创建（claude 无 --plugin-dir）', () => {
    const res = runBootstrap();
    expect(res.status).toBe(0);
    const log = fs.readFileSync(STUB_LOG, 'utf-8');
    expect(log).toContain(`tmux has-session -t cc`);
    expect(log).toContain(`tmux new-session -d -s cc -x 200 -y 50 -c ${WORKDIR}`);
    expect(log).toContain('claude --permission-mode bypassPermissions');
    expect(log).not.toContain('--plugin-dir');
  });

  it('TC6: session 已存在 → exit 0 不创建', () => {
    const res = runBootstrap({ env: { STUB_HAS_SESSION: '1' } });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("tmux session 'cc' already exists");
    const log = fs.readFileSync(STUB_LOG, 'utf-8');
    expect(log).toContain('has-session -t cc');
    expect(log).not.toContain('new-session');
  });

  it('TC7: CC_SESSION 环境变量 → 自定义名称', () => {
    runBootstrap({ env: { CC_SESSION: 'my-workflow' } });
    const log = fs.readFileSync(STUB_LOG, 'utf-8');
    expect(log).toContain('has-session -t my-workflow');
    expect(log).toContain('new-session -d -s my-workflow');
  });

  it('TC8: tmux new-session 参数验证', () => {
    runBootstrap();
    const log = fs.readFileSync(STUB_LOG, 'utf-8');
    const line = log.split('\n').find((l) => l.startsWith('tmux new-session'));
    expect(line).toContain('-d');
    expect(line).toContain('-s cc');
    expect(line).toContain('-x 200 -y 50');
    expect(line).toContain(`-c ${WORKDIR}`);
    expect(line).not.toContain('--plugin-dir');
  });
});

describe('边界', () => {
  it('TC9: trust prompt 消除（sleep 3 + send-keys Enter）', () => {
    const res = runBootstrap();
    expect(res.status).toBe(0);
    const log = fs.readFileSync(STUB_LOG, 'utf-8');
    expect(log).toContain('send-keys -t cc Enter');
    const src = fs.readFileSync(BOOTSTRAP, 'utf-8');
    expect(src).toContain('sleep 3');
  });
});
