'use strict';
/**
 * ws.cjs — 极简 RFC6455 服务端 WebSocket 助手（零依赖，Node http server 'upgrade' 用）。
 * T1-091：给 /run/events 提供真实推送通道——server → client 文本帧（事件 JSON 行），
 * 前端 createApiClient.stream('/run/events') 建立的 WebSocket 由此接收。
 *
 * 只实现本场景必需：握手接受 + 服务端发送文本帧 + 识别客户端关闭/心跳。不做分片重组、
 * 不做服务端掩码（RFC6455 服务端→客户端禁止掩码）。客户端除 close 外基本不发数据（单向事件流），
 * 故对上行帧只做最轻解析：close(opcode 8) → 关；ping(9) → 回 pong(10)。导出纯函数供单测。
 *
 * 为什么「这种最小集」够用：本通道是**单向事件推送**——客户端只订阅、不发送业务数据，
 * 因此无需实现掩码解码/分片重组/扩展协商这些「下行复杂、上行为主」的浏览器才需要的能力。
 * 一旦将来要支持客户端上传（如控制指令），必须补齐掩码解码与分片逻辑，不能沿用本文件。
 *
 * 可测性：acceptKey / encodeFrame / parseFrameHeader 都是纯函数（输入→输出，无 socket 副作用），
 * 单测直接喂字节即可验证；只有 upgrade 触碰 socket。
 */

const crypto = require('crypto');

// RFC6455 固定魔术串：握手 accept 由 key + 本 GUID 做 SHA1 得来，写错客户端会拒绝握手
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** Sec-WebSocket-Accept = base64(sha1(key + GUID))（RFC 向量可验证） */
function acceptKey(secWebSocketKey) {
  return crypto.createHash('sha1').update(String(secWebSocketKey || '') + WS_GUID).digest('base64');
}

/**
 * 编码一帧（服务端 → 客户端；不掩码）。payload: string|Buffer
 * 首字节 = 0x80|opcode（0x80 置 FIN 位，本实现永不发分片帧）；
 * 载荷长度按 RFC6455 分三档编码：<126 直接写 1 字节；≤0xffff 用 126 + 2 字节 BE；否则 127 + 8 字节 BE。
 */
function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, body]);
}

/** 编码文本帧（事件推送用）；事件 JSON 一律走文本帧 */
function encodeTextFrame(str) {
  return encodeFrame(OP_TEXT, str);
}

/**
 * 解析客户端上行帧首帧头（不消费多帧）。返回 { opcode, masked, payloadLen, headerLen }；
 * 数据不足返回 null。
 * headerLen 已含掩码密钥的 4 字节（masked 时）——调用方可据此直接定位载荷起点。
 * 注意：本函数不做掩码解码，需要载荷原文时由调用方自行 slice + 解掩码（本场景只用 ping 的 echo，尽力而为）。
 */
function parseFrameHeader(buf) {
  if (!buf || buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let headerLen = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    headerLen = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    headerLen = 10;
  }
  headerLen += masked ? 4 : 0;
  return { opcode, masked, payloadLen: len, headerLen };
}

/**
 * 握手接受 + 挂接生命周期。调用方在调用前应完成路由/就绪校验；握手失败会 destroy socket。
 * 生命周期契约：握手成功后挂 data/end/close/error 监听；关闭或出错时**恰好调用一次**
 * onClose/onError（cleanup 用 done 标志去重，因为 end/close/error 可能相继触发）。
 * @param {object} req  http.IncomingMessage（upgrade 事件）
 * @param {object} socket net.Socket
 * @param {{ onClose?: Function, onError?: Function }} opts
 */
function upgrade(req, socket, { onClose, onError } = {}) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { try { socket.destroy(); } catch { /* ignore */ } return; } // 非 WS 升级 → 直接断开
  const accept = acceptKey(key);
  try {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  } catch { try { socket.destroy(); } catch { /* ignore */ } return; }

  let done = false;
  // 幂等清理：去掉全部监听并回调 onClose 一次（end/close/error 任一先到都只结算一次）
  const cleanup = () => {
    if (done) return;
    done = true;
    socket.removeListener('data', onData);
    socket.removeListener('end', cleanup);
    socket.removeListener('close', cleanup);
    socket.removeListener('error', onSocketError);
    try { onClose?.(); } catch { /* ignore */ }
  };
  const onSocketError = () => { try { onError?.(); } catch { /* ignore */ } cleanup(); };
  function onData(chunk) {
    const h = parseFrameHeader(chunk);
    if (!h || chunk.length < h.headerLen) return; // 头都不完整 → 丢弃（本场景不做缓冲重组）
    const opcode = h.opcode;
    if (opcode === OP_CLOSE) { try { socket.end(); } catch { /* ignore */ } return; }
    if (opcode === OP_PING) {
      // 回 pong（echo 载荷；本通道客户端不发 payload，尽力）
      // 注：这里只按 headerLen 取载荷，未按 RFC 解客户端掩码 —— 客户端几乎不 ping，故不做完整实现
      const payload = chunk.slice(h.headerLen, h.headerLen + h.payloadLen);
      try { socket.write(encodeFrame(OP_PONG, payload)); } catch { /* ignore */ }
    }
    // 其余（text/pong/continuation）单向上行无需处理
  }
  socket.on('data', onData);
  socket.once('end', () => { try { socket.end(); } catch { /* 已关闭 */ } }); // 客户端半关 → 回 FIN 完成关闭
  socket.once('end', cleanup);
  socket.once('close', cleanup);
  socket.once('error', onSocketError);
}

module.exports = { WS_GUID, OP_TEXT, OP_CLOSE, OP_PING, OP_PONG, acceptKey, encodeFrame, encodeTextFrame, parseFrameHeader, upgrade };
