import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

function filesBelow(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  });
}

test('runtime, SDK, and web sources never import Hub, Control, or CMB', () => {
  const files = [
    ...filesBelow(path.join(root, 'src')),
    ...filesBelow(path.join(root, 'sdk')),
    ...filesBelow(path.join(root, 'web')),
  ].filter((file) => /\.(?:mjs|js)$/.test(file));
  const specifier = /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  const forbidden = /bridge-hub|bridge-control|codex-mobile-bridge|ai-market/;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(specifier)) {
      const imported = match[1] || match[2];
      assert.doesNotMatch(imported, forbidden, `${path.relative(root, file)} imports ${imported}`);
    }
  }
});

test('the first slice has no task-control capability or runtime dependencies', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
  const packageValue = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.capabilities.taskControl, false);
  assert.equal(manifest.capabilities.externalTriggers.default, 'disabled');
  assert.equal(packageValue.dependencies, undefined);
  assert.deepEqual(packageValue.devDependencies, { ws: '^8.22.1' });
});
