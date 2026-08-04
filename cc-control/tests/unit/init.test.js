import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { mockExecSync, mockExec } from '../helpers/mock-child-process.js';

// ── mocks ──

const { mockPromptVersion } = vi.hoisted(() => ({
  mockPromptVersion: vi.fn(() => Promise.resolve('0.1.0')),
}));

vi.mock('../../src/cli/version-prompt.js', () => ({
  promptVersion: mockPromptVersion,
}));

const FAKE_ROOT = '/tmp/awf-test-cc-control';

vi.mock('../../src/cli/paths.js', () => ({
  getPaths: vi.fn(() => ({
    projectRoot: FAKE_ROOT,
    claudePlugins: `${FAKE_ROOT}/fake-claude-plugins`,
    ccSettings: `${FAKE_ROOT}/.claude/settings.json`,
  })),
  pluginCmd: vi.fn((cmd) => `/ai-workflow:${cmd}`),
  PLUGIN_NS: 'ai-workflow',
}));

import { initCommand } from '../../src/cli/init.js';

// ── template helpers ──

async function setupTemplates() {
  const tmplDir = path.join(FAKE_ROOT, 'src', 'templates', 'awf');
  const bugsDir = path.join(tmplDir, 'bugs');
  await fs.mkdir(bugsDir, { recursive: true });
  await fs.writeFile(path.join(tmplDir, 'README.md'), '# AI Workflow\n');
  await fs.writeFile(path.join(bugsDir, 'TEMPLATE.md'), '# Bug Template\n');

  const claudeMdTmpl = path.join(FAKE_ROOT, 'src', 'templates', 'CLAUDE.md.template');
  await fs.mkdir(path.dirname(claudeMdTmpl), { recursive: true });
  await fs.writeFile(claudeMdTmpl, [
    '<!-- awf-rules start -->',
    '',
    '## awf 模式',
    '',
    '读取 `state.json` 的 `mode` 字段确定当前模式：',
    '',
    '<!-- awf-rules end -->',
    '',
  ].join('\n'));

  const stateTmplDir = path.join(FAKE_ROOT, 'src', 'mcp', 'awf-state');
  await fs.mkdir(stateTmplDir, { recursive: true });
  await fs.writeFile(
    path.join(stateTmplDir, 'state.template.json'),
    JSON.stringify({ mode: 'idle', version: '{{VERSION}}', lastUpdated: '{{TIMESTAMP}}' }, null, 2),
  );
}

function withDeps() {
  mockExecSync.mockImplementation((cmd) => {
    if (cmd.includes('command -v tmux')) return Buffer.from('/usr/bin/tmux');
    if (cmd.includes('command -v claude')) return Buffer.from('/usr/bin/claude');
    if (cmd.includes('cat')) return Buffer.from(JSON.stringify({ plugins: {} }));
    return Buffer.from('');
  });
  mockExec.mockImplementation((_c, _o, cb) => cb(null, '', ''));
}

function withoutClaude() {
  mockExecSync.mockImplementation((cmd) => {
    if (cmd.includes('command -v claude')) throw new Error('not found');
    if (cmd.includes('command -v tmux')) return Buffer.from('/usr/bin/tmux');
    return Buffer.from('');
  });
  mockExec.mockImplementation((_c, _o, cb) => cb(null, '', ''));
}

function withoutTmux() {
  mockExecSync.mockImplementation((cmd) => {
    if (cmd.includes('command -v tmux')) throw new Error('not found');
    if (cmd.includes('command -v claude')) return Buffer.from('/usr/bin/claude');
    if (cmd.includes('cat')) return Buffer.from(JSON.stringify({ plugins: {} }));
    return Buffer.from('');
  });
  mockExec.mockImplementation((_c, _o, cb) => cb(null, '', ''));
}

// ── tests ──

describe('initCommand', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-init-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    vi.spyOn(process, 'exit').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    mockPromptVersion.mockResolvedValue('0.1.0');
    mockExecSync.mockReset();
    mockExec.mockReset();
    await setupTemplates();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(FAKE_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('TC1: 首次 init 完整流程 — 创建 .awf/ + state.json + CLAUDE.md', async () => {
    withDeps();
    await initCommand({ force: false });

    const awf = path.join(tmpDir, '.awf');
    expect((await fs.stat(awf)).isDirectory()).toBe(true);

    const raw = await fs.readFile(path.join(awf, 'state.json'), 'utf-8');
    expect(raw).toContain('0.1.0');
    expect(raw).not.toContain('{{VERSION}}');

    const md = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(md).toContain('<!-- awf-rules start -->');
  });

  it('TC2: 重复 init — .awf/ 已存在，文件不变', async () => {
    withDeps();
    await initCommand({ force: false });
    const before = (await fs.stat(path.join(tmpDir, '.awf', 'state.json'))).mtimeMs;

    await initCommand({ force: false });
    const after = (await fs.stat(path.join(tmpDir, '.awf', 'state.json'))).mtimeMs;

    expect(after).toBe(before);
  });

  it('TC3: --force 补全缺失文件，已有文件不动', async () => {
    withDeps();
    await initCommand({ force: false });

    const bugs = path.join(tmpDir, '.awf', 'bugs');
    await fs.rm(bugs, { recursive: true });
    const state1 = await fs.readFile(path.join(tmpDir, '.awf', 'state.json'), 'utf-8');

    await initCommand({ force: true });

    expect((await fs.stat(bugs)).isDirectory()).toBe(true);
    const state2 = await fs.readFile(path.join(tmpDir, '.awf', 'state.json'), 'utf-8');
    expect(state2).toBe(state1);
  });

  it('TC4: tmux 未安装 — warn 不阻断', async () => {
    withoutTmux();
    await initCommand({ force: false });
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it('TC5: claude 未安装 — error 阻断', async () => {
    withoutClaude();
    await initCommand({ force: false });
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  describe('CLAUDE.md — 4 场景', () => {
    it('TC6: 不存在 → 创建', async () => {
      withDeps();
      await initCommand({ force: false });
      const md = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
      expect(md).toContain('<!-- awf-rules start -->');
      expect(md).toContain('awf 模式');
    });

    it('TC7: 存在但无 awf 标记 → 追加注入', async () => {
      withDeps();
      await fs.writeFile(path.join(tmpDir, 'CLAUDE.md'), '# My Project\n');
      await initCommand({ force: false });

      const md = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
      expect(md).toContain('# My Project');
      expect(md).toContain('<!-- awf-rules start -->');
      expect(md.indexOf('# My Project')).toBeLessThan(md.indexOf('<!-- awf-rules start -->'));
    });

    it('TC8: 已有 awf 标记 → 跳过', async () => {
      withDeps();
      const orig = '<!-- awf-rules start -->\nbar\n<!-- awf-rules end -->\n';
      await fs.writeFile(path.join(tmpDir, 'CLAUDE.md'), orig);
      await initCommand({ force: false });

      const md = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
      expect(md).toBe(orig);
    });

    it('TC9: 模板文件缺失 → warn 跳过', async () => {
      withDeps();
      await fs.rm(path.join(FAKE_ROOT, 'src', 'templates', 'CLAUDE.md.template'), { force: true });
      await initCommand({ force: false });

      const exists = await fs.stat(path.join(tmpDir, 'CLAUDE.md')).catch(() => null);
      expect(exists).toBeNull();
      expect(process.exit).not.toHaveBeenCalledWith(1);
    });
  });

  it('TC10: 模板目录缺失 → fallback 空 .awf/', async () => {
    withDeps();
    await fs.rm(path.join(FAKE_ROOT, 'src', 'templates', 'awf'), { recursive: true, force: true });
    await initCommand({ force: false });

    const awf = path.join(tmpDir, '.awf');
    expect((await fs.stat(awf)).isDirectory()).toBe(true);
    const hasState = await fs.stat(path.join(awf, 'state.json')).catch(() => null);
    expect(hasState).toBeNull();
  });

  it('TC11: 插件安装 exec 失败 — 报错不阻断', async () => {
    mockExecSync.mockImplementation((cmd) => {
      if (cmd.includes('command -v tmux')) return Buffer.from('/usr/bin/tmux');
      if (cmd.includes('command -v claude')) return Buffer.from('/usr/bin/claude');
      if (cmd.includes('cat')) return Buffer.from(JSON.stringify({ plugins: {} }));
      return Buffer.from('');
    });
    mockExec.mockImplementation((_c, _o, cb) => cb(new Error('boom'), '', ''));

    await initCommand({ force: false });
    expect((await fs.stat(path.join(tmpDir, '.awf'))).isDirectory()).toBe(true);
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it('TC12: .awf-plugins.json 不存在 → 空列表', async () => {
    withDeps();
    await initCommand({ force: false });
    expect((await fs.stat(path.join(tmpDir, '.awf'))).isDirectory()).toBe(true);
  });

  it('TC13: .awf-plugins.json 非法 JSON → 空列表', async () => {
    withDeps();
    await fs.writeFile(path.join(tmpDir, '.awf-plugins.json'), '!!!broken');
    await initCommand({ force: false });
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it('TC14: version 为空 → state.json 保留 {{VERSION}} 占位符', async () => {
    withDeps();
    mockPromptVersion.mockResolvedValue('');
    await initCommand({ force: false });

    const raw = await fs.readFile(path.join(tmpDir, '.awf', 'state.json'), 'utf-8');
    expect(raw).toContain('{{VERSION}}');
  });

  it('TC15: 有效 symlink → 跳过安装', async () => {
    const pluginsDir = path.join(FAKE_ROOT, 'fake-claude-plugins');
    await fs.mkdir(pluginsDir, { recursive: true });

    const real = path.join(tmpDir, 'real-plugin');
    await fs.mkdir(real, { recursive: true });
    await fs.writeFile(path.join(real, 'plugin.json'), '{}');
    await fs.symlink(real, path.join(pluginsDir, 'ai-workflow'));

    mockExecSync.mockImplementation((cmd) => {
      if (cmd.includes('command -v tmux')) return Buffer.from('/usr/bin/tmux');
      if (cmd.includes('command -v claude')) return Buffer.from('/usr/bin/claude');
      if (cmd.includes('cat')) return Buffer.from(JSON.stringify({ plugins: { 'ai-workflow@ai-workflow-dev': true } }));
      return Buffer.from('');
    });
    mockExec.mockImplementation((_c, _o, cb) => cb(null, '', ''));

    await initCommand({ force: false });

    const link = path.join(pluginsDir, 'ai-workflow');
    expect(await fs.stat(link).catch(() => null)).not.toBeNull();

    const instCalls = mockExec.mock.calls.filter(([c]) => c && c.includes('claude plugin install'));
    expect(instCalls).toHaveLength(0);
  });

  it('TC16: 无效 symlink → 清理后重装', async () => {
    const pluginsDir = path.join(FAKE_ROOT, 'fake-claude-plugins');
    await fs.mkdir(pluginsDir, { recursive: true });

    const empty = path.join(tmpDir, 'empty');
    await fs.mkdir(empty, { recursive: true });
    await fs.symlink(empty, path.join(pluginsDir, 'ai-workflow'));

    withDeps();
    await initCommand({ force: false });

    expect(await fs.stat(path.join(pluginsDir, 'ai-workflow')).catch(() => null)).toBeNull();
  });
});
