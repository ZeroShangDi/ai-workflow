#!/usr/bin/env node
'use strict';
/**
 * cli/awf.cjs — CLI 入口（package.json bin；后缀 .cjs 因为包是 type:module）
 *
 * 定位：**薄** —— 只做「起环境 / 提交 / 订阅 / 中继 / 看现场」，编排全在 server 的 run host。
 * 本 CLI 的服务端是隔壁 `server/`（见 lib/context.cjs）；旧树 `src/` 已随收口退役
 * （docs/discuss/legacy-tree-retirement.md）。
 *
 * 命令面：init / plan / run / server / open / attach / plugin —— 完整链路可用
 * （init 建工作区 → plan 出 state → run 执行）。
 */

const { program } = require('commander');
const { runCommand } = require('./commands/run.cjs');
const { serverCommand } = require('./commands/server.cjs');
const { openCommand } = require('./commands/open.cjs');
const { attachCommand } = require('./commands/attach.cjs');
const { pluginCommand } = require('./commands/plugin.cjs');
const { initCommand } = require('./commands/init.cjs');
const { planCommand } = require('./commands/plan.cjs');

program
  .name('awf')
  .version('2.0.0')
  .description('AI Workflow — CLI（新树：薄客户端，编排在 server）');

program
  .command('run [task]')
  .description('启动自治开发工作流')
  .option('-r, --resume', '复用现场续接：活跃 run 挂接续观，宿主空闲则提交续跑')
  .option('--attach', '只挂接活跃 run（不重复提交）')
  .option('-R, --run-id <runId>', '指定 run id')
  .option('--multi-agent', '多 Agent 并行（交给宿主 batch 调度）')
  .action(runCommand);

program
  .command('plan [description]')
  .description('启动规划会话，对齐需求、产出 WBS 与任务列表')
  .option('-r, --resume', '恢复上次规划')
  .action(planCommand);

program
  .command('init')
  .description('初始化项目工作流环境（工作区骨架 + 插件本地注册）')
  .option('-f, --force', '已存在时补全缺失文件')
  .action(initCommand);

program
  .command('server <action>')
  .description('常驻 server 管理：start / stop / status')
  .action(serverCommand);

program
  .command('plugin <action>')
  .description('插件管理：install / uninstall（--scope local|global）')
  .option('-s, --scope <scope>', 'local（写本项目 .claude/settings.json，默认）| global（claude plugin install）', 'local')
  .action(pluginCommand);

program
  .command('open <target>')
  .description('打开页面：dashboard / tree / ui')
  .action(openCommand);

program
  .command('attach')
  .description('接入会话观看实时对话（cc → tmux；DSH → 浏览器会话页）')
  .action(attachCommand);

program.parseAsync().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
