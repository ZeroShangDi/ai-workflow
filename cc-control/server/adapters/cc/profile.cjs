'use strict';
/**
 * profile.cjs — cc **项目配置**注入（`.claude/settings.json` 与项目 `.mcp.json`）
 *
 * 职责：把随包声明的两份清单落进目标项目 ——
 *   - `plugin/settings.json`（插件安装清单）→ 项目 `.claude/settings.json`
 *   - `plugin/config.json` 的 `mcpServers` → 项目 `.mcp.json`（**绝对路径**：enabled-only 的
 *     插件注册下插件自带 .mcp.json 不暴露工具，项目级这份是 awf run 会话里 MCP 可用的必要条件）
 *
 * ## 为什么在 adapters
 * 这两份产物都是 **cc 的形状**：settings 的 schema、数组去重追加 / 对象递归合并、注销时按注入
 * 模板的键精确清理 —— 没有一行是业务逻辑，形状全由 cc 决定。与同目录的 `shapes.cjs`（回写形状）、
 * `extract.cjs`（输出解析）、`settings.cjs`（run settings 构造）同类：**不是端口**（无会话/进程，
 * 不构成可替换的能力面），但同样经 `ports.cjs` 这一道门出。
 *
 * ## 边界
 * 只管「按 cc 的格式写这两份文件」，不决定装哪些插件（那是 plugin/config.json 的事），
 * 不调用 cc 命令（`claude plugin install` 走 tooling 端口）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { pkgRoot: defaultPkgRoot } = require('../../shared/plugin-assets.cjs');
const { readPluginConfig, renderMcpServers } = require('../../shared/plugin-render.cjs');

/** 判纯对象（非数组、非 null） */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 递归把模板里的 `<pkg>` 占位符替换成包根（模板与安装位置无关，落盘时才解析） */
function resolvePkg(value, pkgRoot) {
  if (typeof value === 'string') return value.replace(/<pkg>/g, pkgRoot);
  if (Array.isArray(value)) return value.map((v) => resolvePkg(v, pkgRoot));
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolvePkg(v, pkgRoot);
    return out;
  }
  return value;
}

/** 合并：数组去重追加、对象递归合并、标量覆盖 —— 项目的其它配置一律保留 */
function mergeSettings(base, incoming) {
  const result = { ...base };
  for (const [key, val] of Object.entries(incoming)) {
    if (!(key in result)) result[key] = val;
    else if (Array.isArray(val) && Array.isArray(result[key])) {
      const seen = new Set(result[key]);
      for (const item of val) { if (!seen.has(item)) { result[key].push(item); seen.add(item); } }
    } else if (isPlainObject(val) && isPlainObject(result[key])) result[key] = mergeSettings(result[key], val);
    else result[key] = val;
  }
  return result;
}

/** 读注入模板 `plugin/settings.json`；缺失/非法 → null */
function readTemplate(pkgRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgRoot, 'server', 'adapters', 'cc', 'plugin', 'settings.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 读改写的 JSON 文件；缺失/非法 → {} */
function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * 本地注册：把 `plugin/settings.json` 增量合并进项目 `.claude/settings.json`。
 * 幂等：数组去重追加、对象递归合并，重复执行不产生重复项。
 * @param {string} projectRoot 目标项目根
 * @param {{ pkgRoot?: string }} [opts] pkgRoot 缺省按本包位置推导
 * @returns {{ written: boolean, path: string|null, error?: string }}
 */
function installProfile(projectRoot, { pkgRoot = defaultPkgRoot() } = {}) {
  const template = readTemplate(pkgRoot);
  if (!template) return { written: false, path: null, error: `plugin/settings.json 缺失（${pkgRoot}）` };
  const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
  writeJson(settingsPath, mergeSettings(readJson(settingsPath), resolvePkg(template, pkgRoot)));
  return { written: true, path: settingsPath };
}

/**
 * 本地注销：按注入模板的**键**精确清理（只删注入过的东西，不动项目自己的配置）。
 * 数组按值移除、对象按模板键删除、标量按值相等删除；清空后的空容器一并摘掉。
 * @returns {{ written: boolean, path: string|null }}
 */
function uninstallProfile(projectRoot, { pkgRoot = defaultPkgRoot() } = {}) {
  const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) return { written: false, path: null };

  const existing = readJson(settingsPath);
  const template = readTemplate(pkgRoot);
  if (!template) return { written: false, path: settingsPath };

  let changed = false;
  for (const [key, injected] of Object.entries(template)) {
    if (!(key in existing)) continue;
    const current = existing[key];
    if (Array.isArray(current)) {
      const remove = new Set(Array.isArray(injected) ? injected : []);
      const kept = current.filter((item) => !remove.has(item));
      if (kept.length !== current.length) { existing[key] = kept; changed = true; }
      if (existing[key].length === 0) delete existing[key];
    } else if (isPlainObject(current)) {
      for (const k of Object.keys(isPlainObject(injected) ? injected : {})) {
        if (k in current) { delete current[k]; changed = true; }
      }
      if (Object.keys(existing[key]).length === 0) delete existing[key];
    } else if (typeof injected === typeof current && current === injected) {
      delete existing[key];
      changed = true;
    }
  }
  if (!changed) return { written: false, path: settingsPath };
  writeJson(settingsPath, existing);
  return { written: true, path: settingsPath };
}

/**
 * 项目级 MCP 注册：把 `plugin/config.json` 声明的 mcpServers 以**绝对路径**合并进项目 `.mcp.json`。
 * 只覆盖 awf-* 条目（保证路径当前），项目里其它 server 保留。
 *
 * 形状单源：args/env 的渲染归 `shared/plugin-render.cjs` 的 renderMcpServers（absolute 形态）；
 * 本函数只额外钉住「每条 server 都知道自己在哪个项目」—— 那是单 server 多项目 `?p` 路由的依据。
 * @returns {{ written: boolean, path: string|null, servers: string[], error?: string }}
 */
function installProjectMcp(projectRoot, port) {
  let cfg;
  try {
    cfg = readPluginConfig();
  } catch {
    return { written: false, path: null, servers: [], error: 'plugin/config.json 缺失，跳过项目 MCP 注册' };
  }
  const rendered = renderMcpServers(cfg.mcpServers || {}, { absolute: true, port });
  const servers = {};
  for (const [name, srv] of Object.entries(rendered)) {
    servers[name] = { ...srv, env: { ...(srv.env || {}), AWF_PROJECT_ROOT: projectRoot } };
  }
  const mcpPath = path.join(projectRoot, '.mcp.json');
  const existing = readJson(mcpPath);
  existing.mcpServers = { ...(existing.mcpServers || {}), ...servers };
  writeJson(mcpPath, existing);
  return { written: true, path: mcpPath, servers: Object.keys(servers) };
}

/**
 * 读注入模板声明的插件清单（`plugin/settings.json` 的 `plugins` 字段）。
 * 全局安装（`claude plugin install`）照着它逐个装 —— 清单是插件的自述，不在这里重列。
 * @returns {string[]} 形如 `name@marketplace`；模板缺失 → []
 */
function listDeclaredPlugins({ pkgRoot = defaultPkgRoot() } = {}) {
  const template = readTemplate(pkgRoot);
  return Array.isArray(template?.plugins) ? template.plugins : [];
}

module.exports = { installProfile, uninstallProfile, installProjectMcp, listDeclaredPlugins, resolvePkg, mergeSettings };
