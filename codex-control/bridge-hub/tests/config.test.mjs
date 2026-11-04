import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { loadConfig, validateHubConfig } from '../src/config.mjs';
import { temporaryDirectory } from './helpers.mjs';

test('config reads a private password file without accepting credentials in the URL', async (t) => {
  const directory = await temporaryDirectory(t);
  await fs.writeFile(path.join(directory, 'password.txt'), 'file-secret\n', { mode: 0o600 });
  const config = loadConfig({
    cwd: directory,
    env: {
      BRIDGE_HUB_CMB_BASE_URL: 'http://127.0.0.1:8765',
      BRIDGE_HUB_CMB_USERNAME: 'admin',
      BRIDGE_HUB_CMB_PASSWORD_FILE: 'password.txt',
      BRIDGE_HUB_DATA_DIR: 'data',
    },
  });
  assert.equal(config.cmb.password, 'file-secret');
  assert.equal(config.dataDir, path.join(directory, 'data'));
  validateHubConfig(config);

  await assert.rejects(
    async () => loadConfig({
      cwd: directory,
      env: {
        BRIDGE_HUB_CMB_BASE_URL: 'http://user:secret@127.0.0.1:8765',
        BRIDGE_HUB_CMB_USERNAME: 'admin',
        BRIDGE_HUB_CMB_PASSWORD: 'secret',
      },
    }),
    (error) => error.code === 'config_invalid',
  );
});
