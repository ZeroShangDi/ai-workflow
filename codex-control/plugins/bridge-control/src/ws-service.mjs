import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadControlConfig } from './config.mjs';
import { CmbAdapter } from './cmb-client.mjs';
import { controlThreadConfig } from './thread-config.mjs';
import { requireWsString } from './ws-protocol.mjs';

function absolutePath(value, field) {
  const text = requireWsString(value, field, 4096);
  if (!path.isAbsolute(text)) throw new Error(`${field} must be an absolute path`);
  return path.resolve(text);
}

function uuid(value, field) {
  const text = requireWsString(value, field, 128);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new Error(`${field} must be a UUID`);
  }
  return text;
}

function skillRows(value) {
  const rows = value?.skills || value?.skillEntries || [];
  return Array.isArray(rows) ? rows : [];
}

function findSkill(value, name) {
  return skillRows(value).find((skill) => {
    const candidate = String(skill?.name || '');
    const display = String(skill?.displayName || '');
    return [candidate, display].some((item) => item === name || item.endsWith(`:${name}`));
  }) || null;
}

function messageText(message) {
  if (typeof message?.text === 'string') return message.text.trim();
  if (typeof message?.content === 'string') return message.content.trim();
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part) => (typeof part === 'string' ? part : part?.text))
      .filter((part) => typeof part === 'string')
      .join('\n')
      .trim();
  }
  return '';
}

export function latestAssistantMessage(view) {
  const turns = Array.isArray(view?.turns) ? view.turns : [];
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex];
    const messages = Array.isArray(turn?.messages) ? turn.messages : [];
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = messages[messageIndex];
      if (message?.role !== 'assistant') continue;
      const text = messageText(message);
      if (!text) continue;
      return {
        id: String(message.id || `${turn.id || turn.turnId || turnIndex}:${messageIndex}`),
        turnId: String(turn.id || turn.turnId || ''),
        text,
      };
    }
  }
  return null;
}

export class ControlWebSocketService {
  constructor({
    cmb = null,
    createCmb = () => new CmbAdapter(loadControlConfig().cmb),
    now = () => new Date(),
    idFactory = () => crypto.randomUUID(),
    toolCall = null,
  } = {}) {
    this.cmbValue = cmb;
    this.createCmb = createCmb;
    this.now = now;
    this.idFactory = idFactory;
    this.toolCall = toolCall;
    this.chatLocks = new Set();
    this.chatTimeoutMs = 120000;
    this.skillCache = new Map();
  }

  get cmb() {
    if (!this.cmbValue) this.cmbValue = this.createCmb();
    return this.cmbValue;
  }

  response(event, topic, payload) {
    return {
      schemaVersion: 1,
      eventId: `evt_${this.idFactory()}`,
      correlationId: event.correlationId,
      topic,
      source: 'bridge-control',
      createdAt: this.now().toISOString(),
      payload,
    };
  }

  async handle(event) {
    try {
      if (event.topic === 'voice.initialization.requested') return await this.initialize(event);
      if (event.topic === 'voice.chat_session.create.requested') return await this.createChatSession(event);
      if (event.topic === 'voice.chat_session.bind.requested') return await this.bindChatSession(event);
      if (event.topic === 'voice.chat.user') return await this.chat(event);
      if (event.topic === 'voice.playback.result') return this.playback(event);
      if (event.topic === 'control.tool.call.requested') return await this.callTool(event);
      return this.response(event, 'control.error', {
        code: 'unsupported_event',
        message: `Unsupported event topic: ${event.topic}`,
      });
    } catch (failure) {
      return this.response(event, 'control.error', {
        code: failure.code || 'control_ws_error',
        message: failure.message || 'Control WebSocket request failed',
      });
    }
  }

  async callTool(event) {
    if (typeof this.toolCall !== 'function') {
      return this.response(event, 'control.tool.call.failed', {
        code: 'tool_gateway_unavailable',
        message: 'Control tool gateway is not configured',
      });
    }
    const profile = requireWsString(event.payload.profile, 'profile', 64);
    const tool = requireWsString(event.payload.tool, 'tool', 128);
    const threadId = requireWsString(event.payload.threadId, 'threadId', 256);
    const args = event.payload.arguments === undefined ? {} : event.payload.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error('arguments must be an object');
    }
    const result = await this.toolCall({
      profile,
      tool,
      threadId,
      args: { ...args, sessionId: args.sessionId || threadId },
    });
    return this.response(event, 'control.tool.call.completed', { profile, tool, result });
  }

  async initialize(event) {
    const requestId = uuid(event.payload.requestId, 'requestId');
    const configPath = absolutePath(event.payload.configPath, 'configPath');
    const workspacePath = absolutePath(event.payload.workspacePath, 'workspacePath');
    const fixedChatTitle = requireWsString(event.payload.chatTitle || '语音助手', 'chatTitle', 120);
    const initializationTitle = requireWsString(
      event.payload.initializationTitle || '语音控制初始化',
      'initializationTitle',
      120,
    );
    const session = await this.cmb.createSession({
      project: 'local|independent',
      title: initializationTitle,
      requestId,
      permissions: ':danger-full-access',
      approvalPolicy: 'never',
    });
    await this.cmb.updateSecuritySettings(session.id, {
      approvalPolicy: 'never',
      permissions: ':danger-full-access',
    });
    const skill = findSkill(
      await this.cmb.catalog(session.id, { kind: 'skills', query: 'voice-integration', limit: 20 }),
      'voice-integration',
    );
    if (!skill?.id) {
      return this.response(event, 'control.initialization.failed', {
        code: 'voice_integration_skill_not_found',
        message: 'The initialization session could not load the voice-integration skill',
        initializationSessionId: session.id,
      });
    }
    const bootstrap = [
      '这是 Voice Control 的内部初始化消息。',
      '请使用 voice-integration 技能完成初始化，不要创建固定语音聊天会话。',
      `configPath=${configPath}`,
      `workspacePath=${workspacePath}`,
      `chatTitle=${fixedChatTitle}`,
      '完成后将 workspace.path、workspace.projectKey 写入配置，保持 initialized=false，并停止。',
    ].join('\n');
    const receipt = await this.cmb.send(session.id, {
      text: bootstrap,
      requestId: this.idFactory(),
      mode: 'send',
      skills: [skill.id],
    });
    return this.response(event, 'control.initialization.started', {
      initializationSessionId: session.id,
      skillId: skill.id,
      receiptStatus: receipt?.status || 'accepted',
    });
  }

  async createChatSession(event) {
    const requestId = uuid(event.payload.requestId, 'requestId');
    const projectKey = requireWsString(event.payload.projectKey, 'projectKey', 4096);
    const workspacePath = absolutePath(event.payload.workspacePath, 'workspacePath');
    const title = requireWsString(event.payload.chatTitle || '语音助手', 'chatTitle', 120);
    this.#installWorkspaceTools(workspacePath);
    const projects = (await this.cmb.projects()).projects || [];
    const project = projects.find((item) => item.key === projectKey);
    if (!project) {
      return this.response(event, 'control.chat_session.failed', {
        code: 'workspace_not_found',
        message: 'The configured workspace project was not found',
      });
    }
    if (project.cwd && path.resolve(project.cwd) !== workspacePath) {
      return this.response(event, 'control.chat_session.failed', {
        code: 'workspace_mismatch',
        message: 'The configured workspace path does not match the selected project',
      });
    }
    const matches = (await this.cmb.sessions({ query: title, limit: 50 })).sessions
      .filter((item) => item.title === title)
      .filter((item) => !item.cwd || path.resolve(item.cwd) === workspacePath);
    if (matches.length > 1) {
      return this.response(event, 'control.chat_session.failed', {
        code: 'chat_session_ambiguous',
        message: 'Multiple fixed voice chat sessions match; user selection is required',
        candidates: matches,
      });
    }
    const thread = controlThreadConfig('voice-controller');
    const session = matches[0] || await this.cmb.createSession({
      project: projectKey,
      title,
      requestId,
      ...thread,
    });
    await this.cmb.updateSecuritySettings(session.id, {
      approvalPolicy: 'never',
      permissions: ':danger-full-access',
    });
    return this.response(event, 'control.chat_session.ready', {
      voiceSessionId: session.id,
      projectKey,
      workspacePath,
      title,
      reused: Boolean(matches[0]),
    });
  }

  async bindChatSession(event) {
    const voiceSessionId = requireWsString(event.payload.voiceSessionId, 'voiceSessionId', 256);
    const view = await this.cmb.view(voiceSessionId);
    return this.response(event, 'control.chat_session.bound', {
      voiceSessionId,
      title: view?.title || null,
      status: view?.status || view?.session?.status || null,
      cwd: view?.cwd || view?.session?.cwd || null,
    });
  }

  async chat(event) {
    const voiceSessionId = requireWsString(event.payload.voiceSessionId, 'voiceSessionId', 256);
    const text = requireWsString(event.payload.text, 'text', 100000);
    if (this.chatLocks.has(voiceSessionId)) {
      return this.response(event, 'control.chat.failed', {
        code: 'chat_busy',
        message: 'The fixed voice conversation is already processing a turn',
      });
    }
    this.chatLocks.add(voiceSessionId);
    try {
      const skillId = await this.#bridgeControlSkillId(voiceSessionId);
      const before = latestAssistantMessage(await this.cmb.view(voiceSessionId));
      await this.cmb.updateSecuritySettings(voiceSessionId, {
        approvalPolicy: 'never',
        permissions: ':danger-full-access',
      });
      const receipt = await this.cmb.send(voiceSessionId, {
        text,
        requestId: this.idFactory(),
        mode: 'send',
        skills: [skillId],
      });
      if (receipt?.status === 'failed' || receipt?.outcome === 'failed') {
        return this.response(event, 'control.chat.failed', {
          code: 'chat_send_failed',
          message: receipt.error || 'The fixed Codex conversation rejected the message',
        });
      }
      const assistant = await this.#waitForAssistantReply(voiceSessionId, before?.id || null);
      return this.response(event, 'control.chat.reply', {
        voiceSessionId,
        messageId: assistant.id,
        turnId: assistant.turnId,
        text: assistant.text,
      });
    } finally {
      this.chatLocks.delete(voiceSessionId);
    }
  }

  playback(event) {
    return this.response(event, 'control.playback.recorded', {
      noticeId: event.payload.noticeId || null,
      status: event.payload.status || null,
    });
  }

  async #waitForAssistantReply(voiceSessionId, previousMessageId) {
    const deadline = Date.now() + this.chatTimeoutMs;
    while (Date.now() < deadline) {
      const view = await this.cmb.view(voiceSessionId);
      const latest = latestAssistantMessage(view);
      const status = String(view?.status || view?.session?.status || '').toLowerCase();
      if (latest && latest.id !== previousMessageId && (!status || status === 'idle')) return latest;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const error = new Error('Timed out waiting for the fixed Codex conversation reply');
    error.code = 'chat_reply_timeout';
    throw error;
  }

  #installWorkspaceTools(workspacePath) {
    const configPath = process.env.BRIDGE_CONTROL_INTEGRATION_CONFIG;
    if (!configPath) throw new Error('BRIDGE_CONTROL_INTEGRATION_CONFIG is required');
    const commandDir = path.join(workspacePath, '.codex-control');
    const cliPath = path.resolve(import.meta.dirname, '..', 'cli.mjs');
    fs.mkdirSync(commandDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(commandDir, 'bridge-cli.sh'), [
      '#!/bin/sh',
      'set -eu',
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} --config ${JSON.stringify(configPath)} "$@"`,
      '',
    ].join('\n'), { mode: 0o700 });
    const sourceSkill = path.resolve(import.meta.dirname, '..', 'skills', 'bridge-control-cli');
    const targetSkill = path.join(workspacePath, '.agents', 'skills', 'bridge-control-cli');
    fs.mkdirSync(path.dirname(targetSkill), { recursive: true, mode: 0o700 });
    fs.cpSync(sourceSkill, targetSkill, { recursive: true, force: true });
    const sourceReporter = path.resolve(import.meta.dirname, '..', 'skills', 'work-reporter');
    const targetReporter = path.join(workspacePath, '.agents', 'skills', 'work-reporter');
    fs.cpSync(sourceReporter, targetReporter, { recursive: true, force: true });
  }

  async #bridgeControlSkillId(voiceSessionId) {
    if (this.skillCache.has(voiceSessionId)) return this.skillCache.get(voiceSessionId);
    const catalog = await this.cmb.catalog(voiceSessionId, {
      kind: 'skills',
      query: 'bridge-control-cli',
      limit: 20,
      refresh: true,
    });
    const skill = findSkill(catalog, 'bridge-control-cli');
    if (!skill?.id) {
      throw new Error('The fixed voice session could not load the bridge-control-cli skill');
    }
    this.skillCache.set(voiceSessionId, skill.id);
    return skill.id;
  }
}
