import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function eventPath(configDirectory, value, field) {
  const file = path.resolve(configDirectory, requiredText(value, field));
  if (!path.isAbsolute(file)) throw new Error(`${field} must resolve to an absolute path`);
  return file;
}

export function loadIntegrationConfig(configPath) {
  if (typeof configPath !== 'string' || !path.isAbsolute(configPath)) {
    throw new Error('configPath must be an absolute file path');
  }
  const file = path.resolve(configPath);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot load integration config: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) {
    throw new Error('integration config must be an object with schemaVersion 1');
  }
  const eventFiles = value.eventFiles;
  if (!eventFiles || typeof eventFiles !== 'object' || Array.isArray(eventFiles)) {
    throw new Error('eventFiles is required');
  }
  const configDirectory = path.dirname(file);
  const workspace = value.workspace;
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
    throw new Error('workspace is required');
  }
  const workspacePath = workspace.path === undefined || workspace.path === ''
    ? ''
    : requiredText(workspace.path, 'workspace.path');
  if (workspacePath && !path.isAbsolute(workspacePath)) {
    throw new Error('workspace.path must be an absolute path or empty');
  }
  return {
    configPath: file,
    schemaVersion: 1,
    eventFiles: {
      taskEvents: eventPath(configDirectory, eventFiles.taskEvents, 'eventFiles.taskEvents'),
    },
    workspace: {
      path: workspacePath,
      projectKey: typeof workspace.projectKey === 'string' ? workspace.projectKey : '',
      voiceSessionId: typeof workspace.voiceSessionId === 'string' ? workspace.voiceSessionId : '',
      voiceSessionTitle: typeof workspace.voiceSessionTitle === 'string' && workspace.voiceSessionTitle.trim()
        ? workspace.voiceSessionTitle.trim()
        : '语音助手',
      initialized: workspace.initialized === true,
    },
    plugins: {
      control: value.plugins?.control && typeof value.plugins.control === 'object'
        ? {
          installed: value.plugins.control.installed === true,
          profile: value.plugins.control.profile || 'voice-controller',
          websocketUrl: value.plugins.control.websocketUrl || '',
          tokenFile: value.plugins.control.tokenFile || '',
          requestTimeoutMs: Number(value.plugins.control.requestTimeoutMs) || 30000,
        }
        : {
          installed: false,
          profile: 'voice-controller',
          websocketUrl: '',
          tokenFile: '',
          requestTimeoutMs: 30000,
        },
      characters: value.plugins?.characters && typeof value.plugins.characters === 'object'
        ? {
          installed: value.plugins.characters.installed === true,
          skill: value.plugins.characters.skill || 'character-settings',
          selectedId: value.plugins.characters.selectedId || 'elf-3',
        }
        : { installed: false, skill: 'character-settings', selectedId: 'elf-3' },
    },
  };
}

export function loadVoiceIntegrationConfig(
  env = process.env,
  defaultPath = path.resolve(import.meta.dirname, '..', 'config', 'settings.json'),
) {
  return loadIntegrationConfig(env.VOICE_CENTER_INTEGRATION_CONFIG || defaultPath);
}

function workspaceUpdate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workspace update must be an object');
  }
  const allowed = new Set(['path', 'projectKey', 'voiceSessionId', 'voiceSessionTitle', 'initialized']);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`Unknown workspace fields: ${unknown.join(', ')}`);
  if (!Object.keys(value).length) throw new Error('workspace update must contain at least one field');
  const result = {};
  if (Object.hasOwn(value, 'path')) {
    if (typeof value.path !== 'string') throw new Error('workspace.path must be a string');
    const file = value.path.trim();
    if (file && !path.isAbsolute(file)) throw new Error('workspace.path must be an absolute path or empty');
    result.path = file;
  }
  for (const field of ['projectKey', 'voiceSessionId', 'voiceSessionTitle']) {
    if (!Object.hasOwn(value, field)) continue;
    if (typeof value[field] !== 'string') throw new Error(`workspace.${field} must be a string`);
    const text = value[field].trim();
    if (text.length > 512) throw new Error(`workspace.${field} is too long`);
    result[field] = text;
  }
  if (Object.hasOwn(value, 'initialized')) {
    if (typeof value.initialized !== 'boolean') throw new Error('workspace.initialized must be a boolean');
    result.initialized = value.initialized;
  }
  return result;
}

export function updateIntegrationConfig(configPath, { workspace } = {}) {
  if (typeof configPath !== 'string' || !path.isAbsolute(configPath)) {
    throw new Error('configPath must be an absolute file path');
  }
  const file = path.resolve(configPath);
  const patch = workspaceUpdate(workspace);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read integration config: ${error.message}`);
  }
  const current = loadIntegrationConfig(file);
  const next = {
    ...raw,
    workspace: {
      ...raw.workspace,
      ...patch,
    },
  };
  if (next.workspace.initialized === true) {
    for (const field of ['path', 'projectKey', 'voiceSessionId']) {
      if (typeof next.workspace[field] !== 'string' || !next.workspace[field].trim()) {
        throw new Error(`workspace.${field} is required before initialization can be completed`);
      }
    }
  }
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    loadIntegrationConfig(temporary);
    fs.renameSync(temporary, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Existing parent policy may already restrict access.
    }
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup after a failed write.
    }
  }
  return {
    previous: current,
    current: loadIntegrationConfig(file),
  };
}
