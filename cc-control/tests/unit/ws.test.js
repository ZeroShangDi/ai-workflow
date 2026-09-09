import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ws = require('../../src/server/ws.cjs');

// T1-091：极简 RFC6455 服务端助手（握手 accept / 文本帧编码 / 上行帧解析）纯函数单测。

describe('ws 助手', () => {
  it('acceptKey：RFC6455 官方向量', () => {
    expect(ws.acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('encodeTextFrame：0x81 起始，短载荷长度直接编码，payload 原样', () => {
    const buf = ws.encodeTextFrame('hello');
    expect(buf[0]).toBe(0x81); // FIN + text opcode
    expect(buf[1]).toBe(5); // 短载荷长度
    expect(buf.subarray(2).toString()).toBe('hello');
  });

  it('encodeFrame 长度边界：126 段（<=65535 两字节大端）', () => {
    const payload = 'a'.repeat(200);
    const buf = ws.encodeFrame(ws.OP_TEXT, payload);
    expect(buf[0]).toBe(0x81);
    expect(buf[1]).toBe(126);
    expect(buf.readUInt16BE(2)).toBe(200);
    expect(buf.subarray(4).toString()).toBe(payload);
  });

  it('encodeFrame 127 段（>65535 八字节大端）', () => {
    const payload = Buffer.alloc(70_000, 0x61);
    const buf = ws.encodeFrame(ws.OP_TEXT, payload);
    expect(buf[1]).toBe(127);
    expect(Number(buf.readBigUInt64BE(2))).toBe(70_000);
    expect(buf.length).toBe(10 + 70_000);
  });

  it('parseFrameHeader：识别客户端 masked close 帧与长度', () => {
    // 客户端 close（掩码）: FIN|opcode8, MASK|len2, maskkey 4B → header 6B + payload(close code) 2B
    const close = Buffer.from([0x88, 0x82, 0x11, 0x22, 0x33, 0x44, 0x00, 0x03]);
    const h = ws.parseFrameHeader(close);
    expect(h.opcode).toBe(8);
    expect(h.masked).toBe(true);
    expect(h.payloadLen).toBe(2);
    expect(h.headerLen).toBe(6); // 2(基础) + 4(mask key)
    expect(ws.parseFrameHeader(Buffer.alloc(1))).toBe(null); // 不足
  });
});
