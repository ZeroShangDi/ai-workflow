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
