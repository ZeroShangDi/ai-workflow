'use strict';
/**
 * cli/lib/decision.cjs — 决策应答的**三条路由**（CLI 侧）
 *
 * 一个决策事件出现了（会话把 AskUserQuestion 抛出来；服务端已捕获并落了 `decision_requested` 记录），
 * **谁来答**由 `.awf/config.json` 的 `run.decision.mode` 决定：
 *
 *   `manual` —— 人来答。TTY 下问终端；**非 TTY（无人值守 / CI / eval）不抢答**，把问题留给
 *               前端页面 —— 决策本就挂在服务端的 `decisionPending` 上，谁答都行。
 *   `ai`     —— 交给决策内核：AskUserQuestion 在 hook 层就被 deny 并引导走 `<AWF_DECISION_REQUIRED>`
 *               （见 `features/decision/gate.cjs` 的 `classifyAskQuestion`）。走到这里说明策略与门阀
 *               不一致，此时同样不抢答。
 *   `auto`   —— 默认选第一项（5s 倒计时）。与旧 CLI 对 AskUserQuestion 的既有行为一致。
 *
 * **三条路由的应答都经 `POST /respond`**（带 `answeredBy`），由服务端在唯一一处落
 * `decision_answered` 记录 —— 于是复盘时能看出「谁答的、答了什么」，而不用管是走哪条路答的。
 */

/** auto 路由的倒计时（与旧 CLI `autoSelect` 的 DEFAULT_TIMEOUT_MS 一致） */
const AUTO_SELECT_MS = 5000;
const ROUTES = Object.freeze(['manual', 'ai', 'auto']);

/** 决策事件的可读描述（问什么、有哪些选项） */
function describe(pending) {
  const opts = (pending.options || []).map((o, i) => `${i + 1}. ${o}`).join('  ');
  return { question: pending.question || '(无问题文本)', options: opts, labels: pending.options || [] };
}

/** 问终端要一个选项序号（循环到合法为止；越界/非数字绝不回传，会被决策方当成真答案） */
function askTerminal({ stdin, stdout }) {
  const readline = require('node:readline');
  const rl = readline.createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) => {
    rl.question('  选择序号（直接回车 = 第一项）: ', (a) => { rl.close(); resolve(a.trim()); });
  });
}

/**
 * 按策略回应一个 pending 决策。
 * @param {{ pending: object, client: object, mode: string, stdin?: object, stdout?: object, sleepFn?: Function }} deps
 * @returns {Promise<{ answered: boolean, by: string, value?: string, reason?: string }>}
 */
async function answerDecision({
  pending, client, mode,
  stdin = process.stdin, stdout = process.stdout,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const route = ROUTES.includes(mode) ? mode : 'auto';
  const { question, options } = describe(pending);

  if (route === 'ai') {
    return { answered: false, by: 'ai', reason: '决策内核处理，CLI 不抢答' };
  }

  if (route === 'auto') {
    stdout.write(`     ⏳ ${AUTO_SELECT_MS / 1000}s 后默认选第一项…（${question}）\n`);
    await sleepFn(AUTO_SELECT_MS);
    // 与旧 CLI 一致：auto 路由发**序号**（manual 发选项文本），保持既有语义不变
    const value = '1';
    await client.respond(value, 'auto');
    return { answered: true, by: 'auto', value };
  }

  // manual：终端有人才问；非 TTY 留给前端页面（它读同一个 decisionPending）
  if (!stdin.isTTY) {
    return { answered: false, by: 'manual', reason: '非 TTY，等前端页面应答' };
  }
  stdout.write(`\n  ⚡ 需要你决定：${question}\n     ${options}\n`);
  const raw = await askTerminal({ stdin, stdout });
  const idx = raw === '' ? 1 : Number.parseInt(raw, 10);
  const labels = pending.options || [];
  const value = Number.isInteger(idx) && idx >= 1 && idx <= labels.length ? labels[idx - 1] : raw;
  if (!value) return { answered: false, by: 'manual', reason: '空输入' };
  await client.respond(value, 'human');
  return { answered: true, by: 'human', value };
}

module.exports = { answerDecision, describe, AUTO_SELECT_MS, ROUTES };
