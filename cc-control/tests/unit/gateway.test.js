import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
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

/** 起一个**固定状态码**的 stub server（测非 2xx 的留痕路径） */
function startServerWithStatus(status, body) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
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

/** 派发一次 gateway，返回 { code, stdout, stderr }。
 *  默认**不带任何 CC_* 环境**：否则在 awf run 会话里跑测试时会命中「run 会话才留痕」那条分支，
 *  测试结论就随运行环境变化（这正是 2026-09-10「测试不密闭」踩过的坑）。 */
function runGateway(port, payload, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GATEWAY, String(port)], {
      env: { PATH: process.env.PATH, ...extraEnv },
    });
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

describe('gateway — 失败留痕（issue 009）', () => {
  const tmpProject = () => fs.mkdtempSync(path.join(os.tmpdir(), 'awf-gw-'));

  it('run 会话内投递失败 → stderr 与项目日志各留一行，且仍 exit 0（不阻断会话）', async () => {
    const port = await freePort();
    const project = tmpProject();
    try {
      const r = await runGateway(port, { hook_event_name: 'SessionStart' },
        { CC_SESSION: 'cc-test', CC_AWF_STATE_SERVER: '1', CC_PROJECT: project });
      expect(r.code).toBe(0);
      expect(r.out).toBe('');
      expect(r.err).toContain('投递失败');
      const log = fs.readFileSync(path.join(project, '.awf', 'logs', 'hook-gateway.log'), 'utf8');
      expect(log).toContain('SessionStart');
      expect(log).toContain('投递失败');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('run 会话内缺 CC_PROJECT → 明确提示「会被 server 400 丢弃」', async () => {
    const port = await freePort();
    const project = tmpProject();
    try {
      const r = await runGateway(port, { hook_event_name: 'Stop' }, { CC_SESSION: 'cc-test', CC_WORKDIR: project });
      expect(r.code).toBe(0);
      expect(r.err).toContain('CC_PROJECT 缺失');
      expect(r.err).toContain('400');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('server 拒绝（HTTP 400）→ 记下状态码与响应体片段', async () => {
    const srv = await startServerWithStatus(400, { ok: false, error: '写类端点缺 ?p：拒绝兜底到 boot 项目' });
    const project = tmpProject();
    try {
      const r = await runGateway(srv.port, { hook_event_name: 'Stop' },
        { CC_SESSION: 'cc-test', CC_PROJECT: project });
      expect(r.code).toBe(0);
      expect(r.err).toContain('HTTP 400');
      expect(r.err).toContain('缺 ?p');
    } finally {
      await srv.close();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('run 会话内 SessionStart 投递成功 → 留一行「已投递」（hook 链建立的判据）', async () => {
    const srv = await startServer(() => ({ ok: true }));
    const project = tmpProject();
    try {
      const r = await runGateway(srv.port, { hook_event_name: 'SessionStart' },
        { CC_SESSION: 'cc-test', CC_AWF_STATE_SERVER: '1', CC_PROJECT: project });
      expect(r.code).toBe(0);
      expect(r.err).toContain('已投递');
    } finally {
      await srv.close();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('非 run 会话（普通交互会话）→ 完全不写 stderr，避免每次工具调用刷屏', async () => {
    const port = await freePort();
    const r = await runGateway(port, { hook_event_name: 'PostToolUse' });
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
  });
});
