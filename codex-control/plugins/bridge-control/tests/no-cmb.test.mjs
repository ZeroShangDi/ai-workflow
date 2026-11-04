import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const plugin = path.resolve(import.meta.dirname, '..');

function productionSources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(fullPath);
    if (entry.isFile() && entry.name.endsWith('.mjs')) return [fullPath];
    return [];
  });
}

test('production control code directly depends on CMB and does not depend on bridge-hub', () => {
  const files = [...productionSources(path.join(plugin, 'src')), path.join(plugin, 'server.mjs')];
  const source = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.match(source, /cmb-client\.mjs/);
  const forbidden = files.filter((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return /bridge-hub|hub-loader|hub-client|BRIDGE_CONTROL_HUB_MODULE/.test(source);
  });
  assert.deepEqual(forbidden, []);
});

test('Codex marketplace metadata does not expose the internal MCP server globally', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(plugin, '.codex-plugin', 'plugin.json'),
    'utf8',
  ));
  assert.equal(manifest.mcpServers, undefined);
});
