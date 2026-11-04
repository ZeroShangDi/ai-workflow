import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('MCP exposes character list and select tools', async () => {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => messages.push(JSON.parse(line)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bridge_chat_character_list', arguments: {} } })}\n`);
  const deadline = Date.now() + 5000;
  while (messages.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  child.kill();
  assert.deepEqual(messages[1].result.tools.map((tool) => tool.name), [
    'bridge_chat_character_list',
    'bridge_chat_character_select',
  ]);
  assert.equal(messages[2].result.structuredContent.defaultId, 'elf-3');
  assert.equal(messages[2].result.structuredContent.characters.length, 2);
});
