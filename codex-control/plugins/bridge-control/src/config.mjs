import fs from 'node:fs';
import path from 'node:path';

import { loadIntegrationConfig } from './integration-config.mjs';

function required(name, value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function readSecret(filePath, name) {
  if (!filePath) return null;
  try {
    const value = fs.readFileSync(path.resolve(filePath), 'utf8').trim();
    if (!value) throw new Error('file is empty');
    return value;
  } catch (error) {
    throw new Error(`${name} cannot be read: ${error.message}`);
  }
}

function url(value) {
  let parsed;
  try {
    parsed = new URL(required('BRIDGE_CONTROL_CMB_BASE_URL', value));
  } catch (error) {
    throw new Error(`BRIDGE_CONTROL_CMB_BASE_URL is invalid: ${error.message}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('BRIDGE_CONTROL_CMB_BASE_URL must be a credential-free HTTP(S) URL');
  }
  return parsed.href.replace(/\/$/, '');
}

export function loadControlConfig(env = process.env) {
  const dataDir = path.resolve(env.BRIDGE_CONTROL_DATA_DIR || path.resolve(import.meta.dirname, '..', '.local'));
  const password = env.BRIDGE_CONTROL_CMB_PASSWORD
    || readSecret(env.BRIDGE_CONTROL_CMB_PASSWORD_FILE, 'BRIDGE_CONTROL_CMB_PASSWORD_FILE');
  const integrationConfig = env.BRIDGE_CONTROL_INTEGRATION_CONFIG
    ? loadIntegrationConfig(env.BRIDGE_CONTROL_INTEGRATION_CONFIG)
    : null;
  return {
    cmb: {
      baseUrl: url(env.BRIDGE_CONTROL_CMB_BASE_URL),
      username: required('BRIDGE_CONTROL_CMB_USERNAME', env.BRIDGE_CONTROL_CMB_USERNAME),
      password: required('BRIDGE_CONTROL_CMB_PASSWORD or BRIDGE_CONTROL_CMB_PASSWORD_FILE', password),
      timeoutMs: Math.max(1000, Math.min(600000, Number(env.BRIDGE_CONTROL_CMB_TIMEOUT_MS) || 120000)),
    },
    dataDir,
    workspace: integrationConfig?.workspace || null,
    eventDir: integrationConfig ? null : (env.CODEX_CONTROL_EVENT_DIR || null),
    taskEvents: integrationConfig?.eventFiles.taskEvents || null,
  };
}
