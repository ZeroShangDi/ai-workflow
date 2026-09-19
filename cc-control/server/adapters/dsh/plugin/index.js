/**
 * awf-dsh — AWF 的 DSH 插件（host 半侧）
 *
 * 本目录是**唯一被安装的单元**：一个自包含的 Cordis 包，不引用目录以外的任何东西
 * （尤其不引用 cc 侧插件树）。目录结构与 cc 插件同构，差异只在该平台必须的那几项：
 *
 *   commands/*.md    命令正文 → 装配时经 ctx.commands.register() 注册（DSH 没有命令目录发现）
 *   skills/**.md     技能正文 → 会话建立时经 agentCtx.skills.register() 注册（会话级，不污染用户会话）
 *   agents/*.md      子 Agent 身份 → 一个独立的 tool-subagent 实例（DSH 没有 subagent_type 注册表）
 *   mcp.json + mcp/  随包携带的 MCP server → 会话作用域挂载（替代旧的 awfRepo 外部定位）
 *   hooks/*          cc hook 点的等价订阅 → hooks.json 声明，hooks/index.js 接线
 *   lib/*            指令通道与平台操作（不随资产变）
 *
 * 安装形态：**整目录拷进** `$DSH_HOME/profiles/<p>/node_modules/awf-dsh-plugin`
 * （不是软链 —— Node 按真实路径解析包的裸 import，软链进 profile 后
 *  `import('@deepseek-ai/dsh-*')` 永远找不到 profile 的 node_modules；实测见
 *  docs/discuss/dsh-plugin-structure.md §4）。
 *
 * 平台服务接法（Cordis）：
 *   - `inject` 只列真正必需的服务；其余按 op 用 `ctx.get(name)` 惰性取，
 *     这样缺某个能力时是**该 op 显式失败**，而不是整个插件装不起来。
 *   - 命令与 hook 在 `apply()` 接（进程级）；技能、子 Agent 工具、MCP 在
 *     `agents.create` 的 `setup(agentCtx)` 里接（**会话级**，见 lib/ops.js 的 createSession）。
 *
 * 配置（profile 的 patch 行 `config`，或环境变量）：
 *   awfBase   AWF server 基址（也读 `AWF_DSH_BASE`）—— 缺它则插件不启动通道并**明确告警**
 *   webUrl    打开页面用的基址（缺省按 webPort 拼）
 *   provider / model  一次性调用用的模型（缺省走平台默认）
 *   mcpServers  覆盖 mcp.json 的 mountByDefault（挂哪些 MCP server）
 *   agentPreset 会话装配用的 preset（缺省 standard）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBridgeClient } from './lib/bridge-client.js';
import { createOps, lastAssistantText } from './lib/ops.js';
import { registerCommands } from './lib/commands.js';
import { installHooks, createTurnReporter } from './hooks/index.js';

export const name = 'awf-dsh';

/** 只依赖 timer（重连退避用）；其余服务按需 `ctx.get`，缺失时对应 op 显式失败 */
export const inject = ['timer'];

/** 插件版本：从 package.json 读，避免握手版本与包版本各写一份而漂 */
function pluginVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch { return 'unknown'; }
}

export function apply(ctx, config = {}) {
  const log = (level, msg) => {
    const line = `[awf-dsh][${level}] ${msg}`;
    if (level === 'info') console.log(line); else console.error(line);
  };

  const awfBase = config.awfBase || process.env.AWF_DSH_BASE;
  if (!awfBase) {
    // 明确告警而不是静默：没配 AWF 地址，插件装上了也驱动不了任何东西
    log('warn', '未配置 awfBase（config.awfBase 或 AWF_DSH_BASE）—— 指令通道不启动');
    return;
  }

  // client 后建、ops 先用：事件上报经闭包取 client（避免构造循环）
  let client = null;
  const { dispatch, noteApproval, createdByAwf, inFlight } = createOps({
    ctx,
    config,
    log,
    onEvent: (event, facts) => client?.emitEvent(event, facts),
  });
  client = createBridgeClient({
    awfBase,
    pluginVersion: pluginVersion(),
    dispatch,
    log,
  });

  // ── hooks：按 hooks.json 的订阅表接线（cc 的 5 个 hook 点等价物）──
  installHooks(ctx, {
    createdByAwf,
    inFlight,
    noteApproval,
    log,
    emit: (event, facts) => client?.emitEvent(event, facts),
  });

  // ── 命令：把包内 commands/*.md 注册成 DSH 原生命令 ──
  // 作用范围说明：DSH 的 slash command 只在**网页输入框**触发（API 注入的 prompt 不走
  // commands.execute），所以它服务于「人在网页里手敲 /w-plan …」，`awf plan` 走的是
  // server 侧注入的同形指令（见 server/shared/prompts.js）。两者共享同一份命令正文。
  //
  // ⚠️ **必须经 `ctx.inject` 等 `commands` 服务就绪**，不能在 apply 顶层 `ctx.get('commands')`：
  // 本插件由 profile patch 层插入，apply 的时机早于 base bundle 的 `commands` 注册表上线，
  // 顶层取会恒得 undefined（真机实测：`commands 服务不可用 —— 不注册任何 /w-* 命令`，
  // 网页输入框敲 `/` 一个命令都没有）。这是探针坑位清单的 F25：
  // 「插件运行期装配必须放 ctx.inject([...services], cb)；放 apply 顶层会命中非活动上下文」。
  ctx.inject(['commands'], (commandCtx) => {
    registerCommands(commandCtx, { log });
  });

  ctx.effect(() => {
    client.start();
    log('info', `指令通道启动：${awfBase}（profile=${process.env.DSH_HOME || '?'}）`);
    return () => {
      client.stop();
      log('info', '指令通道已停止');
    };
  }, 'awf-dsh: bridge client');
}

/**
 * 供测试/诊断：
 *   - `createTurnReporter`：会话事件翻译器（纯逻辑，见 hooks/turn-reporter.js）
 *   - `createBridgeClient`：指令通道客户端（见 lib/bridge-client.js）
 *   - 其余纯逻辑从各自模块直接导出，这里不再转口，避免多一层无意义的间接。
 */
export { createTurnReporter, createBridgeClient, lastAssistantText };
