import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';

const plugin = path.resolve(import.meta.dirname, '..');

async function listedTools(args) {
  const env = { ...process.env };
  delete env.BRIDGE_CONTROL_PROFILE;
  delete env.BRIDGE_CONTROL_DEV;
  env.BRIDGE_CONTROL_WS_ENABLED = '0';
  const child = spawn(process.execPath, ['server.mjs', ...args], {
    cwd: plugin,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const messages = [];
  lines.on('line', (line) => messages.push(JSON.parse(line)));
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  const deadline = Date.now() + 5000;
  while (messages.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  child.kill();
  assert.equal(messages.length, 2);
  return messages[1].result.tools.map((tool) => tool.name);
}

test('default MCP profile exposes only work reporting tools', async () => {
  const names = await listedTools([]);
  assert.deepEqual(names, [
    'bridge_chat_emit_progress',
    'bridge_chat_request_input',
    'bridge_chat_request_approval',
    'bridge_chat_publish_artifact',
    'bridge_chat_finish',
  ]);
});

test('voice MCP profile adds legacy bridge_chat only in explicit dev mode', async () => {
  const voice = await listedTools(['--profile', 'voice-controller']);
  const dev = await listedTools(['--profile', 'voice-controller', '--dev']);
  assert.equal(voice.includes('bridge_chat'), false);
  assert.equal(dev.includes('bridge_chat'), true);
  assert.equal(voice.includes('bridge_chat_ack'), false);
});
