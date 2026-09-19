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

  // 真机踩到：重启 dsh 后台 → 新插件连上，**旧 socket 的 close 迟到** →
  // 服务端把正连着的通道误判为断开，此后所有指令都回「ws closed」，而插件侧一切正常。
  it('重连后旧 socket 的迟到 close 不改判定（身份不符 → 忽略）', async () => {
    const oldSocket = makeSocket();
    const newSocket = makeSocket();
    channelMod.attachSocket(oldSocket, { platform: 'dsh', pluginVersion: '0.0.1' });
    channelMod.attachSocket(newSocket, { platform: 'dsh', pluginVersion: '0.0.1' });

    // 旧 socket 的 close 迟到：必须被忽略
    expect(channelMod.detachSocket('ws closed', oldSocket)).toBe(false);
    expect(channelMod.channel().connected()).toBe(true);
    const p = channelMod.channel().request('session.facts', {}, { projectRoot: '/p' });
    expect(newSocket.frames).toHaveLength(1);
    const cmd = decodeFrame(newSocket.frames[0]);
    channelMod.handleCallback({ commandId: cmd.commandId, phase: 'accepted' });
    channelMod.handleCallback({ commandId: cmd.commandId, phase: 'result', ok: true, result: { sessionExists: false } });
    const r = await p;
    expect(r.delivery).toBe('accepted');

    // 当前 socket 自己断开 → 照常 detach（并给出来由）
    expect(channelMod.detachSocket('ws closed', newSocket)).toBe(true);
    expect(channelMod.channel().connected()).toBe(false);
    expect(channelMod.channel().detachedReason()).toContain('ws closed');
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

/**
 * `closeSocket()` —— server 关停时必须显式关掉插件的 WS。
 *
 * 守卫的是一个真机踩到过的僵尸进程：WS 是 `upgrade` 上来的 socket，**不在 http server 的连接表里**，
 * `server.closeAllConnections()` 管不到它 → `server.close(cb)` 回调不触发 → 空闲回收的
 * `stop().then(exit)` 不执行 → 进程不再 listen 却活着，插件还连着它。
 * 表现极具迷惑性：`awf plan` 报「指令通道未连接」，而 `awf server start` 说「已在运行」，
 * 因为 8787 上确实是另一个（新）server 在 listen。
 */
describe('closeSocket — server 关停时关掉插件连接（防僵尸进程）', () => {
  function socketWithDestroy() {
    const s = makeSocket();
    s.destroyedCount = 0;
    s.destroy = () => { s.destroyedCount += 1; s.destroyed = true; s.writable = false; };
    return s;
  }

  it('有连接时：destroy socket，返回 true', () => {
    const s = socketWithDestroy();
    channelMod.attachSocket(s, { platform: 'dsh' });
    expect(channelMod.closeSocket()).toBe(true);
    expect(s.destroyedCount).toBe(1);
  });

  it('没有连接时：返回 false，不抛（关停路径不该因为「本来就没连」失败）', () => {
    channelMod.reset();
    expect(channelMod.closeSocket()).toBe(false);
  });

  it('关掉之后指令判「未交给平台」并带上原因（不假装发出去了）', async () => {
    const s = socketWithDestroy();
    channelMod.attachSocket(s, { platform: 'dsh' });
    channelMod.closeSocket();
    const r = await channelMod.channel().request('session.facts', {});
    expect(r.delivery).toBe('not-delivered');
    expect(r.error).toContain('指令通道未连接');
  });
});
