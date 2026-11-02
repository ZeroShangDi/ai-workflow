import crypto from 'node:crypto';
import fs from 'node:fs';

import { loadIntegrationConfig, updateIntegrationConfig } from './integration-config.mjs';

function uuid() {
  return crypto.randomUUID();
}

function responseFailure(response) {
  if (!response || response.topic === 'control.error') {
    const error = new Error(response?.payload?.message || 'Control request failed');
    error.code = response?.payload?.code || 'control_error';
    throw error;
  }
  if (response.topic.endsWith('.failed')) {
    const error = new Error(response.payload?.message || `Control request failed: ${response.topic}`);
    error.code = response.payload?.code || 'control_failed';
    throw error;
  }
  return response;
}

export class VoiceIntegrationCoordinator {
  constructor({
    configPath,
    controlBridge,
    loadConfig = loadIntegrationConfig,
    updateConfig = updateIntegrationConfig,
    onConfig = () => {},
    onState = () => {},
    connectionTimeoutMs = 1800,
    initializationTimeoutMs = 120000,
    requestTimeoutMs = 30000,
  }) {
    this.configPath = configPath;
    this.controlBridge = controlBridge;
    this.loadConfig = loadConfig;
    this.updateConfig = updateConfig;
    this.onConfig = onConfig;
    this.onState = onState;
    this.connectionTimeoutMs = connectionTimeoutMs;
    this.initializationTimeoutMs = initializationTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.state = 'idle';
    this.lastError = null;
    this.pending = null;
    this.pendingInitializationRequestId = null;
    this.pendingChatRequestId = null;
  }

  status() {
    return {
      state: this.state,
      controlConnected: this.controlBridge?.statusValue?.().connected === true,
      error: this.lastError,
    };
  }

  async ensureReady() {
    if (this.pending) return this.pending;
    this.pending = this.#ensureReady().finally(() => { this.pending = null; });
    return this.pending;
  }

  async #ensureReady() {
    if (!this.controlBridge) {
      this.#state('standalone', null);
      return { mode: 'standalone', reason: 'control_not_configured' };
    }
    try {
      await this.controlBridge.waitUntilConnected(this.connectionTimeoutMs);
    } catch (failure) {
      this.#state('standalone', failure.message);
      return { mode: 'standalone', reason: 'control_unavailable' };
    }

    let config = this.loadConfig(this.configPath);
    this.onConfig(config);
    if (config.workspace.initialized && config.workspace.voiceSessionId) {
      const bound = await this.#bind(config);
      this.#state('ready', null);
      return { mode: 'managed', ...bound };
    }

    if (!config.workspace.projectKey) {
      this.#state('initializing', null);
      this.pendingInitializationRequestId ||= uuid();
      const initialized = responseFailure(await this.controlBridge.request(
        'voice.initialization.requested',
        {
          requestId: this.pendingInitializationRequestId,
          configPath: this.configPath,
          workspacePath: config.workspace.path,
          chatTitle: config.workspace.voiceSessionTitle,
        },
        {
          timeoutMs: this.requestTimeoutMs,
          responseTopics: ['control.initialization.started', 'control.initialization.failed', 'control.error'],
        },
      ));
      if (initialized.topic !== 'control.initialization.started') {
        throw new Error(`Unexpected initialization response: ${initialized.topic}`);
      }
      config = await this.#waitForConfig(
        (value) => Boolean(value.workspace.projectKey),
        this.initializationTimeoutMs,
      );
      this.pendingInitializationRequestId = null;
      this.onConfig(config);
    }

    if (!config.workspace.voiceSessionId) {
      this.#state('creating_chat', null);
      this.pendingChatRequestId ||= uuid();
      const ready = responseFailure(await this.controlBridge.request(
        'voice.chat_session.create.requested',
        {
          requestId: this.pendingChatRequestId,
          projectKey: config.workspace.projectKey,
          workspacePath: config.workspace.path,
          chatTitle: config.workspace.voiceSessionTitle,
        },
        {
          timeoutMs: this.requestTimeoutMs,
          responseTopics: ['control.chat_session.ready', 'control.chat_session.failed', 'control.error'],
        },
      ));
      if (ready.topic !== 'control.chat_session.ready') {
        throw new Error(`Unexpected chat session response: ${ready.topic}`);
      }
      this.pendingChatRequestId = null;
      config = this.updateConfig(this.configPath, {
        workspace: {
          projectKey: ready.payload.projectKey,
          voiceSessionId: ready.payload.voiceSessionId,
          voiceSessionTitle: config.workspace.voiceSessionTitle,
          initialized: true,
        },
      }).current;
      this.onConfig(config);
    }

    this.#state('binding', null);
    const bound = await this.#bind(config);
    this.#state('ready', null);
    return { mode: 'managed', ...bound };
  }

  async #bind(config) {
    const response = responseFailure(await this.controlBridge.request(
      'voice.chat_session.bind.requested',
      {
        requestId: uuid(),
        projectKey: config.workspace.projectKey,
        voiceSessionId: config.workspace.voiceSessionId,
      },
      {
        timeoutMs: this.requestTimeoutMs,
        responseTopics: ['control.chat_session.bound', 'control.chat_session.failed', 'control.error'],
      },
    ));
    if (response.topic !== 'control.chat_session.bound') {
      throw new Error(`Unexpected bind response: ${response.topic}`);
    }
    return {
      projectKey: config.workspace.projectKey,
      voiceSessionId: response.payload.voiceSessionId,
      workspacePath: config.workspace.path,
    };
  }

  #waitForConfig(predicate, timeoutMs) {
    const immediate = this.loadConfig(this.configPath);
    if (predicate(immediate)) return Promise.resolve(immediate);
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const listener = () => {
        try {
          const value = this.loadConfig(this.configPath);
          if (!predicate(value)) return;
          cleanup();
          resolve(value);
        } catch {
          // Atomic replacement can briefly produce an intermediate file state.
        }
      };
      const timer = setInterval(() => {
        if (Date.now() >= deadline) {
          cleanup();
          reject(new Error('timed out waiting for voice integration initialization'));
        }
      }, 250);
      timer.unref?.();
      const cleanup = () => {
        clearInterval(timer);
        fs.unwatchFile(this.configPath, listener);
      };
      fs.watchFile(this.configPath, { interval: 250 }, listener);
      listener();
    });
  }

  #state(state, error) {
    this.state = state;
    this.lastError = error || null;
    this.onState(this.status());
  }
}
