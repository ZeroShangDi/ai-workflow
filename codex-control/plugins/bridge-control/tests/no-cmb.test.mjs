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

test('production control code has no concrete CMB import', () => {
  const files = [...productionSources(path.join(plugin, 'src')), path.join(plugin, 'server.mjs')];
  const importedCmb = files.filter((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return /import\s+[^;]*\bcmb\b|import\s*\([^)]*\bcmb\b/i.test(source);
  });
  assert.deepEqual(importedCmb, []);
  assert.equal(fs.existsSync(path.join(plugin, 'src', 'adapters', 'cmb.mjs')), false);
});

test('Codex marketplace metadata does not expose the internal MCP server globally', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(plugin, '.codex-plugin', 'plugin.json'),
    'utf8',
  ));
  assert.equal(manifest.mcpServers, undefined);
});
