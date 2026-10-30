import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_KEYS = new Set([
  'software',
  'baseUrl',
  'username',
  'passwordEnv',
  'passwordFile',
  'defaultProject',
]);

export function configPath() {
  if (process.env.CMB_CONTROL_CONFIG) {
    return path.resolve(process.env.CMB_CONTROL_CONFIG);
  }
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'bridge-control', 'config.json');
}

export function loadConfig(overrides = {}) {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`Cannot read bridge-control config: ${error.message}`);
    }
  }
  return {
    software: process.env.CMB_SOFTWARE || stored.software || 'cmb',
    baseUrl: process.env.CMB_BASE_URL || stored.baseUrl || 'http://127.0.0.1:18787',
    username: process.env.CMB_USERNAME || stored.username || 'admin',
    passwordEnv: stored.passwordEnv || 'CMB_PASSWORD',
    passwordFile: process.env.CMB_PASSWORD_FILE || stored.passwordFile || '',
    defaultProject: stored.defaultProject || '',
    ...overrides,
  };
}

export function saveConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Configuration must be an object');
  }
  const unknown = Object.keys(value).filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length) {
    throw new Error(`Unknown configuration keys: ${unknown.join(', ')}`);
  }
  if (value.baseUrl) assertBaseUrl(value.baseUrl);
  if (value.username != null && (typeof value.username !== 'string' || !value.username.trim())) {
    throw new Error('Username must be a non-empty string');
  }
  if (value.passwordFile) {
    const file = path.resolve(String(value.passwordFile));
    if (!fs.statSync(file).isFile()) throw new Error('Password file is not a regular file');
    value = { ...value, passwordFile: file };
  }
  const merged = { ...loadConfig(), ...value };
  const target = configPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
  return publicConfig(merged);
}

export function passwordFor(config) {
  const envName = config.passwordEnv || 'CMB_PASSWORD';
  if (process.env[envName]) return process.env[envName];
  if (config.passwordFile) {
    let value;
    try {
      value = fs.readFileSync(config.passwordFile, 'utf8');
    } catch (error) {
      throw new Error(`Cannot read CMB password file: ${error.message}`);
    }
    const matched = value.match(/(?:密码|password)\s*[：:]\s*(.+)/i);
    const password = (matched ? matched[1] : value).trim();
    if (!password) throw new Error('CMB password file is empty');
    return password;
  }
  throw new Error('No CMB password configured. Set CMB_PASSWORD or run bridge_configure with passwordFile.');
}

export function publicConfig(config = loadConfig()) {
  return {
    software: config.software,
    baseUrl: config.baseUrl,
    username: config.username,
    hasPassword: Boolean(process.env[config.passwordEnv || 'CMB_PASSWORD'] || config.passwordFile),
    passwordEnv: config.passwordEnv || 'CMB_PASSWORD',
    passwordFile: config.passwordFile || null,
    defaultProject: config.defaultProject || null,
    configPath: configPath(),
  };
}

export function assertBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Bridge base URL is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Bridge base URL must be a plain HTTP or HTTPS origin');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('Bridge base URL cannot contain a path');
  }
  return url.origin;
}
