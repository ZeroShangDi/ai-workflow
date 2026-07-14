import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { getPaths } from '../utils/paths.js';

/**
 * awf init — 初始化项目工作流环境
 * 1. 在用户项目下创建 .awf/ 目录及初始配置
 * 2. 安装 cc-plugins 到 Claude Code
 * 3. 输出引导信息
 */
export async function initCommand(options) {
  const { force } = options;
  const paths = getPaths();

  logger.info('初始化 AI Workflow 环境...\n');

  // 1. 创建 .awf/
  const awfDir = path.join(process.cwd(), '.awf');
  const exists = await fs.stat(awfDir).catch(() => null);

  if (exists && !force) {
    logger.warn('.awf/ 已存在，使用 --force 覆盖');
  } else {
    if (exists) {
      logger.info('覆盖已有 .awf/ ...');
    }

    await fs.mkdir(awfDir, { recursive: true });

    // state.json
    const stateJson = {
      currentState: 'IDLE',
      version: '0.1.0',
      milestones: [],
      tasks: [],
      wbs: null,
      lastUpdated: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(awfDir, 'state.json'),
      JSON.stringify(stateJson, null, 2),
    );

    logger.success('.awf/ 已创建');
  }

  // 2. 安装插件
  logger.info('安装 cc-plugins ...');
  await installPlugin(paths);
  logger.success('插件已安装');

  // 3. 引导
  logger.info('');
  logger.info('━━━ 初始化完成 ━━━');
  logger.info('');
  logger.info('  下一步:');
  logger.info('    awf plan "你的需求描述"    开始规划');
  logger.info('    awf run                     启动工作流');
  logger.info('');
}

async function installPlugin(paths) {
  const pluginDir = `${paths.claudePlugins}/ai-workflow`;
  const sourceDir = paths.ccPlugins;

  // 确保 ~/.claude/plugins/ 存在
  await fs.mkdir(paths.claudePlugins, { recursive: true });

  // 如果已存在则跳过
  const linkExists = await fs.stat(pluginDir).catch(() => null);
  if (linkExists) {
    logger.info('  插件 symlink 已存在，跳过');
    return;
  }

  // 创建 symlink
  await fs.symlink(sourceDir, pluginDir);
  logger.info(`  ${pluginDir} → ${sourceDir}`);
}
