#!/usr/bin/env node

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkModeStore } from '../src/work-mode.mjs';

const backendRoot = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(backendRoot, '..');

function portValue(value, name, fallback) {
  const port = Number(value || fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must be a valid port`);
  return port;
}

function readSecretFile(env, value, fileVariable) {
  if (env[value]) return env[value];
  const file = env[fileVariable];
  if (!file) return '';
  return fs.readFileSync(path.resolve(file), 'utf8').trim();
}

function pythonExecutable(env) {
  if (env.VOICE_CENTER_RUNTIME_PYTHON) return path.resolve(env.VOICE_CENTER_RUNTIME_PYTHON);
  const local = path.join(pluginRoot, '.local', 'runtime-venv', 'bin', 'python');
  if (fs.existsSync(local)) return local;
  return 'python3.12';
}

export function buildLaunchEnvironment({ env = process.env, secret, backendPort, controlPort } = {}) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('runtime ticket secret is too short');
  if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65535) throw new Error('backend port is invalid');
  if (!Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65535) throw new Error('control port is invalid');
  const base = { ...env };
  delete base.VOICE_CONTROL_AUDIO_SERVICE_URL;
  delete base.VOICE_CONTROL_AUDIO_TIMEOUT_MS;
  return {
    ...base,
    VOICE_CENTER_AUDIO_SERVICE_URL: `http://127.0.0.1:${backendPort}`,
    VOICE_CENTER_TICKET_SECRET: secret,
    VOICE_CENTER_LLM_URL: env.VOICE_CENTER_LLM_URL || env.VOICE_LLM_URL || 'https://api.deepseek.com/v1',
    VOICE_CENTER_LLM_MODEL: env.VOICE_CENTER_LLM_MODEL || env.VOICE_LLM_MODEL || 'deepseek-flash',
    VOICE_CENTER_LLM_API_KEY: env.VOICE_CENTER_LLM_API_KEY || env.VOICE_LLM_API_KEY || '',
  };
}

async function waitForHealth(url, child, timeoutMs = 30000, fetchImpl = fetch) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`voice runtime exited with code ${child.exitCode}`);
    try {
      const response = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // Uvicorn is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('voice runtime did not become ready');
}

async function stopChild(child, timeoutMs = 3000) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  if (!stopped) {
    child.kill('SIGKILL');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
}

async function main() {
  const backendPort = portValue(process.env.VOICE_CENTER_BACKEND_PORT, 'VOICE_CENTER_BACKEND_PORT', 48088);
  const controlPort = portValue(process.env.VOICE_CENTER_PORT, 'VOICE_CENTER_PORT', 8891);
  const secret = process.env.VOICE_CENTER_TICKET_SECRET || process.env.VOICE_TICKET_SECRET || crypto.randomBytes(48).toString('base64url');
  let workMode = process.env.VOICE_CENTER_WORK_MODE;
  if (!workMode) {
    workMode = new WorkModeStore({ dataDir: process.env.VOICE_CENTER_DATA_DIR || path.join(pluginRoot, 'data') }).get();
  }
  if (!['control', 'market', 'none'].includes(workMode)) throw new Error('VOICE_CENTER_WORK_MODE is invalid');
  const environment = buildLaunchEnvironment({
    env: process.env,
    secret,
    backendPort,
    controlPort,
  });
  const runtime = spawn(pythonExecutable(environment), ['-m', 'voice_center_backend.server'], {
    cwd: backendRoot,
    env: {
      ...environment,
      VOICE_BIND_HOST: '127.0.0.1',
      VOICE_PORT: String(backendPort),
      VOICE_TICKET_SECRET: secret,
      VOICE_CENTER_DATA_DIR: process.env.VOICE_CENTER_DATA_DIR || path.join(pluginRoot, 'data'),
      VOICE_CENTER_INTEGRATION_CONFIG: process.env.VOICE_CENTER_INTEGRATION_CONFIG || path.join(pluginRoot, 'config', 'settings.json'),
      VOICE_CENTER_WORK_MODE: workMode,
      VOICE_STT_PROTOCOL: process.env.VOICE_CENTER_ASR_PROTOCOL || 'qwen-mlx-http',
      VOICE_STT_URL: process.env.VOICE_CENTER_ASR_URL || 'http://127.0.0.1:48085/v1',
      VOICE_STT_MODEL: process.env.VOICE_CENTER_ASR_MODEL || 'qwen3-asr',
      VOICE_STT_API_KEY: readSecretFile(process.env, 'VOICE_CENTER_ASR_API_KEY', 'VOICE_CENTER_ASR_API_KEY_FILE'),
      VOICE_TTS_URL: process.env.VOICE_CENTER_TTS_URL || 'http://127.0.0.1:48084/v1',
      VOICE_TTS_MODEL: process.env.VOICE_CENTER_TTS_MODEL || 'qwen3-tts',
      VOICE_TTS_VOICE: process.env.VOICE_CENTER_TTS_VOICE || 'Vivian',
      VOICE_TTS_SAMPLE_RATE: process.env.VOICE_CENTER_TTS_SAMPLE_RATE || '24000',
      VOICE_TTS_API_KEY: readSecretFile(process.env, 'VOICE_CENTER_TTS_API_KEY', 'VOICE_CENTER_TTS_API_KEY_FILE'),
      VOICE_LLM_URL: environment.VOICE_CENTER_LLM_URL,
      VOICE_LLM_MODEL: environment.VOICE_CENTER_LLM_MODEL,
      VOICE_LLM_API_KEY: readSecretFile(process.env, 'VOICE_CENTER_LLM_API_KEY', 'VOICE_CENTER_LLM_API_KEY_FILE') || environment.VOICE_CENTER_LLM_API_KEY,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let app = null;
  let stopping = false;

  async function shutdown(signal, code = 0) {
    if (stopping) return;
    stopping = true;
    if (signal) process.stderr.write(`voice-center launcher stopping (${signal})\n`);
    await stopChild(app);
    await stopChild(runtime);
    process.exitCode = code;
  }

  const onSignal = (signal) => {
    void shutdown(signal, 0).then(() => process.exit(0));
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  runtime.once('exit', (code, signal) => {
    if (stopping) return;
    process.stderr.write(`voice-center backend stopped unexpectedly (${signal || code})\n`);
    void shutdown(null, code || 1).then(() => process.exit(code || 1));
  });

  try {
    await waitForHealth(`http://127.0.0.1:${backendPort}`, runtime);
  } catch (error) {
    await shutdown(null, 1);
    throw error;
  }

  app = spawn(process.execPath, [path.join(pluginRoot, 'src', 'main.mjs')], {
    cwd: pluginRoot,
    env: environment,
    stdio: 'inherit',
  });
  app.once('exit', (code, signal) => {
    if (stopping) return;
    process.stderr.write(`voice-center stopped (${signal || code})\n`);
    void shutdown(null, code || 0).then(() => process.exit(code || 0));
  });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`voice-center launcher failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
