'use strict';
/**
 * plugin-render.cjs — 由 `plugin/config.json` 渲染插件注册文件（渲染面）
 *
 * 与同目录 `plugin-assets.cjs` 的分工：那个管**定位/读**（插件名 → 目录 → 资产路径），
 * 这个管**渲染/产出**（配置 → marketplace.json / plugin.json / .mcp.json / hooks.json / 仓库 settings）。
 * 两者都对同一个形状（`plugin/config.json`）知情，但操作不同：一个是「东西在哪」，一个是「东西长什么样」。
 *
 * 迁移说明：本模块从旧树 `src/lib/plugin-config.js` 整体迁入（ESM → CJS）。旧树退役前它是
 * `scripts/render-config.mjs` 的 `import` 来源，而该脚本是 `npm run build` / `prepack` 的必经环节 ——
 * **唯一会直接打断构建的旧树独有能力**。见 `docs/discuss/legacy-tree-retirement.md` §3.1。
 *
 * 与 `server/adapters/cc/profile.cjs` 的关系：那份的 `installProjectMcp` 也用本模块的
 * `renderMcpServers`（absolute 形态）—— 此前是手抄一遍同一形状，两处各写一份。
 *
 * 边界：只做「读配置 + 渲染字符串」，不写文件（落盘由调用方 `scripts/render-config.mjs` 决定）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, ConfigError } = require('./config-loader.cjs');
const { pkgRoot } = require('./plugin-assets.cjs');

/** 插件 MCP args 前缀：Claude Code 注入插件根（仅 installed 插件生效） */
const PLUGIN_ROOT = '${CLAUDE_PLUGIN_ROOT}';

/** plugin.json 的作者 / 许可（写入每个插件的 plugin.json） */
const AUTHOR = { name: 'v-shangjunhao' };
const LICENSE = 'MIT';

/** config.json 未声明 engineDir / port 时的兜底（loader 默认） */
const DEFAULT_ENGINE_DIR = 'core';
const DEFAULT_PORT = 8787;

/**
 * plugin/config.json 的字段规则（经 config-loader 校验，passthrough 保留整份文件）。
 * port/engineDir 给默认值；marketplace/mcpServers/hooks 只做类型校验，子结构保留原样。
 */
const PLUGIN_CONFIG_RULES = {
  port: { default: DEFAULT_PORT, type: 'integer', min: 1, max: 65535 },
  engineDir: { default: DEFAULT_ENGINE_DIR, type: 'string', pattern: /^.+$/ },
  marketplace: { type: 'object' },
  mcpServers: { type: 'object' },
  hooks: { type: 'object' },
};

/**
 * 从中性源 `plugin/<dir>/plugin.json` 发现插件。
 * 目录名决定 dir；manifest 只保存该插件自己的元数据，order 仅控制市场顺序。
 */
function discoverPluginEntries(repoRoot = pkgRoot()) {
  const source = path.join(repoRoot, 'plugin');
  const entries = [];
  const scan = (root, label) => {
    if (!fs.existsSync(root)) return;
    for (const item of fs.readdirSync(root, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const manifest = path.join(root, item.name, 'plugin.json');
      if (!fs.existsSync(manifest)) continue;
      let data;
      try {
        data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      } catch (err) {
        throw new ConfigError(`插件元数据无法解析：${label}/${item.name}/plugin.json（${err.message}）`);
      }
      entries.push({ ...data, dir: item.name });
    }
  };
  scan(source, 'plugin');
  // npm 包不携带中性源；运行时回读 prepack 已生成的 CC manifest。
  if (entries.length === 0) scan(path.join(repoRoot, 'server', 'adapters', 'cc', 'plugin'), 'server/adapters/cc/plugin');
  return entries.sort((a, b) => (Number(a.order ?? 1000) - Number(b.order ?? 1000)) || a.dir.localeCompare(b.dir));
}

/** marketplace.plugins 最小结构校验：数组 + 每项 dir/name 非空字符串 + dir/name 不重复 */
function assertMarketplaceShape(marketplace) {
  if (!marketplace || !Array.isArray(marketplace.plugins)) {
    throw new ConfigError('插件目录发现失败：没有生成 marketplace.plugins');
  }
  const errors = [];
  const dirs = [];
  const names = [];
  marketplace.plugins.forEach((p, i) => {
    if (!p || typeof p !== 'object') {
      errors.push(`marketplace.plugins[${i}] 应为对象`);
      return;
    }
    for (const field of ['dir', 'name']) {
      if (typeof p[field] !== 'string' || !p[field]) errors.push(`marketplace.plugins[${i}].${field} 应为非空字符串`);
    }
    if (typeof p.dir === 'string' && p.dir) dirs.push(p.dir);
    if (typeof p.name === 'string' && p.name) names.push(p.name);
  });
  for (const dup of new Set(dirs.filter((d, i) => dirs.indexOf(d) !== i))) {
    errors.push(`marketplace.plugins.dir 重复：${dup}`);
  }
  for (const dup of new Set(names.filter((name, i) => names.indexOf(name) !== i))) {
    errors.push(`marketplace.plugins.name 重复：${dup}`);
  }
  if (errors.length > 0) throw new ConfigError(`plugin/config.json 结构校验失败：\n  ${errors.join('\n  ')}`, errors);
}

/**
 * 读取运行时配置，并把 `plugin/<dir>/plugin.json` 自动发现结果注入 marketplace.plugins。
 * @param {string} [repoRoot] cc-control 包根；缺省由模块位置推导（plugin-assets.pkgRoot）
 */
function readPluginConfig(repoRoot = pkgRoot()) {
  const config = loadConfig({
    rules: PLUGIN_CONFIG_RULES,
    source: { filePath: path.join(repoRoot, 'server', 'adapters', 'cc', 'plugin', 'config.json') },
    passthrough: true,
  });
  const marketplace = { ...config.marketplace, plugins: discoverPluginEntries(repoRoot) };
  assertMarketplaceShape(marketplace);
  return { ...config, marketplace };
}

/**
 * 引擎插件根目录 = plugin/<engineDir>。
 * 引擎插件承载引擎运行时：mcpServers 的 server 源码（plugin/<engineDir>/mcp/）
 * 与 hooks 生成物（plugin/<engineDir>/hooks/hooks.json、plugin/<engineDir>/.mcp.json）。
 * @param {string} [repoRoot] cc-control 包根
 */
function enginePluginRoot(repoRoot = pkgRoot()) {
  const config = readPluginConfig(repoRoot);
  return path.join(repoRoot, 'server', 'adapters', 'cc', 'plugin', config.engineDir || DEFAULT_ENGINE_DIR);
}

/**
 * T1-081：插件 mcp/hooks 资产解析——任意插件可声明自身 mcpServers/hooks（engineDir-only 取消）。
 * 引擎插件（dir===engineDir）在自身无声明时回落顶层 config.mcpServers/hooks（向后兼容）；
 * 其余插件仅用自身声明（无 → null，不渲染引擎运行时资产）。
 * @param {{dir: string, mcpServers?: object, hooks?: object}} plugin
 * @param {{mcpServers?: object, hooks?: object, engineDir?: string}} config
 */
function resolvePluginAssets(plugin, { mcpServers = null, hooks = null, engineDir } = {}) {
  const isEngine = plugin.dir === (engineDir || 'core');
  return {
    mcpServers: plugin.mcpServers || (isEngine ? mcpServers : null),
    hooks: plugin.hooks || (isEngine ? hooks : null),
  };
}

/**
 * T1-082：本仓 .claude/settings.json 渲染产物——由 plugin/settings.json（安装清单，含第三方
 * 手工合并层如 figma）渲染，仅解析 source.path 的 <pkg> 占位为绝对 plugin 根。
 * @param {object} pluginSettings - plugin/settings.json 内容（plugins/enabledPlugins/extraKnownMarketplaces）
 * @param {string} pluginRoot - 本仓 plugin 目录绝对路径（cc-control/plugin）
 */
function renderRepoSettings(pluginSettings, pluginRoot) {
  const s = JSON.parse(JSON.stringify(pluginSettings || {}));
  const repoRoot = path.resolve(pluginRoot, '..');
  for (const m of Object.values(s.extraKnownMarketplaces || {})) {
    if (m?.source?.path && typeof m.source.path === 'string') {
      m.source.path = m.source.path.replaceAll('<pkg>', repoRoot);
    }
  }
  return JSON.stringify(s, null, 2) + '\n';
}

/** 从第三方基础设置 + 自动发现的插件生成安装清单。 */
function renderPluginSettings(baseSettings, marketplace) {
  const s = JSON.parse(JSON.stringify(baseSettings || {}));
  s.plugins = Array.isArray(s.plugins) ? s.plugins : [];
  s.enabledPlugins = s.enabledPlugins && typeof s.enabledPlugins === 'object' ? s.enabledPlugins : {};
  const marketplaceName = marketplace?.name;
  for (const plugin of marketplace?.plugins || []) {
    const spec = `${plugin.name}@${marketplaceName}`;
    if (!s.plugins.includes(spec)) s.plugins.push(spec);
    s.enabledPlugins[spec] = true;
  }
  return JSON.stringify(s, null, 2) + '\n';
}

/**
 * 渲染 mcpServers（args 相对引擎插件根 plugin/<engineDir> 解析）。
 *   absolute=true  → args 解析为绝对路径（供跨项目注入的项目级 .mcp.json）
 *   relativeTo=<dir> → args 解析为相对 <dir> 的路径（供自托管项目级 .mcp.json，与仓库提交版一致）
 *   两者都未设 → args 前缀 ${CLAUDE_PLUGIN_ROOT}（插件态，供引擎插件 .mcp.json）
 *   env 占位符：{PORT} → 端口字面量
 * @param {object} mcpServers
 * @param {{repoRoot?: string, absolute?: boolean, relativeTo?: string, port?: number}} opts
 */
function renderMcpServers(mcpServers, { repoRoot = pkgRoot(), absolute = false, relativeTo, port } = {}) {
  const engineRoot = enginePluginRoot(repoRoot);
  const out = {};
  for (const [name, srv] of Object.entries(mcpServers)) {
    const env = {};
    for (const [k, v] of Object.entries(srv.env || {})) {
      env[k] = String(v).replaceAll('{PORT}', String(port));
    }
    out[name] = {
      type: srv.type || 'stdio',
      command: srv.command || 'node',
      args: srv.args.map((a) => {
        if (absolute) return path.resolve(engineRoot, a);
        if (relativeTo) return path.relative(relativeTo, path.resolve(engineRoot, a));
        return `${PLUGIN_ROOT}/${a.replace(/^\.\//, '')}`;
      }),
      ...(Object.keys(env).length ? { env } : {}),
    };
  }
  return out;
}

/**
 * 渲染单个插件的 plugin.json（plugin/<dir>/plugin.json 内容）。
 *   withHooks=true（引擎插件）→ 追加 hooks 字段，指向该插件内的 hooks.json
 * 依 marketplace.plugins 条目生成，接受任意 dir。
 * @param {{name: string, description: string, version: string, keywords?: string[]}} entry
 * @param {{withHooks?: boolean}} [opts]
 */
function renderPluginJson(entry, { withHooks = false } = {}) {
  const obj = {
    name: entry.name,
    description: entry.description,
    version: entry.version,
    author: AUTHOR,
    license: LICENSE,
    keywords: entry.keywords || [],
  };
  if (withHooks) obj.hooks = './hooks/hooks.json';
  return JSON.stringify(obj, null, 2) + '\n';
}

/** 渲染 marketplace.json（source 取 ./<dir>/，依 marketplace.plugins 遍历） */
function renderMarketplace(marketplace) {
  const plugins = marketplace.plugins.map((p) => ({
    name: p.name,
    description: p.description,
    version: p.version,
    source: `./${p.dir}/`,
  }));
  return JSON.stringify({ name: marketplace.name, description: marketplace.description, owner: marketplace.owner, plugins }, null, 2) + '\n';
}

/**
 * 项目级 .mcp.json 内容 — awf init/run 写入目标项目，
 * 使 MCP 工具在 enabled-only 插件注册下也能加载（插件 .mcp.json 此时只连通不暴露工具）。
 * 路径形态按场景：
 *   projectRoot == repoRoot（自托管）→ 相对 `plugin/<engineDir>/...`，与仓库提交版一致、可移植、git 干净
 *   projectRoot != repoRoot（跨项目注入）→ 绝对路径（server 在 cc-control 包内，逃逸相对路径不可靠）
 * @param {string} [repoRoot] cc-control 包根
 * @param {number} [port] 端口覆盖；缺省用 config.json 的 port
 * @param {string} [projectRoot] 目标项目根（.mcp.json 所在处）；缺省用 repoRoot
 */
function projectMcpJson(repoRoot = pkgRoot(), port, projectRoot) {
  const config = readPluginConfig(repoRoot);
  const effectivePort = Number.isFinite(port) ? port : config.port;
  const target = projectRoot || repoRoot;
  const selfHosted = path.resolve(target) === path.resolve(repoRoot);
  const opts = selfHosted
    ? { repoRoot, relativeTo: target, port: effectivePort }
    : { repoRoot, absolute: true, port: effectivePort };
  return { mcpServers: renderMcpServers(config.mcpServers, opts) };
}

module.exports = {
  discoverPluginEntries,
  readPluginConfig,
  enginePluginRoot,
  resolvePluginAssets,
  renderRepoSettings,
  renderPluginSettings,
  renderMcpServers,
  renderPluginJson,
  renderMarketplace,
  projectMcpJson,
  PLUGIN_CONFIG_RULES,
  AUTHOR,
  LICENSE,
  DEFAULT_ENGINE_DIR,
  DEFAULT_PORT,
};
