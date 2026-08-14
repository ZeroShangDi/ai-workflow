import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
 *
 * 注：插件命名空间/命令引用已迁至 src/lib/plugin-bridge.js（插件边界唯一模块）
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
