#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const projects = [
  'plugins/voice-control',
  'plugins/voice-center',
  'plugins/character-settings',
  'plugins/bridge-control',
  'bridge-hub',
];

for (const project of projects) {
  const directory = path.join(root, project);
  const manifest = path.join(directory, 'package.json');
  if (!fs.existsSync(manifest)) {
    console.error(`✗ ${project}: package.json is missing`);
    process.exitCode = 1;
    continue;
  }
  console.log(`\n== ${project} ==`);
  const result = spawnSync('npm', ['test'], {
    cwd: directory,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) process.exitCode = 1;
}

console.log('\n== integration ==');
const integrationFiles = fs.readdirSync(path.join(root, 'integration'))
  .filter((name) => name.endsWith('.test.mjs'))
  .map((name) => path.join('integration', name));
const integration = spawnSync(process.execPath, ['--test', ...integrationFiles], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
if (integration.status !== 0) process.exitCode = 1;
