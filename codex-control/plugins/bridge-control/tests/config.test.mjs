import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { configPath, loadConfig, passwordFor, publicConfig, saveConfig } from '../src/config.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-control-config-'));
process.env.CODEX_HOME = root;

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('writes private configuration and keeps the password separate', () => {
  const passwordFile = path.join(root, 'login.txt');
  fs.writeFileSync(passwordFile, '账号：admin\n密码：test-only-password\n', { mode: 0o600 });
  const saved = saveConfig({
    software: 'cmb',
    baseUrl: 'http://127.0.0.1:18787',
    username: 'admin',
    passwordFile,
    defaultProject: 'cc-control',
  });
  assert.equal(saved.hasPassword, true);
  assert.equal(saved.passwordFile, passwordFile);
  assert.equal(fs.statSync(configPath()).mode & 0o077, 0);
  assert.equal(passwordFor(loadConfig()), 'test-only-password');
  assert.equal(JSON.stringify(saveConfig({})).includes('test-only-password'), false);
});

test('rejects unknown settings and URL paths', () => {
  assert.throws(() => saveConfig({ unexpected: true }), /Unknown configuration keys/);
  assert.throws(() => saveConfig({ baseUrl: 'http://127.0.0.1:18787/api' }), /cannot contain a path/);
});

test('public configuration masks password material', () => {
  const value = publicConfig(loadConfig());
  assert.equal(Object.hasOwn(value, 'password'), false);
  assert.equal(value.hasPassword, true);
});
