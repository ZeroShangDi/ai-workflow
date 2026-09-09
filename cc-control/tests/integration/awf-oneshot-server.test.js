import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// T1-080：awf-oneshot 经 server /oneshot（env AWF_BASE 提供时 MCP 不再直连 spawn claude -p）。
// 用 mock HTTP server 验证 MCP→server 管线（真实 claude 只存在于 server oneshot adapter）。

const MCP_PATH = fileURLToPath(new URL('../../plugin/core/mcp/awf-oneshot/server.cjs', import.meta.url));

let srv;
let base;
const hits = [];

beforeAll(async () => {
  srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ url: req.url, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, text: 'server-oneshot-ok' }));
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  base = `http://127.0.0.1:${port}`;
  process.env.AWF_BASE = base;
});

afterAll(async () => {
  delete process.env.AWF_BASE;
  await new Promise((resolve) => srv.close(resolve));
});

describe('awf-oneshot 经 server（T1-080）', () => {
  it('AWF_BASE 提供 → awf_oneshot 走 server /oneshot（不 spawn 本地 claude）', async () => {
    const mod = await import(MCP_PATH);
    const result = await mod.handlers['tools/call']({ name: 'awf_oneshot', arguments: { prompt: '你好' } });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.text).toBe('server-oneshot-ok'); // 来自 server，而非本地 spawn
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe('/oneshot');
    expect(hits[0].body.prompt).toBe('你好');
  });
});
