import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

/**
 * 解析所有关键路径
 *
 * 当前文件位于 cc-control/src/cli/，以此为基准：
 *   - 上溯 2 级 → cc-control/（projectRoot）
 *   - CLI 入口: src/awf.js
 *   - Session Server: src/server/server.cjs
 *   - tmux 启动脚本: scripts/bootstrap.sh
 *   - 阶段提示词模板: src/prompts/run/
 *   - Claude Code 插件目录: ~/.claude/plugins/
 *   - 开发用 settings: .claude/settings.json
 */
export function getPaths() {
  const projectRoot = path.resolve(__dirname, '..', '..');

  return {
    /** cc-control/ 根目录 */
    projectRoot,
    /** HTTP Session Server 入口 (CommonJS) */
    tmuxServer: path.join(projectRoot, 'src', 'server', 'server.cjs'),
    /** tmux session 启动脚本 */
    bootstrapScript: path.join(projectRoot, 'scripts', 'bootstrap.sh'),
    /** 阶段 prompt 模板目录 */
    prompts: path.join(projectRoot, 'src', 'prompts', 'run'),
    /** ~/.claude/plugins/ — CC 全局插件目录 */
    claudePlugins: path.join(os.homedir(), '.claude', 'plugins'),
    /** cc-control 开发用 settings.json */
    ccSettings: path.join(projectRoot, '.claude', 'settings.json'),
  };
}
