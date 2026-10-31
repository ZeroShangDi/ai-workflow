import fs from 'node:fs';
import path from 'node:path';

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
