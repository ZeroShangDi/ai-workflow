#!/usr/bin/env node

import { program } from 'commander';
import { initCommand } from './cli/init.js';
import { planCommand } from './cli/plan.js';
import { runCommand } from './cli/run.js';
import { pluginCommand } from './cli/plugin.js';
import { serverCommand } from './cli/server.js';
import { openCommand } from './cli/open.js';
import { attachCommand } from './cli/attach.js';

program
  .name('awf')
  .version('2.0.0')
  .description('AI Workflow Framework — Claude Code 工作流 CLI');

// === 主命令 ===

program
  .command('init')
  .description('初始化项目工作流环境（含插件安装）')
  .option('-f, --force', '覆盖已有配置')
  .action(initCommand);

program
  .command('plan [description]')
  .description('启动规划会话，对齐需求、产出 WBS 和任务列表')
  .option('-r, --resume', '恢复上次规划')
  .action(planCommand);

program
  .command('run [task]')
  .description('启动自治开发工作流')
  .option('-a, --auto', '全自动模式，不暂停等待确认')
  .option('-r, --resume', '从上次中断处恢复（活跃 run 挂接续观；宿主空闲则续跑 store 剩余任务）')
  .option('--attach', '挂接到正在运行的 run（读 store 落盘状态续观 + 应答中继，不重复提交）')
  .option('-R, --run-id <runId>', '指定 run（sid/runId）：--attach/--resume 挂接该 run，fresh 提交命名该 run')
  .option('-l, --local', '使用本地提示词模板，跳过 AI 智能生成')
  .option('--multi-agent', '启用多 Agent 并行执行（默认单 Agent）')
  .action(runCommand);

// === 辅助命令 ===

program
  .command('plugin <action>')
  .description('插件管理：install / uninstall（--scope 选本地或全局）')
  .option('-s, --scope <scope>', '安装范围：local（本地注入，默认）| global（claude plugin install）', 'local')
  .action(pluginCommand);

program
  .command('server <action>')
  .description('tmux-http 服务管理：start / stop / status')
  .action(serverCommand);

program
  .command('open <target>')
  .description('打开可视化页面：dashboard / tree')
  .action(openCommand);

program
  .command('attach')
  .description('接入 tmux session 观看 Claude Code 实时对话')
  .action(attachCommand);

program.parse();
