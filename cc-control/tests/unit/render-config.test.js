import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  discoverPluginEntries, readPluginConfig, renderPluginJson, renderMarketplace,
  resolvePluginAssets, renderPluginSettings, renderRepoSettings,
} from '../../server/shared/plugin-render.cjs';

const REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PLUGIN = path.join(REPO, 'server', 'adapters', 'cc', 'plugin');
const readFile = (p) => fs.readFileSync(path.join(PLUGIN, p), 'utf8');

// 泛化后的渲染器契约（T1-001）：
// - 各插件由中性源 plugin/<dir>/plugin.json 自动发现；
// - 引擎插件（config.engineDir）的 plugin.json 带 hooks 字段，非引擎插件不带；
// - marketplace.json 依 plugins 遍历生成（source ./<dir>/）。
// 基线 = 提交在库里的产物文件（renderPluginJson/renderMarketplace 与 render-config 共用同一实现）。

describe('渲染器泛化回归 — 现有插件输出与提交基线一致', () => {
  it('目录发现结果直接成为 marketplace.plugins，顺序由各 manifest 的 order 决定', () => {
    const config = readPluginConfig(REPO);
    const entries = discoverPluginEntries(REPO);
    const sourceRoot = path.join(REPO, 'plugin');
    const sourceDirs = fs.readdirSync(sourceRoot, { withFileTypes: true })
      .filter((item) => item.isDirectory() && fs.existsSync(path.join(sourceRoot, item.name, 'plugin.json')))
      .map((item) => item.name)
      .sort();
    const sorted = [...entries].sort((a, b) =>
      (Number(a.order ?? 1000) - Number(b.order ?? 1000)) || a.dir.localeCompare(b.dir));

    expect(config.marketplace.plugins).toEqual(entries);
    expect(entries.map((p) => p.dir).sort()).toEqual(sourceDirs);
    expect(entries).toEqual(sorted);
  });

  it('npm 包不含中性源时，回读 prepack 生成的 CC manifest', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-plugin-discovery-'));
    try {
      const target = path.join(root, 'server', 'adapters', 'cc', 'plugin');
      fs.mkdirSync(path.join(target, 'core'), { recursive: true });
      fs.copyFileSync(path.join(PLUGIN, 'config.json'), path.join(target, 'config.json'));
      fs.copyFileSync(path.join(PLUGIN, 'core', 'plugin.json'), path.join(target, 'core', 'plugin.json'));
      expect(readPluginConfig(root).marketplace.plugins.map((p) => p.name)).toEqual(['ai-workflow-core']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('各插件 renderPluginJson(..., withHooks=dir===engineDir) === 提交的 plugin/<dir>/plugin.json', () => {
    const config = readPluginConfig(REPO);
    const { marketplace, engineDir } = config;
    expect(engineDir).toBeTruthy();
    for (const p of marketplace.plugins) {
      const rendered = renderPluginJson(p, { withHooks: p.dir === engineDir });
      expect(rendered, `plugin/<${p.dir}>/plugin.json 应与提交基线一致`).toBe(readFile(path.join(p.dir, 'plugin.json')));
    }
  });

  it('renderMarketplace === 提交的 plugin/.claude-plugin/marketplace.json', () => {
    const config = readPluginConfig(REPO);
    expect(renderMarketplace(config.marketplace)).toBe(readFile(path.join('.claude-plugin', 'marketplace.json')));
  });

  it('hooks 单源：仅引擎插件 plugin.json 含 hooks 字段，其余插件不含', () => {
    const config = readPluginConfig(REPO);
    const { marketplace, engineDir } = config;
    for (const p of marketplace.plugins) {
      const raw = readFile(path.join(p.dir, 'plugin.json'));
      expect(raw.includes('"hooks"'), `plugin/<${p.dir}>/plugin.json hooks 归属错误`).toBe(p.dir === engineDir);
    }
  });
});

describe('渲染器泛化 — 新增任意 dir 正确生成', () => {
  const EXTRA = {
    dir: 'demo-plugin',
    name: 'ai-workflow-demo',
    description: 'demo 领域插件（任意 dir）',
    version: '0.1.0',
    keywords: ['demo'],
  };

  it('renderPluginJson 接受任意 dir → 生成字段正确且无 hooks 字段', () => {
    const out = renderPluginJson(EXTRA, { withHooks: false });
    const obj = JSON.parse(out);
    expect(obj).toEqual({
      name: 'ai-workflow-demo',
      description: 'demo 领域插件（任意 dir）',
      version: '0.1.0',
      author: { name: 'v-shangjunhao' },
      license: 'MIT',
      keywords: ['demo'],
    });
    expect(obj.hooks).toBeUndefined();
  });

  it('新增任意 dir 模拟 render 循环：仅引擎条目带 hooks，新条目不带', () => {
    const config = readPluginConfig(REPO);
    const plugins = [...config.marketplace.plugins, EXTRA];
    for (const p of plugins) {
      const obj = JSON.parse(renderPluginJson(p, { withHooks: p.dir === config.engineDir }));
      expect(obj.hooks).toBe(p.dir === config.engineDir ? './hooks/hooks.json' : undefined);
      expect(obj.name).toBe(p.name);
    }
  });

  it('marketplace 追加任意新 dir → 条目 +1 且 source 取 ./<dir>/，既有条目不变', () => {
    const config = readPluginConfig(REPO);
    const extended = { ...config.marketplace, plugins: [...config.marketplace.plugins, EXTRA] };
    const mkp = JSON.parse(renderMarketplace(extended));
    // 现有条目原样保留
    expect(mkp.plugins.slice(0, -1)).toEqual(
      config.marketplace.plugins.map((p) => ({
        name: p.name,
        description: p.description,
        version: p.version,
        source: `./${p.dir}/`,
      })),
    );
    // 追加条目正确生成
    expect(mkp.plugins).toHaveLength(config.marketplace.plugins.length + 1);
    expect(mkp.plugins.at(-1)).toEqual({
      name: EXTRA.name,
      description: EXTRA.description,
      version: EXTRA.version,
      source: './demo-plugin/',
    });
    // marketplace 外层字段保持稳定
    expect(mkp).toMatchObject({
      name: config.marketplace.name,
      description: config.marketplace.description,
      owner: config.marketplace.owner,
    });
  });
});


describe('T1-081 resolvePluginAssets — 任意插件可声明自身 mcp/hooks（engineDir-only 取消）', () => {
  const config = readPluginConfig(REPO);
  const H = { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }] };
  const M = { mine: { args: ['./mcp/x.js'] } };

  it('引擎插件未声明 → 回落顶层 config.mcpServers/hooks', () => {
    const r = resolvePluginAssets({ dir: config.engineDir }, config);
    expect(r.mcpServers).toEqual(config.mcpServers);
    expect(r.hooks).toEqual(config.hooks);
  });

  it('非引擎插件未声明 → null（引擎运行时资产不外泄）', () => {
    expect(resolvePluginAssets({ dir: 'decision' }, config)).toEqual({ mcpServers: null, hooks: null });
  });

  it('任意插件声明自身 hooks/mcp → 用自身声明', () => {
    const r = resolvePluginAssets({ dir: 'demo-plugin', mcpServers: M, hooks: H }, config);
    expect(r.mcpServers).toEqual(M);
    expect(r.hooks).toEqual(H);
  });
});


describe('T1-082 renderRepoSettings — 本仓 .claude/settings.json 由 plugin/settings.json 渲染', () => {
  it('基础设置自动追加全部 marketplace 插件', () => {
    const config = readPluginConfig(REPO);
    const base = {
      plugins: ['figma@claude-plugins-official'],
      enabledPlugins: { 'figma@claude-plugins-official': true },
    };
    const out = JSON.parse(renderPluginSettings(base, config.marketplace));
    const expected = config.marketplace.plugins.map((p) => `${p.name}@${config.marketplace.name}`);
    expect(out.plugins).toEqual(['figma@claude-plugins-official', ...expected]);
    expect(expected.every((spec) => out.enabledPlugins[spec] === true)).toBe(true);
  });

  it('<pkg> 解析为绝对 plugin 根；第三方（figma 等）手工层原样保留', () => {
    const src = {
      plugins: ['figma@claude-plugins-official', 'ai-workflow-core@ai-workflow-dev'],
      enabledPlugins: { 'figma@claude-plugins-official': true, 'ai-workflow-core@ai-workflow-dev': true },
      extraKnownMarketplaces: { 'ai-workflow-dev': { source: { source: 'directory', path: '<pkg>/plugin' } } },
    };
    const out = JSON.parse(renderRepoSettings(src, PLUGIN));
    expect(out.extraKnownMarketplaces['ai-workflow-dev'].source.path).toBe(PLUGIN);
    expect(out.plugins[0]).toBe('figma@claude-plugins-official'); // 第三方层保留
  });
});
