import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const channelMod = require('../../server/web/bridge-channel.cjs');
const { parseFrameHeader } = require('../../server/web/ws.cjs');

/**
 * DSH 指令通道的**传输侧**（bridge-channel.cjs）—— P2-4。
 *
 * 这里验的是「通道 ↔ 真实 socket / HTTP 面」的接线，不是 DSH 能不能跑：
 *   - 没插件连上来 → 指令判「未交给平台」（不能假装发出去了）；
 *   - 插件连上 → 指令真的编码成 WS 文本帧写出；
 *   - 插件回 accepted/result（经 HTTP 回传）→ 指令拿到「已交给平台」的结论；
 *   - socket 断开 → 在途指令判「无法确认」。
 *
 * ⚠️ 真实链路（真 DSH 插件）在 P2-5 用隔离探针验。
 */

/** 假 socket：记录写出的字节 */
function makeSocket() {
  const frames = [];
  return {
    destroyed: false,
    writable: true,
    frames,
    write(buf) { frames.push(Buffer.from(buf)); return true; },
  };
}

/** 从 WS 文本帧里取出 JSON（服务端→客户端不掩码；只解析本测试自己写的帧） */
function decodeFrame(buf) {
  const h = parseFrameHeader(buf);
  return JSON.parse(buf.slice(h.headerLen, h.headerLen + h.payloadLen).toString('utf8'));
}

beforeEach(() => { channelMod.reset(); });
afterEach(() => { channelMod.reset(); });

describe('bridge-channel — 未连接', () => {
  it('没有插件连接时，指令判「未交给平台」，且不写任何帧', async () => {
    const r = await channelMod.channel().request('session.facts', {});
    expect(r.delivery).toBe('not-delivered');
    expect(r.error).toContain('未连接');
  });
});

describe('bridge-channel — 已连接', () => {
  it('插件连上后，指令编码成 WS 文本帧写出（含 commandId/op/projectRoot）', async () => {
    const socket = makeSocket();
    channelMod.attachSocket(socket, { platform: 'dsh', pluginVersion: '0.0.1' });
    expect(channelMod.channel().connected()).toBe(true);

    const p = channelMod.channel().request('session.prompt', { text: 'hi' }, { projectRoot: '/proj' });
    expect(socket.frames).toHaveLength(1);
    const cmd = decodeFrame(socket.frames[0]);
    expect(cmd).toMatchObject({ type: 'command', op: 'session.prompt', args: { text: 'hi' }, projectRoot: '/proj' });
    expect(cmd.commandId).toBeTruthy();

    // 插件经 HTTP 回传：先 accepted，再 result
    expect(channelMod.handleCallback({ commandId: cmd.commandId, phase: 'accepted' })).toBe(true);
    expect(channelMod.handleCallback({ commandId: cmd.commandId, phase: 'result', ok: true, result: { turnEnded: true } })).toBe(true);
    const r = await p;
    expect(r).toMatchObject({ delivery: 'accepted', ok: true, result: { turnEnded: true } });
  });

  it('attach 带上平台/版本事实（版本可识别）', () => {
    channelMod.attachSocket(makeSocket(), { platform: 'dsh', pluginVersion: '0.0.1' });
    expect(channelMod.channel().lastFacts()).toMatchObject({ platform: 'dsh', pluginVersion: '0.0.1' });
  });

  it('socket 断开 → 在途指令判「无法确认」且清空连接', async () => {
    const socket = makeSocket();
    channelMod.attachSocket(socket);
    const p = channelMod.channel().request('session.create', {}, { projectRoot: '/p' });
    channelMod.detachSocket('ws closed');
    const r = await p;
    expect(r.delivery).toBe('unconfirmed');
    expect(r.error).toContain('ws closed');
    expect(channelMod.channel().connected()).toBe(false);
  });

  it('socket 已销毁时发指令 → 未交给平台（不静默丢帧）', async () => {
    const socket = makeSocket();
    channelMod.attachSocket(socket);
    socket.destroyed = true;
    const r = await channelMod.channel().request('session.facts', {});
    expect(r.delivery).toBe('not-delivered');
    expect(r.error).toContain('发送失败');
  });

  it('事件回传分发到通道订阅者（插件→AWF 的上行事件）', () => {
    channelMod.attachSocket(makeSocket());
    const seen = [];
    channelMod.channel().onEvent((e) => seen.push(e));
    expect(channelMod.handleCallback({ kind: 'event', event: { type: 'session.started' } })).toBe(true);
    expect(seen).toEqual([{ type: 'session.started' }]);
  });

  it('未知 commandId 的回传不被消费（返回 false，由 api 记日志）', () => {
    expect(channelMod.handleCallback({ commandId: 'ghost', phase: 'result', ok: true })).toBe(false);
  });
});
