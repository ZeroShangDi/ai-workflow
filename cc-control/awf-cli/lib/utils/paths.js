import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 解析所有关键路径
 * awf-cli 位于 cc-control/awf-cli/，其自身源码结构:
 *   awf-cli/bin/cli.js        ← 入口
 *   awf-cli/lib/utils/paths.js ← 当前文件
 *
 * 依赖的项目目录:
 *   cc-control/cc-plugins/    ← 插件源码
 *   cc-control/tmux-http/     ← tmux-http 服务
 */
export function getPaths() {
  const cliRoot = path.resolve(__dirname, '..', '..');          // awf-cli/
  const ccControl = path.resolve(cliRoot, '..');                 // cc-control/
  const projectRoot = path.resolve(ccControl, '..');             // ai-workflow/

  return {
    cliRoot,                                                     // cc-control/awf-cli/
    ccControl,                                                   // cc-control/
    projectRoot,                                                 // ai-workflow/
    ccPlugins: path.join(ccControl, 'cc-plugins'),               // 插件源码
    ccSettings: path.join(ccControl, 'cc-plugins', '.claude', 'settings.json'),
    tmuxHttp: path.join(ccControl, 'tmux-http'),                 // tmux-http 目录
    tmuxServer: path.join(ccControl, 'tmux-http', 'server.js'),  // server.js
    claudePlugins: path.join(os.homedir(), '.claude', 'plugins'), // ~/.claude/plugins/
    prompts: path.join(ccControl, 'cc-plugins', 'prompts', 'run'), // 阶段提示词模板
  };
}
