#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const targets = [
  'plugins/voice-control',
  'plugins/bridge-control/src',
  'plugins/bridge-control/profiles',
  'bridge-hub',
];
const ignored = new Set(['node_modules', '.git', '.venv', 'dist', 'coverage', 'prototype']);
const failures = [];

function files(directory, output = []) {
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files(absolute, output);
    else if (/\.(?:mjs|cjs|js|ts|tsx|jsx)$/.test(entry.name)) output.push(absolute);
  }
  return output;
}

function imports(file) {
  const source = fs.readFileSync(file, 'utf8');
  const values = [];
  const pattern = /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = pattern.exec(source))) values.push(match[1]);
  return values;
}

function check(scope, forbidden) {
  const directory = path.join(root, scope);
  for (const file of files(directory)) {
    for (const specifier of imports(file)) {
      if (forbidden.some((value) => specifier.includes(value))) {
        failures.push(`${path.relative(root, file)} imports forbidden dependency ${specifier}`);
      }
    }
  }
}

check('plugins/voice-control', [
  'bridge-hub',
  'bridge-control',
  'codex-mobile-bridge',
]);
check('plugins/bridge-control/src', [
  'codex-mobile-bridge/bridge',
  '/bridge/api/',
  'bridge-hub/',
  'voice-control',
]);
check('plugins/bridge-control/profiles', [
  'codex-mobile-bridge/bridge',
  '/bridge/api/',
  'bridge-hub/',
  'voice-control',
]);
check('bridge-hub', [
  '../../plugins/voice-control',
  '../plugins/voice-control',
  'codex-mobile-bridge/bridge',
  '/bridge/api/',
]);

const submodule = path.join(root, 'codex-mobile-bridge');
if (fs.existsSync(path.join(submodule, '.git'))) {
  const status = execFileSync('git', ['-C', submodule, 'status', '--porcelain'], {
    encoding: 'utf8',
  }).trim();
  if (status) failures.push('codex-mobile-bridge submodule is not clean');
}

if (failures.length) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exitCode = 1;
} else {
  if (fs.existsSync(path.join(submodule, '.git'))) {
    console.log('Dependency boundaries are valid; CMB submodule is clean.');
  } else {
    console.log('Dependency boundaries are valid; CMB submodule is not initialized (source isolation checked statically).');
  }
}
