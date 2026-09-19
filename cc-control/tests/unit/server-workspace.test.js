import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { initWorkspace, WORKSPACE_DIRS, templatesDir } = require('../../server/shared/workspace.cjs');

// 「awf init 之后项目里长什么样」的唯一知情者：shared/workspace.cjs。
// 本文件钉住骨架目录、模板来源、以及「已存在的文件绝不覆盖」这条安全语义。

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-ws-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const awf = (...p) => path.join(root, '.awf', ...p);

describe('server · 项目工作区（workspace）', () => {
  it('建出完整骨架：文档四类 + 报告分档 + 版本快照 + 动态规划扩展边界', () => {
    const r = initWorkspace(root);
    expect(r.created).toBe(true);
    for (const dir of WORKSPACE_DIRS) {
      expect(fs.existsSync(awf(...dir.split('/'))), dir).toBe(true);
    }
    expect(fs.existsSync(awf('reports', 'lint'))).toBe(true);
    expect(fs.existsSync(awf('dynamic-planning', 'proposals'))).toBe(true);
  });

  it('播模板：README / config / 架构说明 / state（占位符已替换）', () => {
    const r = initWorkspace(root);
    expect(r.files.sort()).toEqual(['README.md', 'config.json', path.join('context', 'architecture.md')].sort());
    expect(r.state).toBe(true);

    const readme = fs.readFileSync(awf('README.md'), 'utf8');
    // 现状：不传 version → {{VERSION}} 原样保留（与旧 CLI 一致 —— 它也是 version=undefined）。
    // 传了才替换，此处验证替换链路本身有效。
    expect(readme).toContain('{{VERSION}}');
    const state = JSON.parse(fs.readFileSync(awf('state.json'), 'utf8'));
    expect(JSON.stringify(state)).not.toContain('{{TIMESTAMP}}');
    expect(JSON.parse(fs.readFileSync(awf('config.json'), 'utf8')).run.agents.max).toBe(1);
  });

  it('传了 version → 模板里的 {{VERSION}} 被替换', () => {
    initWorkspace(root, { version: '9.9.9' });
    expect(fs.readFileSync(awf('README.md'), 'utf8')).not.toContain('{{VERSION}}');
    expect(fs.readFileSync(awf('README.md'), 'utf8')).toContain('9.9.9');
  });

  it('模板来自 server/templates（新树自带，不读旧树 src/templates）', () => {
    expect(templatesDir()).toBe(path.resolve(__dirname, '..', '..', 'server', 'templates'));
    expect(fs.existsSync(path.join(templatesDir(), 'awf-README.md'))).toBe(true);
  });

  it('幂等且安全：已存在时不覆盖用户改过的文件，force 只补缺失', () => {
    expect(initWorkspace(root).created).toBe(true);
    fs.writeFileSync(awf('config.json'), JSON.stringify({ mine: true }));
    fs.rmSync(awf('README.md'));

    const r = initWorkspace(root, { force: true });
    expect(r.created).toBe(false);
    expect(fs.readFileSync(awf('config.json'), 'utf8')).toContain('mine'); // 用户改的没被动
    expect(fs.existsSync(awf('README.md'))).toBe(true);                    // 缺的补上了
    expect(r.files).toEqual(['README.md']);                                // 只补了缺的那个
  });

  it('无 force 时目录已存在 → 整体 no-op', () => {
    initWorkspace(root);
    const r = initWorkspace(root);
    expect(r).toMatchObject({ created: false, dirs: 0, files: [], state: false });
  });
});

// T-P2-02 收口：init 按**解析到的平台**装资产（DSH 装 profile 插件），模板缺省却写 cc。
// 不记就会得到「资产按 dsh 装、项目解析成 cc」——干净项目上 `CC_ADAPTER=dsh awf init` 真机踩到过。
describe('server · 工作区记录平台（runtime.adapter）', () => {
  const cfg = () => JSON.parse(fs.readFileSync(awf('config.json'), 'utf8'));

  it('播种时写入解析到的平台（覆盖模板缺省的 cc）', () => {
    const r = initWorkspace(root, { adapter: 'dsh' });
    expect(cfg().runtime.adapter).toBe('dsh');
    expect(r.adapter).toMatchObject({ changed: true, adapter: 'dsh', previous: 'cc' });
    expect(r.files).toContain('config.json(runtime.adapter)'); // 回执可见，不静默改用户文件
  });

  it('已是该平台 → 不写文件、回执说明', () => {
    initWorkspace(root, { adapter: 'dsh' });
    const before = fs.readFileSync(awf('config.json'), 'utf8');
    const r = initWorkspace(root, { force: true, adapter: 'dsh' });
    expect(r.adapter).toMatchObject({ changed: false, reason: '已记录该平台' });
    expect(fs.readFileSync(awf('config.json'), 'utf8')).toBe(before);
  });

  it('已显式记了别的平台 → 不覆盖用户选择（目录已在时只补缺失字段）', () => {
    fs.mkdirSync(awf(), { recursive: true });
    fs.writeFileSync(awf('config.json'), JSON.stringify({ runtime: { adapter: 'cc' } }));
    const r = initWorkspace(root, { adapter: 'dsh' });
    expect(cfg().runtime.adapter).toBe('cc');
    expect(r.adapter).toMatchObject({ changed: false, previous: 'cc' });
    expect(r.adapter.reason).toContain('不覆盖');
  });

  it('已有项目但缺 runtime.adapter → 补记（否则项目解析回 cc）', () => {
    fs.mkdirSync(awf(), { recursive: true });
    fs.writeFileSync(awf('config.json'), JSON.stringify({ run: { agents: { max: 3 } } }));
    const r = initWorkspace(root, { adapter: 'dsh' });
    expect(cfg().runtime.adapter).toBe('dsh');
    expect(cfg().run.agents.max).toBe(3); // 其余字段原样保留
    expect(r.adapter).toMatchObject({ changed: true, previous: null });
  });

  it('不传 adapter → 完全不动 config.json（缺省路径零行为变化）', () => {
    const r = initWorkspace(root);
    expect(cfg().runtime.adapter).toBe('cc');
    expect(r.adapter).toBe(null);
  });
});
