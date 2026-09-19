/**
 * hooks/index.js — 按 hooks.json 的订阅表接线
 *
 * 为什么是「读表接线」而不是直接写死几个 ctx.on：cc 侧的 hooks.json 是平台清单，
 * 一眼能看出接了哪几个 hook 点；DSH 侧把同一件事摆成数据，改接线不用翻代码，
 * 也便于审计「cc 的哪个 hook 点在这边有没有对应物」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTurnReporter } from './turn-reporter.js';
import { createApprovalResponder } from './approval.js';

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 处理器名 → 工厂。工厂收到 deps，返回真正的 ctx.on 回调。 */
const HANDLERS = {
  turnReporter: (deps) => createTurnReporter(deps),
  approvalResponder: (deps) => createApprovalResponder(deps),
};

/** 读订阅表（缺失/非法 → 明确抛错，不静默变成「一个 hook 都没接」） */
export function readManifest(file = path.join(HOOKS_DIR, 'hooks.json')) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const subs = Array.isArray(cfg?.subscriptions) ? cfg.subscriptions : [];
  if (subs.length === 0) throw new Error(`hooks.json 没有任何订阅声明：${file}`);
  return cfg;
}

/**
 * 接线全部声明的订阅。
 * @param {object} ctx Cordis 根 ctx
 * @param {{createdByAwf: Set<string>, inFlight: Set<string>, emit: Function,
 *          noteApproval: Function, log: Function}} deps
 * @returns {string[]} 实际接上的 DSH 事件名
 */
export function installHooks(ctx, deps) {
  const { subscriptions } = readManifest();
  const wired = [];
  for (const sub of subscriptions) {
    const make = HANDLERS[sub.handler];
    if (!make) {
      deps.log('warn', `hooks.json 声明了未知处理器 ${sub.handler}（${sub.dsh}）—— 未接线`);
      continue;
    }
    ctx.effect(() => ctx.on(sub.dsh, make(deps)), `awf-dsh: hook ${sub.dsh} → ${sub.handler}`);
    wired.push(sub.dsh);
  }
  deps.log('info', `已接线 ${wired.length} 条订阅：${wired.join(', ')}`);
  return wired;
}

export { createTurnReporter, createApprovalResponder };
