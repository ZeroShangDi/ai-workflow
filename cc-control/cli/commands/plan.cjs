'use strict';
/**
 * cli/commands/plan.cjs — awf plan（只编排）
 *
 * 三步，全是调用：
 *   ① 非 resume 时归档残留的旧 state 并重置为空 plan 模板（run/pause 中不触发）；
 *   ② 取入口提示词（由插件 `prompts.json` 声明，CLI 不写死任何命令字面）；
 *   ③ 走本项目的规划入口（`interactive` 端口）：cc 在**本进程**直开交互式对话；平台声明
 *      `detached: true` 时（DSH）请常驻 AWF server 代触发（CLI 进程没有 bridge）。
 *
 * 与旧 CLI 的差别只有调用方式：新树里 `state.js` / `prompts.js` 是 ESM，本命令是 CJS，
 * 故用动态 import（与 `server/runtime/index.cjs` 同一手法）。
 */

const { spawn } = require('node:child_process');
const { buildContext } = require('../lib/context.cjs');

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
/**
 * 规划会话的**标题**（给人看的，不是给模型的）。
 *
 * 为什么由 CLI 给：DSH 的会话标题默认取**首条用户消息**，而注入的是命令正文（w-plan.md 全文），
 * 于是侧栏里一排会话全叫「# w-plan 主规划流程。从一句话」。只有这一层知道用户的需求原文。
 * 没描述时返回 undefined —— 让插件用它自己的兜底（项目名），而不是把「AWF 规划」这种空标题写死。
 * @param {string} [desc] 规范化后的需求描述
 * @returns {string|undefined}
 */
function planTitle(desc) {
  const text = String(desc ?? '').replace(/\s+/g, ' ').trim();
  return text === '' ? undefined : `AWF 规划 · ${text.slice(0, 60)}`;
}

async function launchPlan(projectRoot, prompt, interactive, port, title) {
  if (interactive.detached !== true) {
    await interactive.launchDialog({ cwd: projectRoot, prompt, title });
    return;
  }
  const { createClient } = require('../lib/client.cjs');
  const client = createClient({ port, project: projectRoot });
  const r = await client.call('planLaunch', { body: { prompt, title } });
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

  if (!options.resume) {
    const { archiveOldStateForPlan } = await import('../../server/shared/state.js');
    const r = archiveOldStateForPlan(projectRoot);
    if (r.action === 'archived') console.log(`检测到旧 plan 状态，已归档：${r.archivedPath}`);
    else if (r.action === 'run-active') console.log('检测到 run 运行中（mode=run/pause），跳过 plan 重置');
  }

  const { planEntry } = await import('../../server/shared/prompts.js');
  // 平台参数：cc 入口是斜杠命令、DSH 展开成指令（见 prompts.js 的 planEntry）
  const prompt = await planEntry(desc, options.resume, { adapter: ctx.adapter });

  console.log('启动规划会话…');
  // detached 平台（DSH）：规划入口是「平台侧开会话 + 注入指令」，两样前置都得在 ——
  // 常驻 AWF server（plan 经它代触发）与 dsh 网页后台（会话活在它里面）。不存在则起，存在则复用。
  if (interactive.detached === true) {
    const session = await import('../lib/session.cjs');
    const srv = await session.ensureServer(ctx);
    if (srv.started) console.log(`  常驻 server 已启动（端口 ${ctx.port}）`);
    await session.ensureDshWeb(ctx);
  }
  await launchPlan(projectRoot, prompt, interactive, ctx.port, planTitle(desc));
  if (interactive.detached === true) console.log('规划会话已在平台侧开始（网页里接着聊）');
  else console.log('规划会话结束');
}

module.exports = { planCommand, normalizeDescription };
