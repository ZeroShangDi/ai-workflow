import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 解析所有关键路径
 * 当前文件位于 cc-control/src/cli/utils/，以此为基准解析
 *
 * cc-control/（projectRoot）
 *   bin/awf.js              ← CLI 入口
 *   src/server/server.js     ← HTTP Session server
 *   scripts/bootstrap.sh     ← tmux session 启动脚本
 *   prompts/run/             ← 阶段提示词模板
 *   commands/                ← slash commands（Claude Code 自动发现）
 *   skills/                  ← skills（Claude Code 自动发现）
 */
/**
 * 插件命名空间前缀
 * 所有 spawn claude 时引用的 slash command 必须带此前缀
 * 值与 plugin.json 中的 name 字段保持一致
 */
export const PLUGIN_NS = 'ai-workflow';

/**
 * 生成带命名空间的命令引用
 * @param {string} cmd - 短命令名，如 'w-plan'
 * @returns {string} 全限定命令，如 '/ai-workflow:w-plan'
 */
export function pluginCmd(cmd) {
  return `/${PLUGIN_NS}:${cmd}`;
}

export function getPaths() {
  // __dirname = cc-control/src/cli/utils/
  // 上溯 3 级 → cc-control/
  const projectRoot = path.resolve(__dirname, '..', '..', '..');

  return {
    projectRoot,                                                     // cc-control/
    tmuxServer: path.join(projectRoot, 'src', 'server', 'server.cjs'), // HTTP Session server (CommonJS)
    bootstrapScript: path.join(projectRoot, 'scripts', 'bootstrap.sh'), // tmux session 启动
    prompts: path.join(projectRoot, 'prompts', 'run'),               // 阶段提示词模板
    claudePlugins: path.join(os.homedir(), '.claude', 'plugins'),    // ~/.claude/plugins/
    ccSettings: path.join(projectRoot, '.claude', 'settings.json'),  // dev settings
  };
}
