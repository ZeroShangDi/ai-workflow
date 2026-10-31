import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('voice MCP exposes approved config load and update tools', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-mcp-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'settings.json');
  fs.copyFileSync(path.join(root, 'config', 'settings.json'), configPath);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => messages.push(JSON.parse(line)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'bridge_chat_voice_config_load',
      arguments: { configPath },
    },
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'bridge_chat_voice_config_update',
      arguments: {
        configPath,
        workspace: {
          path: '/tmp/voice-workspace',
          projectKey: 'local|voice-workspace',
          voiceSessionId: 'session-1',
          initialized: true,
        },
      },
    },
  })}\n`);
  const deadline = Date.now() + 5000;
  while (messages.length < 4 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  child.kill();
  assert.deepEqual(messages[1].result.tools.map((tool) => tool.name), [
    'bridge_chat_voice_config_load',
    'bridge_chat_voice_config_update',
  ]);
  assert.equal(messages[2].result.structuredContent.status, 'loaded');
  assert.equal(messages[2].result.structuredContent.plugins.control.profile, 'voice-controller');
  assert.equal(messages[3].result.structuredContent.status, 'updated');
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).workspace.voiceSessionId, 'session-1');
});
