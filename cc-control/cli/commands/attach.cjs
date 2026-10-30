'use strict';
/**
 * cli/commands/attach.cjs — 接入会话观看实时对话（纯外部动作，不拉环境、不改状态）
 *
 * T-P1-03：不再直连 tmux —— 「怎么接进去看」是平台知识，经本项目解析出的
 * `session` 端口的 `attach()` 完成。
 *
 * 两种平台形态，**顺序有讲究**：
 *   1. 网页形态（dsh）：平台有「观看地址」，先问常驻 AWF server 的 `/probe`（`?p=<项目>`）
 *      拿它 —— CLI 进程里**没有** bridge（bridge 只在 server 里），端口自己问不到平台。
 *   2. 终端形态（cc）：`attach()` 直接占住前台（`tmux attach`），没有地址可用。
 * 所以先探「有没有地址」，没有才落到端口的 `attach()`；否则 cc 会被多打一次 HTTP。
 */

const { spawn } = require('node:child_process');
const { buildContext } = require('../lib/context.cjs');
const { createClient } = require('../lib/client.cjs');

/** 打开浏览器（失败不阻断：无头机器上仍可手动点打印出来的 URL） */
function openUrl(url, browser = process.env.AWF_BROWSER || 'open') {
  try {
    spawn(browser, [url], { stdio: 'ignore', detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

/** 打印观看地址并尝试打开；`AWF_BROWSER` 可换成任意命令（探针里用 `true` 免弹窗） */
function showUrl(url, { announce = true } = {}) {
  const opened = openUrl(url);
  if (announce) console.log(`本项目会话在网页里（DSH 是网页形态，没有终端可 attach）：${url}`);
  if (!opened && announce) console.log('  （没能自动打开浏览器，手动点上面的地址）');
  return opened;
}

async function attachCommand() {
  const ctx = buildContext(process.cwd());
  const { session } = ctx.adapters.ports;

  // ① 网页形态：经 server 的 /probe 取平台的观看地址（CLI 进程没有 bridge）
  const client = createClient({ port: ctx.port, project: ctx.projectRoot });
  const probed = await client.call('probe', { timeoutMs: 3000 });
  if (probed?.ok !== false && typeof probed?.url === 'string' && probed.url) {
    showUrl(probed.url);
    return;
  }

  // ② 终端形态：交给端口的 attach（cc = tmux attach，占住前台）
  try {
    const r = session.attach({ stdio: 'inherit' });
    if (r && typeof r.url === 'string' && r.url) showUrl(r.url); // 进程内直连时的兜底
  } catch (err) {
    console.error(`无法接入会话 ${session.sessionName}（${err.message}）`);
    process.exit(1);
  }
}

module.exports = { attachCommand, openUrl };
