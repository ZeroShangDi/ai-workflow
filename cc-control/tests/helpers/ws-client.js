// tests/helpers/ws-client.js — Node20 测试用最小 WebSocket 客户端（对端 src/server/ws.cjs）。
// 做握手 + 收服务端文本帧（不掩码）+ 收尾 close。Node20 无全局 WebSocket，这里用 raw net 实现。

import net from 'node:net';
import crypto from 'node:crypto';

function decodeServerFrames(buf, onText, onClose) {
  let off = 0;
  while (off + 2 <= buf.length) {
    const opcode = buf[off] & 0x0f;
    const len7 = buf[off + 1] & 0x7f;
    let len;
    let headerLen = 2;
    if (len7 === 126) {
      if (off + 4 > buf.length) break;
      len = buf.readUInt16BE(off + 2);
      headerLen = 4;
    } else if (len7 === 127) {
      if (off + 10 > buf.length) break;
      len = Number(buf.readBigUInt64BE(off + 2));
      headerLen = 10;
    } else {
      len = len7;
    }
    if (off + headerLen + len > buf.length) break;
    const payload = buf.subarray(off + headerLen, off + headerLen + len);
    if (opcode === 0x1) onText(payload.toString('utf8'));
    else if (opcode === 0x8) { onClose(); return buf.subarray(off + headerLen + len); }
    off += headerLen + len;
  }
  return buf.subarray(off);
}

/**
 * 打开 WS 并返回推送客户端。
 * @param {{ port: number, path?: string, timeoutMs?: number }} opts
 * @returns {Promise<{ messages: string[], waitFor(fn, ms), close(): Promise<void> }>}
 */
export function openWsClient({ port, path = '/run/events', timeoutMs = 3000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const messages = [];
    let closed = false;
    let buffer = Buffer.alloc(0);
    let handshakeDone = false;
    let handshakeText = '';
    let settled = false;

    const key = crypto.randomBytes(16).toString('base64');

    const fail = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* ignore */ }
      reject(new Error(msg));
    };

    const timer = setTimeout(() => fail('ws 连接超时'), timeoutMs);

    socket.on('connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n`
        + 'Host: 127.0.0.1\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${key}\r\n`
        + 'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });

    socket.on('data', (chunk) => {
      if (!handshakeDone) {
        handshakeText += chunk.toString('latin1');
        const idx = handshakeText.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = handshakeText.slice(0, idx);
        const statusLine = head.split('\r\n')[0];
        buffer = Buffer.from(handshakeText.slice(idx + 4), 'latin1');
        handshakeDone = true;
        if (!/^HTTP\/1\.[01] 101\b/.test(statusLine)) {
          return fail(`ws 握手失败: ${statusLine}`);
        }
        // 握手后残余 buffer 里可能已有帧
        buffer = decodeServerFrames(buffer, (t) => messages.push(t), onServerClose);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(api);
        return;
      }
      buffer = decodeServerFrames(Buffer.concat([buffer, chunk]), (t) => messages.push(t), onServerClose);
    });
    socket.on('close', () => { closed = true; if (!handshakeDone) fail('ws 握手失败：连接被服务端关闭'); });
    socket.on('error', () => { closed = true; if (!handshakeDone) fail('ws 连接错误'); });

    function onServerClose() {
      try { socket.end(); } catch { /* ignore */ }
    }

    const api = {
      messages,
      get closed() { return closed; },
      /** 轮询等待谓词命中（谓词在 messages 上求值；谓词抛错 → reject） */
      waitFor(predicate, ms = 3000) {
        return new Promise((resolveWait, rejectWait) => {
          const t0 = Date.now();
          const tick = () => {
            try {
              if (predicate(messages)) return resolveWait(true);
            } catch (e) { return rejectWait(e); }
            if (Date.now() - t0 >= ms || closed) return rejectWait(new Error('ws waitFor 超时或已关闭'));
            setTimeout(tick, 10);
          };
          tick();
        });
      },
      /** 关闭连接（不等服务端回 FIN；超时兜底 destroy，避免测试悬挂） */
      close() {
        try { socket.end(); } catch { /* ignore */ }
        return new Promise((r) => {
          const to = setTimeout(() => { try { socket.destroy(); } catch { /* ignore */ } r(); }, 1500);
          socket.once('close', () => { clearTimeout(to); r(); });
        });
      },
    };
  });
}
