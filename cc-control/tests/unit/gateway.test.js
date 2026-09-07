import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GATEWAY = path.resolve(fileURLToPath(new URL('../..', import.meta.url)), 'plugin', 'core', 'hooks', 'gateway.cjs');

/** 起一个返回 respond(event, body) 的 JSON 的 stub server，返回 { port, close } */
function startServer(respond) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const event = new URL(req.url, 'http://x').searchParams.get('event');
        const out = respond(event, body);
        res.setHeader('content-type', 'application/json');
        res.end(typeof out === 'string' ? out : JSON.stringify(out));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) }));
  });
}

/** 拿一个已释放的空闲端口（起即关），用于「server 不可达」分支 */
function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** 派发一次 gateway，返回 { code, stdout, stderr } */
function runGateway(port, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GATEWAY, String(port)]);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify(payload));
  });
}

describe('gateway — 输出协议（server 响应 → stdout）', () => {
  it('响应含 ccOutput → stdout 恰为 JSON.stringify(ccOutput)，exit 0', async () => {
    const ccOutput = { decision: 'block', reason: '决策闸门：请产出 Decision Result' };
    const srv = await startServer(() => ({ ccOutput }));
    try {
      const r = await runGateway(srv.port, { hook_event_name: 'Stop' });
      expect(r.code).toBe(0);
      expect(r.out).toBe(JSON.stringify(ccOutput));
      expect(r.err).toBe('');
    } finally {
      await srv.close();
    }
  });

  it('响应无 ccOutput（如 { ok: true }）→ stdout 空、exit 0', async () => {
    const srv = await startServer(() => ({ ok: true }));
    try {
      const r = await runGateway(srv.port, { hook_event_name: 'Stop' });
      expect(r.code).toBe(0);
      expect(r.out).toBe('');
    } finally {
      await srv.close();
    }
  });

  it('响应非 JSON → 视为无 ccOutput：stdout 空、exit 0', async () => {
    const srv = await startServer(() => 'not-json');
    try {
      const r = await runGateway(srv.port, { hook_event_name: 'Stop' });
      expect(r.code).toBe(0);
      expect(r.out).toBe('');
    } finally {
      await srv.close();
    }
  });

  it('server 不可达（连接失败）→ stdout 空、exit 0', async () => {
    const port = await freePort();
    const r = await runGateway(port, { hook_event_name: 'Stop' });
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
  });

  it('payload 无 hook_event_name → 不发请求、直接 exit 0 空输出', async () => {
    const srv = await startServer(() => { throw new Error('不应收到请求'); });
    try {
      const r = await runGateway(srv.port, { foo: 'bar' });
      expect(r.code).toBe(0);
      expect(r.out).toBe('');
    } finally {
      await srv.close();
    }
  });
});
