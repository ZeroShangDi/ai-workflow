import { exec, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getPaths } from '../lib/paths.js';
import { logger, logStep } from '../lib/ui/log.js';
import { createSpinner } from '../lib/ui/spinner.js';
import { installProfile, uninstallProfile, installProjectMcp } from '../lib/profile.js';

/**
 * awf plugin — 独立插件管理
 *
 * 两种注册实现：
 *   - 本地注册（默认 scope=local）：注入 plugin/settings.json 到项目 .claude/settings.json
 *   - 全局注册（scope=global）：读取 settings.json 的 plugins 字段 → claude plugin install
 * pluginCommand 仅负责按 scope 分发，具体实现见下方 localPlugin / globalPlugin。
 */
export async function pluginCommand(action, options = {}) {
  const { scope = 'local' } = options;
  return scope === 'global' ? globalPlugin(action) : localPlugin(action);
}

// ── 本地注册（默认）──

async function localPlugin(action) {
  const cwd = process.cwd();
  const { projectRoot } = getPaths();

  switch (action) {
    case 'install': {
      const r = installProfile(cwd, projectRoot);
      if (r.written) logger.success(`已本地注册 plugin → ${r.path}`);
      else logger.warn(r.error || '本地注册失败');
      const m = installProjectMcp(cwd, projectRoot);
      if (m.written) logger.success(`已写入项目 MCP 注册 → ${m.path}`);
      else logger.warn(m.error || '项目 MCP 注册失败');
      break;
    }

    case 'uninstall': {
      const r = uninstallProfile(cwd, projectRoot);
      if (r.written) logger.success(`已移除本地 plugin 注册 → ${r.path}`);
      else logger.info('本地 plugin 注册不存在');
      break;
    }

    default:
      logger.error(`未知操作: ${action}，可用: install | uninstall`);
      process.exit(1);
  }
}

// ── 全局注册（--scope global，claude plugin install 方案）──

async function globalPlugin(action) {
  const paths = getPaths();

  switch (action) {
    case 'install': {
      const plugins = await loadPluginsFromProfile(paths);
      await installAllPlugins(paths, plugins);
      break;
    }

    case 'uninstall': {
      await uninstallAllPlugins(paths);
      break;
    }

    default:
      logger.error(`未知操作: ${action}，可用: install | uninstall`);
      process.exit(1);
  }
}

// ── 全局安装 helpers（原 init.js，验证过的 claude plugin install 方案）──

/** child_process.exec 的 Promise 包装 */
function execAsync(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, opts, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

/** 读取 plugin/settings.json 的 plugins 字段，返回需全局安装的插件列表 */
async function loadPluginsFromProfile(paths) {
  const configPath = path.join(paths.projectRoot, 'plugin', 'settings.json');
  try { const config = JSON.parse(await fs.readFile(configPath, 'utf-8')); return config.plugins || []; }
  catch { return []; }
}

/** 安装 settings.json.plugins 声明的插件到 CC 用户级插件目录（claude plugin install） */
async function installAllPlugins(paths, plugins) {
  const marketplaceDir = path.join(paths.projectRoot, 'plugin'); // marketplace 根 = plugin/
  const installedJson = path.join(paths.claudePlugins, 'installed_plugins.json');
  const symlinkPath = path.join(paths.claudePlugins, 'ai-workflow');

  // 清理早期符号链接安装方式遗留
  try { const target = await fs.readlink(symlinkPath); if (target) await fs.unlink(symlinkPath).catch(() => {}); } catch {}

  // 只有用户级安装才算已全局安装（项目级安装不能替代，否则全局安装后仍需 settings.json）
  const isInstalled = (spec) => {
    try {
      const raw = execSync(`cat "${installedJson}"`, { stdio: 'pipe' }).toString();
      const entries = JSON.parse(raw).plugins?.[spec] || [];
      return entries.some((e) => e.scope === 'user');
    }
    catch { return false; }
  };

  // 注册 marketplace（指向 plugin/，幂等）
  try { execSync(`claude plugin marketplace add "${marketplaceDir}"`, { stdio: 'pipe' }); } catch {}

  for (const spec of plugins) {
    const label = spec.split('@')[0];
    if (isInstalled(spec)) { logStep(label, 'skip', '已安装'); continue; }
    const spin = createSpinner(`installing ${spec} ...`);
    try { await execAsync(`claude plugin install ${spec}`); spin.stop(); logStep(label, 'ok', '已安装'); }
    catch (err) { spin.stop(); logStep(label, 'error', `安装失败 — ${err.message}`); }
  }
}

/** 卸载 settings.json.plugins 声明的插件（claude plugin uninstall） */
async function uninstallAllPlugins(paths) {
  const plugins = await loadPluginsFromProfile(paths);
  for (const spec of plugins) {
    const label = spec.split('@')[0];
    try { await execAsync(`claude plugin uninstall ${spec}`); logStep(label, 'ok', '已卸载'); }
    catch (err) { logStep(label, 'error', `卸载失败 — ${err.message}`); }
  }
}
