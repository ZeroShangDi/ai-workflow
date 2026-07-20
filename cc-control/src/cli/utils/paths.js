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
