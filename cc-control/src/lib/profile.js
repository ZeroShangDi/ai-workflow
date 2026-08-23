import fs from 'fs';
import path from 'path';
import { projectMcpJson } from './plugin-config.js';

/**
 * Profile 本地注册实现（取代全局 claude plugin install / 符号链接）
 *
 * 将 plugin/settings.json（安装清单）注入项目 .claude/settings.json，
 * 使插件仅对当前项目生效。供 init / awf plugin 复用。
 */

/**
 * 本地注册：把 plugin/settings.json 增量合并进项目 settings.json
 * @param {string} projectRoot - 目标项目根目录（.claude/settings.json 所在处）
 * @param {string} pkgRoot - cc-control 包根目录（plugin/ 所在处）
 * @returns {{written: boolean, path: string|null, error?: string}}
 */
export function installProfile(projectRoot, pkgRoot) {
  const templatePath = path.join(pkgRoot, 'plugin', 'settings.json');
  if (!fs.existsSync(templatePath)) {
    return { written: false, path: null, error: `settings.json not found in ${pkgRoot}/plugin` };
  }

  const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  const resolved = resolvePkg(template, pkgRoot);

  const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let existing = {};
  if (fs.existsSync(settingsPath)) {
    existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  }

  const merged = mergeSettings(existing, resolved);
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n');
  return { written: true, path: settingsPath };
}

/**
 * 本地注销：从项目 settings.json 移除 profile 注入的键值
 * 按注入模板的键动态清理：数组（值/路径匹配）、对象（按模板 key 删除）、标量（值匹配）
 * @param {string} projectRoot - 目标项目根目录
 * @param {string} pkgRoot - cc-control 包根目录（读取注入模板）
 * @returns {{written: boolean, path: string|null}}
 */
export function uninstallProfile(projectRoot, pkgRoot) {
  const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    return { written: false, path: null };
  }

  const existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const template = readTemplate(pkgRoot);
  const injectKeys = new Set(template ? Object.keys(template) : []);
  let changed = false;

  for (const key of injectKeys) {
    if (!(key in existing)) continue;
    const injected = template?.[key];

    if (Array.isArray(existing[key])) {
      const remove = new Set(Array.isArray(injected) ? injected : []);
      const kept = existing[key].filter((item) => !remove.has(item));
      if (kept.length !== existing[key].length) { existing[key] = kept; changed = true; }
      if (existing[key].length === 0) delete existing[key];
    } else if (isPlainObject(existing[key])) {
      const removeKeys = Object.keys(isPlainObject(injected) ? injected : {});
      for (const k of removeKeys) {
        if (k in existing[key]) { delete existing[key][k]; changed = true; }
      }
      if (Object.keys(existing[key]).length === 0) delete existing[key];
    } else if (typeof injected === typeof existing[key] && existing[key] === injected) {
      delete existing[key];
      changed = true;
    }
  }

  if (!changed) return { written: false, path: settingsPath };

  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + '\n');
  return { written: true, path: settingsPath };
}

/** 读取注入模板 settings.json，缺失/非法时返回 null */
function readTemplate(pkgRoot) {
  const templatePath = path.join(pkgRoot, 'plugin', 'settings.json');
  try { return JSON.parse(fs.readFileSync(templatePath, 'utf8')); }
  catch { return null; }
}

/**
 * 项目级 MCP 注册：把插件声明的 3 个 awf-* server（绝对路径）合并进项目 .mcp.json。
 *
 * 背景：本地注册（enabled-only 插件）下，插件 .mcp.json 只连通不暴露工具，
 * 项目级 .mcp.json 是 MCP 工具在 awf run 会话中可用的必要条件。
 * 幂等：只覆盖 awf-* 同名 server（保证路径当前），保留用户已有 server。
 * @param {string} projectRoot - 目标项目根目录（.mcp.json 所在处）
 * @param {string} repoRoot - cc-control 根目录（读 plugin/config.json）
 * @param {number} [port] - 端口覆盖，缺省用 config.json 的 port
 * @returns {{written: boolean, path: string|null, servers: string[]}}
 */
export function installProjectMcp(projectRoot, repoRoot, port) {
  let mcpServers;
  try {
    ({ mcpServers } = projectMcpJson(repoRoot, port));
  } catch (err) {
    if (err.code === 'ENOENT') return { written: false, path: null, servers: [], error: 'plugin/config.json 缺失，跳过项目 MCP 注册' };
    throw err;
  }
  const mcpPath = path.join(projectRoot, '.mcp.json');

  let existing = {};
  if (fs.existsSync(mcpPath)) {
    try { existing = JSON.parse(fs.readFileSync(mcpPath, 'utf8')); }
    catch { /* 非法 JSON → 从 awf 声明重建 */ }
  }

  existing.mcpServers = existing.mcpServers || {};
  for (const [name, srv] of Object.entries(mcpServers)) existing.mcpServers[name] = srv;

  fs.writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + '\n');
  return { written: true, path: mcpPath, servers: Object.keys(mcpServers) };
}

// ── helpers（从 plan.js 迁移）──

/** 深合并 settings.json，数组去重追加，对象递归合并 */
function mergeSettings(base, incoming) {
  const result = { ...base };
  for (const [key, val] of Object.entries(incoming)) {
    if (!(key in result)) {
      result[key] = val;
    } else if (Array.isArray(val) && Array.isArray(result[key])) {
      const existing = new Set(result[key]);
      for (const item of val) { if (!existing.has(item)) { result[key].push(item); existing.add(item); } }
    } else if (isPlainObject(val) && isPlainObject(result[key])) {
      result[key] = mergeSettings(result[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/** 递归替换字符串和对象中的 <pkg> 占位符为 package 根路径 */
function resolvePkg(obj, pkgRoot) {
  if (typeof obj === 'string') return obj.replace(/<pkg>/g, pkgRoot);
  if (Array.isArray(obj)) return obj.map((v) => resolvePkg(v, pkgRoot));
  if (isPlainObject(obj)) {
    const result = {};
    for (const [k, v] of Object.entries(obj)) result[k] = resolvePkg(v, pkgRoot);
    return result;
  }
  return obj;
}

/** 判断值是否为纯对象（非数组、非 null） */
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
