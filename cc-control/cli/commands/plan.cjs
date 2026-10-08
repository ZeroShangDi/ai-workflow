'use strict';
/**
 * cli/commands/plan.cjs — awf plan（只编排）
 *
 * CLI 通过 Server 的工作流接口创建需求与 Plan 会话并取得提示词；
 * 平台交互仍由 adapter 端口负责，CLI 不直接读写持久化状态或自行拼装提示词。
 */

const { spawn } = require('node:child_process');
const { buildContext } = require('../lib/context.cjs');
const { createClient } = require('../lib/client.cjs');
const session = require('../lib/session.cjs');

/** 打开浏览器（失败不阻断：无头机器上仍可手点打出来的 URL） */
function openUrl(url, browser = process.env.AWF_BROWSER || 'open') {
  if (!url) return;
  try { spawn(browser, [url], { stdio: 'ignore', detached: true }).unref(); } catch { /* 无头环境 */ }
}

/**
 * 规划入口的两种形态，按平台**声明的能力**选路（不猜）：
 *   - `interactive.detached === true`（DSH）：开会话 + 注入指令是平台侧动作、回 URL，
 *     但 CLI 进程里**没有 bridge** → 必须请常驻 AWF server 代触发（`POST /interactive/plan`）。
 *   - 否则（cc）：交互式对话要占住用户终端 → 在**本进程**直开。
 * 服务端没起时明确失败（不静默回落成「启动成功」）。
 */
async function launchPlan(projectRoot, prompt, interactive, client, title, workflowSessionId) {
  if (interactive.detached !== true) {
    await interactive.launchDialog({ cwd: projectRoot, prompt, title });
    return;
  }
  const r = await client.call('planLaunch', { body: { prompt, title, workflowSessionId } });
  if (r?.ok === false) {
    const raw = r.error || '未知错误';
    // 两种「发不出去」的处置完全不同，提示不能混：
    //   通道断了（server 在跑、插件没连上）→ 提示 awf server start 是误导，它已经在跑了
    const hint = /指令通道|未连接|ws closed/i.test(raw)
      ? '（常驻 server 在跑，是 dsh 里的插件没连上：重启 dsh 后台，或确认插件已安装并加载）'
      : '（规划入口由常驻 server 代执行：先 `awf server start`）';
    throw new Error(`${raw}${hint}`);
  }
  if (r?.url) {
    openUrl(r.url);
    console.log(`规划会话已在网页打开：${r.url}`);
  } else {
    console.log(`规划会话已创建：${r.sessionId ?? '(未知 id)'}`);
  }
}

/**
 * 归一化描述：`awf plan <词1> <词2> …` 的全部位置参数拼回一句。
 * 为什么必须拼：中文引号 `“…”` **不是** shell 的引号字符，`awf plan “设计一个 系统”` 会被 shell
 * 按空格切成多个参数，只取第一个就会**静默截断**（真机踩到：模型只收到「设计一个」）。
 * 同时把「引号没闭合」显式提示出来 —— 截断必须看得见，不能猜。
 * @param {string|string[]} description
 * @returns {string|undefined}
 */
function normalizeDescription(description) {
  if (description === undefined) return undefined;
  const text = (Array.isArray(description) ? description : [description]).filter((x) => x !== undefined && x !== null).join(' ');
  if (!text.trim()) return undefined;
  const opens = (text.match(/[“"']/g) || []).length;
  const closes = (text.match(/[”"']/g) || []).length;
  if (opens > closes) {
    console.error(`  提示：描述里的引号看起来没闭合，shell 也没把它当引号用。`);
    console.error(`  实际收到：${JSON.stringify(text)}`);
    console.error(`  建议用 ASCII 双引号包住整段：awf plan "完整的描述…"`);
  }
  return text;
}

async function planCommand(description, options = {}) {
  const projectRoot = process.cwd();
  const desc = normalizeDescription(description);
  // 平台按项目解析（T-P1-01）：plan 的交互入口由本项目声明的平台提供
  const ctx = buildContext(projectRoot);
  const { interactive } = ctx.adapters.ports;

  console.log('启动规划会话…');
  // CLI 仅负责启动交互入口；状态重置与提示词构造由 Server 处理。
  const srv = await session.ensureServer(ctx);
  if (srv.started) console.log(`  常驻 server 已启动（端口 ${ctx.port}）`);
  const client = createClient({ port: ctx.port, project: projectRoot });
  if (options.approve) {
    const approved = await client.approvePlan({});
    if (approved?.ok === false) throw new Error(`Server 无法确认 Plan：${approved.error}`);
    console.log('当前 Plan 已确认，可以执行 awf run');
    return;
  }
  if (interactive.detached === true) {
    await session.ensureDshWeb(ctx);
  }
  const prepared = await client.preparePlan({ requestText: desc || (options.resume ? undefined : '规划当前项目'), resume: !!options.resume });
  if (prepared?.ok === false) throw new Error(`Server 无法准备 Plan：${prepared.error}`);
  try {
    await launchPlan(projectRoot, prepared.prompt, interactive, client, prepared.title, prepared.workflowSessionId);
    if (interactive.detached === true) console.log('规划会话已在平台侧开始（网页里接着聊）');
    else {
      // CC 的 CLI Plan 是前台交互会话：用户退出该会话即表示本次 Plan 已完成。
      // 持久化引入 draft -> todo 门禁后，若 CLI 不同步确认，后续 `awf run`
      // 会永久停在“请先确认 Plan”，而 CLI 又没有其他确认入口。
      const approved = await client.approvePlan({ requirementId: prepared.requirement?.id });
      if (approved?.ok === false) throw new Error(`Server 无法确认 Plan：${approved.error}`);
      const finished = await client.finishPlan({ workflowSessionId: prepared.workflowSessionId, attemptId: prepared.attemptId, status: 'completed' });
      if (finished?.ok === false) throw new Error(`Server 无法结束 Plan attempt：${finished.error}`);
      console.log('Plan 已完成并确认');
    }
  } catch (error) {
    await client.finishPlan({ workflowSessionId: prepared.workflowSessionId, attemptId: prepared.attemptId, status: 'failed', errorText: error.message });
    throw error;
  }
}

module.exports = { planCommand, normalizeDescription };
