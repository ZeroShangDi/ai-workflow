'use strict';
/**
 * bridge-channel.cjs — DSH 指令通道的**传输侧**（AWF 的 WS 服务端 + HTTP 回传入口）
 *
 * 依据 spec §2：AWF→插件走独立 WS（指令下行），插件→AWF 走 HTTP POST（确认/结果/事件上行）。
 * 本文件把 `adapters/dsh/bridge.cjs` 的「传输无关通道」接到真实 socket 与 HTTP 面上：
 *   - WS：`/bridge/dsh` 升级成功 = 插件已连接 → `attachSocket()`（通道转 connected）
 *   - HTTP：`POST /bridge/dsh/callback` → `handleCallback(body)`（accepted/result/event 分发）
 *
 * **单实例**：一个 AWF server 进程对一个 DSH 全局后台（spec §2「DSH 后台全局单实例」），
 * 故这里是进程级单例；指令里带 `projectRoot` 由插件侧路由到项目，不按项目分通道。
 *
 * 边界（明确不做）：
 *   - 不自动重连、不重发在途指令（spec §5：连接恢复 ≠ 任务恢复）；断开即 `detach`，在途指令判「无法确认」。
 *   - 不做鉴权之外的业务判断：本通道只搬指令与回报。
 */

const { createDshBridge } = require('../adapters/dsh/bridge.cjs');
const { encodeTextFrame } = require('./ws.cjs');

/** 当前连接的插件 socket（未连接时 null） */
let pluginSocket = null;
/** 进程级通道单例 */
let bridge = null;

/** 取（惰性建）通道单例 */
function channel() {
  if (!bridge) {
    bridge = createDshBridge({
      send: (command) => {
        if (!pluginSocket || pluginSocket.destroyed || pluginSocket.writable === false) {
          // 抛错 → 通道判 not-delivered（未交给平台），不是静默丢帧
          throw new Error('DSH 插件未连接（无可用 WS 通道）');
        }
        pluginSocket.write(encodeTextFrame(JSON.stringify(command)));
      },
    });
  }
  return bridge;
}

/**
 * WS 升级成功：登记 socket 并把通道置为已连接。
 * @param {object} socket net.Socket
 * @param {{platform?: string, pluginVersion?: string}} [meta] 握手事实（对接的是哪一版插件，spec §6 原则）
 */
function attachSocket(socket, meta = { platform: 'dsh' }) {
  pluginSocket = socket;
  channel().attach(meta);
}

/**
 * WS 断开：清 socket + detach 通道（在途指令判「无法确认」，现场保留）。
 * @param {string} [reason]
 */
function detachSocket(reason = 'ws closed') {
  pluginSocket = null;
  channel().detach(reason);
}

/**
 * 插件回传入口（HTTP POST body）。
 * @param {object} payload `{commandId, phase, ok, result, error}` 或 `{kind:'event', event, facts}`
 * @returns {boolean} 是否被通道消费（false → 调用方记日志，不假装成功）
 */
function handleCallback(payload) {
  return channel().onCallback(payload);
}

/** 当前通道句柄（api/诊断用；注意是单例） */
function current() {
  return channel();
}

/** 复位（测试 / server 关闭）：断开并丢弃单例 */
function reset() {
  if (bridge) bridge.detach('reset');
  bridge = null;
  pluginSocket = null;
}

module.exports = { channel, current, attachSocket, detachSocket, handleCallback, reset };
