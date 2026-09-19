'use strict';
/**
 * cli/commands/plugin.cjs — awf plugin install|uninstall（只编排）
 *
 * 两条路径，都不实现 cc 形状：
 *   - **local**（默认）：把随包声明的插件清单与 MCP 声明落进**本项目**配置 —— 经 `profile` 端口
 *     （`adapters/cc/profile.cjs` 管 `.claude/settings.json` / `.mcp.json` 的注入与注销）；
 *   - **global**：装到 CC 用户级插件目录 —— 经 `tooling` 端口（`claude plugin …` 命令字面只在那）。
 *
 * 本文件只有参数分派、循环与输出；命令字符串、合并语义、模板解析全在适配器层。
 */

const path = require('node:path');
const { exec } = require('node:child_process');
const { buildContext } = require('../lib/context.cjs');

/** child_process.exec 的 Promise 包装（tooling 的 install/uninstall 需要注入执行器） */
function execAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(String(stdout).trim());
    });
  });
}

/**
 * DSH 的本地装配（T-P2-02）：**没有项目级注入** —— DSH 的接入是「装进用户级 profile」，
 * 全局一次、多项目共享（U5/U12）。项目侧靠 `.awf/config.json` 的 `runtime.adapter=dsh` 启用。
 * 默认只写隔离/指定的 DSH_HOME；真实 home 由用户自己确认（CLI 不替用户决定）。
 */
function localPluginDsh(action, ctx) {
  const dsh = ctx.adapters.tools.profile; // = server/adapters/dsh/install.cjs
  const opts = {
    profile: process.env.AWF_DSH_PROFILE || 'web',
    // 插件要连的**常驻 AWF server**（本项目端口）
    awfBase: `http://127.0.0.1:${ctx.port}`,
    // AWF **包根**：插件据此定位 plugin/core/mcp/*/server.cjs 来挂项目 MCP（缺了 session.create 直接失败）
    awfRepo: ctx.infraRoot,
    // **DSH 网页**端口（会话观看地址用）：DSH 自己的端口，不是 AWF 端口。
    // 缺省 3080 与 DSH 缺省一致；DSH 跑在别的端口时用 AWF_DSH_WEB_PORT 声明。
    webPort: Number(process.env.AWF_DSH_WEB_PORT) || 3080,
  };
  if (action === 'install') {
    const r = dsh.installProfile(opts);
    if (r.error) {
      console.error(`DSH 装配失败：${r.error}`);
      process.exit(1);
    }
    console.log(`${r.written ? '已装配' : '已是装配态'} DSH profile ${opts.profile} → ${r.path}`);
    console.log(`  插件拷贝 → ${r.pluginPath}`);
    if (r.backupPath) console.log(`  原 patch 已备份 → ${r.backupPath}`);
    // 技能：把 plugin 里的中性 SKILL.md **链接**进 DSH 技能根（$DSH_HOME/skills/），
    // 编辑源 md 即时生效，不用重装（C29 技能发现；链接失败退化为复制）
    const sk = dsh.installSkills({ dshHome: opts.dshHome });
    console.log(`  技能 → ${sk.root}：${sk.installed.length} 个已装${sk.skipped.length ? `、${sk.skipped.length} 个跳过` : ''}${sk.failed.length ? `、${sk.failed.length} 个失败` : ''}`);
    if (sk.failed.length) console.log(`    失败：${sk.failed.join('；')}`);
    console.log(`  提示：装配写在 DSH_HOME=${dsh.resolveDshHome()}；改的是运行中 profile，重启 dsh 后台后生效`);
    return;
  }
  if (action === 'uninstall') {
    const r = dsh.uninstallProfile(opts);
    if (r.error) {
      console.error(`DSH 卸载失败：${r.error}`);
      process.exit(1);
    }
    console.log(r.written ? `已卸载 DSH 装配 → ${r.path}` : '无可卸载内容');
    const sk = dsh.uninstallSkills({ dshHome: opts.dshHome });
    if (sk.removed.length) console.log(`  已摘技能链接：${sk.removed.join(', ')}`);
    return;
  }
  console.error(`未知操作：${action}（可用 install | uninstall）`);
  process.exit(2);
}

/**
 * 本地注册：cc 写本项目的 .claude/settings.json（enabled-only）；DSH 装 profile 插件。
 *
 * env 必须跟其它命令**同一份**（`buildContext` 缺省会做 `commandConfigEnv` 清洗）：
 * 这里曾写死 `env: {}`（旧树只为取一个干净 port），结果把 `CC_ADAPTER` 一起吞掉 ——
 * 干净项目上 `CC_ADAPTER=dsh awf init` 会按 cc 注册（真机踩到）。
 */
function localPlugin(action, projectRoot) {
  // 平台资产按项目解析（T-P1-01）：profile 的注入形状由本项目平台决定，不静态绑 cc
  const ctx = buildContext(projectRoot);
  if (ctx.adapter === 'dsh') return localPluginDsh(action, ctx); // 平台分支（T-P2-02）
  const { profile } = ctx.adapters.tools;
  if (action === 'install') {
    const r = profile.installProfile(projectRoot);
    if (!r.written) return console.error(`本地注册失败：${r.error}`);
    console.log(`已本地注册 → ${r.path}`);
    const m = profile.installProjectMcp(projectRoot, ctx.port);
    if (m.written) console.log(`已注册项目 MCP → ${m.servers.join(', ')}`);
    return;
  }
  if (action === 'uninstall') {
    const r = profile.uninstallProfile(projectRoot);
    console.log(r.written ? `已注销 → ${r.path}` : '无可注销内容');
    return;
  }
  console.error(`未知操作：${action}（可用 install | uninstall）`);
  process.exit(2);
}

/** 全局安装：先注册 marketplace，再按清单逐个 claude plugin install */
async function globalPlugin(action, ctx) {
  const { profile, tooling } = ctx.adapters.tools;
  const specs = profile.listDeclaredPlugins();
  if (!specs.length) return console.error('plugin/settings.json 未声明任何插件');

  if (action === 'install') {
    const mp = path.join(ctx.infraRoot, 'server', 'adapters', 'cc', 'plugin');
    await execAsync(tooling.buildMarketplaceAdd(mp)); // 幂等；marketplace 是前置，失败即中止
    await runPerSpec('安装', specs, (spec) => tooling.install(spec, { execAsync }));
    return;
  }
  if (action === 'uninstall') {
    await runPerSpec('卸载', specs, (spec) => tooling.uninstall(spec, { execAsync }));
    return;
  }
  console.error(`未知操作：${action}（可用 install | uninstall）`);
  process.exit(2);
}

/**
 * 逐 spec 执行并**报错不阻断**：单个插件失败只记一行，其余照装/照卸。
 *
 * 旧 CLI 的行为是「失败不阻断」，新 CLI 初版改成直接 await —— 一个插件失败就中断整批，
 * 且已成功的部分没有汇总。这里把两条都补回：逐个 try/catch + 末尾给出成功/失败计数
 * （计数是「不静默」的那一半：部分失败必须看得见）。
 */
async function runPerSpec(verb, specs, run) {
  const failed = [];
  for (const spec of specs) {
    try {
      await run(spec);
      console.log(`${verb} ${spec} … 完成`);
    } catch (err) {
      failed.push(spec);
      console.error(`${verb}失败 ${spec}：${err.message}`);
    }
  }
  console.log(`已全局${verb} ${specs.length - failed.length}/${specs.length} 个插件${failed.length ? `（失败：${failed.join('、')}）` : ''}`);
}

async function pluginCommand(action, options = {}) {
  const projectRoot = process.cwd();
  if (options.scope === 'global') {
    const ctx0 = buildContext(projectRoot);
    if (ctx0.adapter === 'dsh') {
      // DSH 没有 `claude plugin` 那套 marketplace：**profile 装配本身就是全局安装**（U5）
      console.error('DSH 平台没有独立的 global 安装：`awf plugin install`（不带 --scope global）即为全局装配（装进 DSH profile）');
      process.exit(2);
    }
    return globalPlugin(action, buildContext(projectRoot));
  }
  return localPlugin(action, projectRoot);
}

module.exports = { pluginCommand, localPlugin, localPluginDsh, globalPlugin, runPerSpec, execAsync };
