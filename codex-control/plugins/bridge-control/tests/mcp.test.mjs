import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';

const plugin = path.resolve(import.meta.dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-control-mcp-'));

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function ask(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

test('advertises the adapter-based tools over MCP stdio', async () => {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: plugin,
    env: { ...process.env, CODEX_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const messages = [];
  lines.on('line', (line) => messages.push(JSON.parse(line)));
  ask(child, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });
  ask(child, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  ask(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const deadline = Date.now() + 5000;
  while (messages.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  child.kill();
  assert.equal(messages[0].result.serverInfo.name, 'bridge-control');
  assert.deepEqual(
    messages[1].result.tools.map((tool) => tool.name),
    ['bridge_status', 'bridge_configure', 'bridge_projects', 'bridge_sessions', 'bridge_chat'],
  );
});
