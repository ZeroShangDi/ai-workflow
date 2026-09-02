import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { mockExecSync, mockExec } from '../helpers/mock-child-process.js';

// ── mocks ──

// 版本号确认（promptVersion）在 src/cli/init.js 暂时禁用，version.js 的 mock 已移除。
// 重新启用版本处理时，需补回 vi.mock 及对应用例。

const FAKE_ROOT = '/tmp/awf-test-cc-control';

vi.mock('../../src/lib/paths.js', () => ({
  getPaths: vi.fn(() => ({
    projectRoot: FAKE_ROOT,
    claudePlugins: `${FAKE_ROOT}/fake-claude-plugins`,
    ccSettings: `${FAKE_ROOT}/.claude/settings.json`,
  })),
}));

import { initCommand } from '../../src/cli/init.js';

// ── template helpers ──

async function setupTemplates() {
  const tmplDir = path.join(FAKE_ROOT, 'src', 'templates');
  await fs.mkdir(tmplDir, { recursive: true });
  // .awf 骨架模板（精简：README + config，无 TEMPLATE.md）
  await fs.writeFile(path.join(tmplDir, 'awf-README.md'), '# AI Workflow\n');
  await fs.writeFile(path.join(tmplDir, 'awf-config.json'), JSON.stringify({ run: { agents: { max: 1 } } }, null, 2));
  await fs.writeFile(path.join(tmplDir, 'architecture.md'), '# Architecture Map\n');

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

  const stateTmplDir = path.join(FAKE_ROOT, 'plugin', 'core', 'mcp', 'awf-state');
  await fs.mkdir(stateTmplDir, { recursive: true });
  await fs.writeFile(
    path.join(stateTmplDir, 'state.template.json'),
    JSON.stringify({ mode: 'idle', version: '{{VERSION}}', lastUpdated: '{{TIMESTAMP}}' }, null, 2),
  );

  // 本地注册插件：plugin/settings.json（安装清单，init 注入到项目 .claude/settings.json）
  const profileSettings = path.join(FAKE_ROOT, 'plugin', 'settings.json');
  await fs.mkdir(path.dirname(profileSettings), { recursive: true });
  await fs.writeFile(profileSettings, JSON.stringify({
    plugins: ['ai-workflow-core@ai-workflow-dev', 'ai-workflow-code@ai-workflow-dev'],
    enabledPlugins: {
      'ai-workflow-core@ai-workflow-dev': true,
      'ai-workflow-code@ai-workflow-dev': true,
    },
    extraKnownMarketplaces: {
      'ai-workflow-dev': { source: { source: 'directory', path: '<pkg>/plugin' } },
    },
  }, null, 2));
}

function withDeps() {
  mockExecSync.mockImplementation((cmd) => {
    if (cmd.includes('command -v tmux')) return Buffer.from('/usr/bin/tmux');
    if (cmd.includes('command -v claude')) return Buffer.from('/usr/bin/claude');
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

    mockExecSync.mockReset();
    mockExec.mockReset();
    await setupTemplates();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(FAKE_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('TC1: 首次 init 完整流程 — .awf/ + 本地注册 settings.json + CLAUDE.md', async () => {
    withDeps();
    await initCommand({ force: false });

    const awf = path.join(tmpDir, '.awf');
    expect((await fs.stat(awf)).isDirectory()).toBe(true);

    // 版本处理禁用：VERSION 保留占位符；TIMESTAMP 已替换为 ISO
    const raw = await fs.readFile(path.join(awf, 'state.json'), 'utf-8');
    expect(raw).toContain('{{VERSION}}');
    expect(raw).not.toContain('{{TIMESTAMP}}');
    expect(raw).toMatch(/"lastUpdated": "20\d\d-\d\d-\d\dT/);
    expect(await fs.readFile(path.join(awf, 'context', 'architecture.md'), 'utf-8')).toContain('Architecture Map');

    // 本地注册插件：plugin/settings.json 注入到项目 .claude/settings.json（无 exec 安装）
    const settingsRaw = await fs.readFile(path.join(tmpDir, '.claude', 'settings.json'), 'utf-8');
    const settings = JSON.parse(settingsRaw);
    expect(settings.enabledPlugins['ai-workflow-core@ai-workflow-dev']).toBe(true);
    expect(settings.enabledPlugins['ai-workflow-code@ai-workflow-dev']).toBe(true);
    expect(settings.extraKnownMarketplaces['ai-workflow-dev'].source.path).toBe(`${FAKE_ROOT}/plugin`);
    const instCalls = mockExec.mock.calls.filter(([c]) => c && c.includes('claude plugin install'));
    expect(instCalls).toHaveLength(0);

    // 完成提示输出
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('✔ 初始化完成'));

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
    // warn 提示输出
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('未安装 — brew install tmux'));
    // 后续步骤继续执行（.awf 仍被创建）
    expect((await fs.stat(path.join(tmpDir, '.awf'))).isDirectory()).toBe(true);
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

  it('TC10: 模板缺失 → fallback 空 .awf/', async () => {
    withDeps();
    await fs.rm(path.join(FAKE_ROOT, 'src', 'templates', 'awf-README.md'), { force: true });
    await initCommand({ force: false });

    const awf = path.join(tmpDir, '.awf');
    expect((await fs.stat(awf)).isDirectory()).toBe(true);
    const hasState = await fs.stat(path.join(awf, 'state.json')).catch(() => null);
    expect(hasState).toBeNull();
  });

  it('TC11: 插件模板缺失 → 本地注册 warn 不阻断', async () => {
    withDeps();
    await fs.rm(path.join(FAKE_ROOT, 'plugin', 'settings.json'), { force: true });
    await initCommand({ force: false });
    expect((await fs.stat(path.join(tmpDir, '.awf'))).isDirectory()).toBe(true);
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  // 已删除 TC12/TC13：init 不再读取 .plugins.json（本地注入 settings.json；全局安装改读 plugin/plugin-code/settings.json 的 plugins 字段，见 cli-aux.test.js）
  // 已删除 TC15/TC16：init 不再处理符号链接安装（symlink 清理迁至全局安装 installAllPlugins）

  it('TC14: 版本处理禁用 → state.json 保留 {{VERSION}} 占位符', async () => {
    withDeps();
    await initCommand({ force: false });

    const raw = await fs.readFile(path.join(tmpDir, '.awf', 'state.json'), 'utf-8');
    expect(raw).toContain('{{VERSION}}');
  });
});
