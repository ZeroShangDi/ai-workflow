import path from 'path';
import fs from 'fs/promises';
import { getPaths } from '../lib/paths.js';
import { logger } from '../lib/ui/log.js';

/**
 * awf plugin — 独立插件管理
 * install: 符号链接到 ~/.claude/plugins/
 * uninstall: 移除符号链接
 */
export async function pluginCommand(action) {
  const paths = getPaths();
  const pluginDir = `${paths.claudePlugins}/ai-workflow`;

  switch (action) {
    case 'install': {
      await fs.mkdir(paths.claudePlugins, { recursive: true });

      const exists = await fs.stat(pluginDir).catch(() => null);
      if (exists) {
        logger.info('插件已安装，跳过');
        return;
      }

      const sourceDir = path.join(paths.projectRoot, 'plugin');
      await fs.symlink(sourceDir, pluginDir);
      logger.success(`已安装: ${pluginDir} → ${sourceDir}`);
      break;
    }

    case 'uninstall': {
      const exists = await fs.lstat(pluginDir).catch(() => null);
      if (!exists) {
        logger.info('插件未安装');
        return;
      }

      if (exists.isSymbolicLink()) {
        await fs.unlink(pluginDir);
      } else {
        await fs.rm(pluginDir, { recursive: true });
      }
      logger.success('已卸载');
      break;
    }

    default:
      logger.error(`未知操作: ${action}，可用: install | uninstall`);
      process.exit(1);
  }
}
