#!/usr/bin/env node

import { program } from 'commander';
import { initCommand } from '../lib/commands/init.js';
import { planCommand } from '../lib/commands/plan.js';
import { runCommand } from '../lib/commands/run.js';
import { pluginCommand } from '../lib/commands/plugin.js';
import { serverCommand } from '../lib/commands/server.js';
import { openCommand } from '../lib/commands/open.js';
import { attachCommand } from '../lib/commands/attach.js';

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
  .option('-r, --resume', '从上次中断处恢复')
  .option('-l, --local', '使用本地提示词模板，跳过 AI 智能生成')
  .action(runCommand);

// === 辅助命令 ===

program
  .command('plugin <action>')
  .description('插件管理：install / uninstall')
  .action(pluginCommand);

program
  .command('server <action>')
  .description('tmux-http 服务管理：start / stop / status')
  .action(serverCommand);

program
  .command('open <target>')
  .description('打开可视化页面：dashboard / tree / ui')
  .action(openCommand);

program
  .command('attach')
  .description('接入 tmux session 观看 Claude Code 实时对话')
  .action(attachCommand);

program.parse();
