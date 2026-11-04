#!/usr/bin/env node

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(runtimeRoot, '..');

function portValue(value, name, fallback) {
  const port = Number(value || fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must be a valid port`);
  return port;
}

function pythonExecutable(env) {
  if (env.VOICE_CONTROL_RUNTIME_PYTHON) return path.resolve(env.VOICE_CONTROL_RUNTIME_PYTHON);
  const local = path.join(pluginRoot, '.local', 'runtime-venv', 'bin', 'python');
  if (fs.existsSync(local)) return local;
  return 'python3.12';
}

export function buildLaunchEnvironment({ env = process.env, secret, runtimePort, controlPort } = {}) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('runtime ticket secret is too short');
  if (!Number.isInteger(runtimePort) || runtimePort < 1 || runtimePort > 65535) throw new Error('runtime port is invalid');
  if (!Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65535) throw new Error('control port is invalid');
  const base = { ...env };
  delete base.VOICE_CONTROL_AUDIO_SERVICE_URL;
  delete base.VOICE_CONTROL_AUDIO_TIMEOUT_MS;
  return {
    ...base,
    VOICE_CONTROL_AUDIO_SERVICE_URL: `http://127.0.0.1:${runtimePort}`,
    VOICE_CONTROL_TICKET_SECRET: secret,
    VOICE_CONTROL_LLM_URL: `http://127.0.0.1:${controlPort}/v1`,
    VOICE_CONTROL_LLM_MODEL: env.VOICE_CONTROL_LLM_MODEL || 'codex',
    VOICE_CONTROL_LLM_API_KEY: env.VOICE_CONTROL_LLM_API_KEY || 'local',
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
  const runtimePort = portValue(process.env.VOICE_CONTROL_RUNTIME_PORT, 'VOICE_CONTROL_RUNTIME_PORT', 48087);
  const controlPort = portValue(process.env.VOICE_CONTROL_PORT, 'VOICE_CONTROL_PORT', 8791);
  const secret = process.env.VOICE_CONTROL_TICKET_SECRET || crypto.randomBytes(48).toString('base64url');
  const environment = buildLaunchEnvironment({
    env: process.env,
    secret,
    runtimePort,
    controlPort,
  });
  const runtime = spawn(pythonExecutable(environment), ['-m', 'voice_runtime.server'], {
    cwd: runtimeRoot,
    env: {
      ...environment,
      VOICE_CONTROL_RUNTIME_HOST: '127.0.0.1',
      VOICE_CONTROL_RUNTIME_PORT: String(runtimePort),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let app = null;
  let stopping = false;

  async function shutdown(signal, code = 0) {
    if (stopping) return;
    stopping = true;
    if (signal) process.stderr.write(`voice-control launcher stopping (${signal})\n`);
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
    process.stderr.write(`voice-control runtime stopped unexpectedly (${signal || code})\n`);
    void shutdown(null, code || 1).then(() => process.exit(code || 1));
  });

  try {
    await waitForHealth(`http://127.0.0.1:${runtimePort}`, runtime);
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
    process.stderr.write(`voice-control stopped (${signal || code})\n`);
    void shutdown(null, code || 0).then(() => process.exit(code || 0));
  });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`voice-control launcher failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
