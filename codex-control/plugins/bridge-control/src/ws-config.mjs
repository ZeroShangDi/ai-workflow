import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function portValue(value) {
  const port = Number(value || 8792);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('BRIDGE_CONTROL_WS_PORT must be 0-65535');
  return port;
}

function tokenAt(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${crypto.randomBytes(48).toString('base64url')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  }
  const token = fs.readFileSync(filePath, 'utf8').trim();
  if (token.length < 32) throw new Error('Bridge Control WebSocket token is too short');
  try { fs.chmodSync(filePath, 0o600); } catch { /* Parent policy may be stricter. */ }
  return token;
}

export function loadControlWsConfig(env = process.env) {
  const dataDir = path.resolve(env.BRIDGE_CONTROL_DATA_DIR || path.resolve(import.meta.dirname, '..', '.local'));
  const tokenFile = path.resolve(env.BRIDGE_CONTROL_WS_TOKEN_FILE || path.join(dataDir, 'control-ws.token'));
  const enabled = env.BRIDGE_CONTROL_WS_ENABLED !== '0';
  const token = !enabled
    ? ''
    : (env.BRIDGE_CONTROL_WS_TOKEN ? String(env.BRIDGE_CONTROL_WS_TOKEN).trim() : tokenAt(tokenFile));
  return {
    enabled,
    host: env.BRIDGE_CONTROL_WS_HOST || '127.0.0.1',
    port: portValue(env.BRIDGE_CONTROL_WS_PORT),
    dataDir,
    token,
    tokenFile,
    eventStoreFile: path.join(dataDir, 'ws-events.sqlite'),
    handshakeTimeoutMs: Number(env.BRIDGE_CONTROL_WS_HANDSHAKE_TIMEOUT_MS || 5000),
    heartbeatMs: Number(env.BRIDGE_CONTROL_WS_HEARTBEAT_MS || 30000),
  };
}
