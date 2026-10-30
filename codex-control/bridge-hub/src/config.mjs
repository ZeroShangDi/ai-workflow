import fs from 'node:fs';
import path from 'node:path';

import { HubError } from './errors.mjs';

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new HubError(500, 'config_invalid', `cannot read config file: ${filePath}`, {
      cause: error.message,
    });
  }
}

function readSecret(filePath, field) {
  try {
    const value = fs.readFileSync(filePath, 'utf8').trim();
    if (!value) throw new Error('file is empty');
    return value;
  } catch (error) {
    throw new HubError(500, 'config_invalid', `cannot read ${field}`, {
      cause: error.message,
    });
  }
}

function normalizeBaseUrl(value, field, { optional = false } = {}) {
  if (!value && optional) return null;
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new HubError(500, 'config_invalid', `${field} must be an absolute HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new HubError(500, 'config_invalid', `${field} must be a credential-free HTTP(S) URL`);
  }
  return url.href.replace(/\/$/, '');
}

function integer(value, fallback, field, minimum, maximum) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new HubError(500, 'config_invalid', `${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

export function loadConfig({
  env = process.env,
  configPath = env.BRIDGE_HUB_CONFIG,
  cwd = process.cwd(),
} = {}) {
  const resolvedConfigPath = configPath
    ? path.resolve(cwd, configPath)
    : (fs.existsSync(path.join(cwd, 'config.json')) ? path.join(cwd, 'config.json') : null);
  const file = resolvedConfigPath ? readJsonFile(resolvedConfigPath) : {};
  const base = resolvedConfigPath ? path.dirname(resolvedConfigPath) : cwd;

  const cmb = file.cmb || {};
  const passwordFileValue = env.BRIDGE_HUB_CMB_PASSWORD_FILE || cmb.passwordFile;
  const dataDirValue = env.BRIDGE_HUB_DATA_DIR || file.dataDir || '.local';
  const apiTokenFileValue = env.BRIDGE_HUB_API_TOKEN_FILE || file.apiTokenFile;
  const voice = file.voice || {};

  return {
    configPath: resolvedConfigPath,
    host: env.BRIDGE_HUB_HOST || file.server?.host || '127.0.0.1',
    port: integer(env.BRIDGE_HUB_PORT || file.server?.port, 4310, 'server.port', 0, 65535),
    dataDir: path.resolve(base, dataDirValue),
    apiToken: env.BRIDGE_HUB_API_TOKEN
      || (apiTokenFileValue ? readSecret(path.resolve(base, apiTokenFileValue), 'API token file') : null),
    cmb: {
      baseUrl: normalizeBaseUrl(
        env.BRIDGE_HUB_CMB_BASE_URL || cmb.baseUrl,
        'cmb.baseUrl',
      ),
      username: env.BRIDGE_HUB_CMB_USERNAME || cmb.username || '',
      password: env.BRIDGE_HUB_CMB_PASSWORD
        || (passwordFileValue ? readSecret(path.resolve(base, passwordFileValue), 'CMB password file') : null),
      timeoutMs: integer(
        env.BRIDGE_HUB_CMB_TIMEOUT_MS || cmb.timeoutMs,
        120000,
        'cmb.timeoutMs',
        1000,
        600000,
      ),
    },
    voice: {
      baseUrl: normalizeBaseUrl(
        env.BRIDGE_HUB_VOICE_BASE_URL || voice.baseUrl,
        'voice.baseUrl',
        { optional: true },
      ),
      token: env.BRIDGE_HUB_VOICE_TOKEN
        || (voice.tokenFile ? readSecret(path.resolve(base, voice.tokenFile), 'voice token file') : null),
      timeoutMs: integer(voice.timeoutMs, 15000, 'voice.timeoutMs', 1000, 120000),
    },
  };
}

export function validateHubConfig(config) {
  if (!config?.cmb?.baseUrl) {
    throw new HubError(500, 'config_invalid', 'cmb.baseUrl is required');
  }
  if (!config.cmb.username || !config.cmb.password) {
    throw new HubError(
      500,
      'config_invalid',
      'CMB credentials are required through configuration and a private password file or environment variable',
    );
  }
  if (!config.dataDir) {
    throw new HubError(500, 'config_invalid', 'dataDir is required');
  }
  return config;
}
