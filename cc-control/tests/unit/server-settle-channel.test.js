import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionChannel } = require('../../server/run/channel.cjs');

// run/channel.cjs 现在只做**收尾协商** —— 上下文压缩已拆到 features/context/compaction.cjs。
// 本文件钉住它的真实端口契约：压缩那组端口不该再卡在这里（真 run 装配时曾因此直接抛
// 「端口 readUsagePct 必填」），而收尾协商自己的端口缺了仍要尽早抛。

const prompts = { wrapup: async () => 'w', settle: async () => 's' };
const base = { send: async () => {}, readTaskStatus: () => 'active', markBlocked: () => {}, prompts };

describe('server · 收尾协商的端口契约（run/channel）', () => {
  it('只要求收尾协商自己的端口 —— 压缩端口不在必填里', () => {
    expect(() => createSessionChannel(base)).not.toThrow();
  });

  it('缺收尾协商自己的端口 → 构造即抛（尽早暴露装配漏项）', () => {
    expect(() => createSessionChannel({ ...base, send: undefined })).toThrow(/send/);
    expect(() => createSessionChannel({ ...base, readTaskStatus: undefined })).toThrow(/readTaskStatus/);
    expect(() => createSessionChannel({ ...base, markBlocked: undefined })).toThrow(/markBlocked/);
    expect(() => createSessionChannel({ ...base, prompts: { wrapup: prompts.wrapup } })).toThrow(/prompts\.settle/);
  });

  it('不要求 prompts.contextCheck（那是压缩那一半的模板）', () => {
    expect(() => createSessionChannel(base)).not.toThrow();
    expect(Object.keys(base.prompts)).toEqual(['wrapup', 'settle']);
  });
});
