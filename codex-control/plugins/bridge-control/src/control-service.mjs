import crypto from 'node:crypto';
import { CreateDraftMachine } from './create-machine.mjs';
import { assertControlBackend, isUnknownResult, unknownWriteReceipt } from './backend-client.mjs';
import { loadIntegrationConfig } from './integration-config.mjs';
import { assertToolAvailable } from './profiles.mjs';

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

function oneTarget(args) {
  if (!args.sessionId && !args.workId) throw new Error('sessionId or workId is required');
}

async function writeOnce(backendMethod, idempotencyKey) {
  try {
    const value = await backendMethod(idempotencyKey);
    return isUnknownResult(value) ? unknownWriteReceipt(idempotencyKey) : value;
  } catch (failure) {
    if (failure.unknown === true || failure.code === 'UNKNOWN_RESULT' || failure.code === 'ETIMEDOUT') {
      return unknownWriteReceipt(idempotencyKey);
    }
    throw failure;
  }
}

export class ControlService {
  constructor({ backend, profile, dev = false, defaultProject = null, now, idFactory }) {
    this.profile = profile;
    this.dev = dev;
    this.backend = assertControlBackend(backend, profile);
    this.idFactory = idFactory || (() => crypto.randomUUID());
    this.integrationConfig = null;
    this.createMachine = profile === 'voice-controller'
      ? new CreateDraftMachine({
        createWork: (request) => this.backend.createWork(request),
        latestUserTranscript: (request) => this.backend.latestUserTranscript(request),
        defaultProject,
        now,
        idFactory,
      })
      : null;
  }

  toolAvailable(name) {
    try {
      assertToolAvailable(this.profile, name, { dev: this.dev });
      return true;
    } catch {
      return false;
    }
  }

  async latestTranscript(sessionId) {
    const transcript = await this.backend.latestUserTranscript({ sessionId });
    if (!transcript?.text) throw new Error('The backend has no recent user transcript for this interaction');
    if (!transcript.turnId && !transcript.sequence) {
      throw new Error('latestUserTranscript must provide turnId or sequence');
    }
    return transcript;
  }

  async boundInteraction({ sessionId, interactionId, binding }) {
    requireString(interactionId, 'interactionId');
    requireString(binding, 'binding');
    const pending = await this.backend.getPending({ sessionId, interactionId });
    if (!pending || pending.interactionId !== interactionId || pending.binding !== binding) {
      const failure = new Error('Interaction binding is stale or unknown');
      failure.code = 'STALE_INTERACTION';
      throw failure;
    }
    return pending;
  }

  async call(toolName, args = {}) {
    assertToolAvailable(this.profile, toolName, { dev: this.dev });
    if (this.profile === 'voice-controller') return this.callVoice(toolName, args);
    return this.callWork(toolName, args);
  }

  async callVoice(toolName, args) {
    if (toolName === 'bridge_chat_control_config_load') {
      const config = loadIntegrationConfig(requireString(args.configPath, 'configPath'));
      this.integrationConfig = config;
      if (typeof this.backend.configureEventFiles !== 'function') {
        throw new Error('Control backend cannot apply integration event files');
      }
      const eventFiles = this.backend.configureEventFiles(config.eventFiles);
      return { status: 'loaded', ...config, appliedEventFiles: eventFiles };
    }
    if (toolName === 'bridge_chat_control_workspace_ensure') {
      if (!this.integrationConfig) throw new Error('load the integration config first');
      if (args.createDirectory !== undefined && typeof args.createDirectory !== 'boolean') {
        throw new Error('createDirectory must be a boolean');
      }
      return this.backend.ensureWorkspace({
        workspace: this.integrationConfig.workspace,
        createDirectory: args.createDirectory === true,
      });
    }
    if (toolName === 'bridge_chat') {
      requireString(args.text, 'text');
      if (typeof this.backend.devChat !== 'function') throw new Error('Control backend does not provide devChat');
      return this.backend.devChat(args);
    }
    if (toolName === 'bridge_chat_create') {
      if (args.draftId || args.binding) {
        return this.createMachine.continue({
          sessionId: requireString(args.sessionId, 'sessionId'),
          draftId: requireString(args.draftId, 'draftId'),
          binding: requireString(args.binding, 'binding'),
          draft: args.draft || {},
        });
      }
      return this.createMachine.create({
        sessionId: requireString(args.sessionId, 'sessionId'),
        draft: args.draft || {},
      });
    }
    if (toolName === 'bridge_chat_confirm') {
      return this.createMachine.confirm({
        sessionId: requireString(args.sessionId, 'sessionId'),
        draftId: requireString(args.draftId, 'draftId'),
        binding: requireString(args.binding, 'binding'),
      });
    }
    if (toolName === 'bridge_chat_find') {
      return this.backend.findWork({ query: requireString(args.query, 'query'), limit: args.limit });
    }
    if (toolName === 'bridge_chat_status') {
      oneTarget(args);
      return this.backend.getStatus(args);
    }
    if (toolName === 'bridge_chat_send') {
      requireString(args.text, 'text');
      oneTarget(args);
      const idempotencyKey = `send:${this.idFactory()}`;
      return writeOnce(
        (key) => this.backend.sendMessage({ ...args, mode: args.mode || 'send', idempotencyKey: key }),
        idempotencyKey,
      );
    }
    if (toolName === 'bridge_chat_read') {
      oneTarget(args);
      return this.backend.readWork(args);
    }
    if (toolName === 'bridge_chat_events') {
      return this.backend.readEvents(args);
    }
    if (toolName === 'bridge_chat_pending') {
      return this.backend.getPending(args);
    }
    if (toolName === 'bridge_chat_answer') {
      const sessionId = requireString(args.sessionId, 'sessionId');
      const pending = await this.boundInteraction({ ...args, sessionId });
      if (pending.kind !== 'question') throw new Error('The bound interaction is not a question');
      if (!Array.isArray(args.answers) || !args.answers.length) throw new Error('answers are required');
      const transcript = await this.latestTranscript(sessionId);
      const idempotencyKey = `answer:${args.interactionId}:${transcript.turnId || transcript.sequence}`;
      return writeOnce(
        (key) => this.backend.resolveAnswer({
          sessionId,
          interactionId: args.interactionId,
          binding: args.binding,
          answers: args.answers,
          transcript,
          idempotencyKey: key,
        }),
        idempotencyKey,
      );
    }
    if (toolName === 'bridge_chat_approve') {
      const sessionId = requireString(args.sessionId, 'sessionId');
      const pending = await this.boundInteraction({ ...args, sessionId });
      if (pending.kind !== 'approval') throw new Error('The bound interaction is not an approval');
      if (!['approve', 'reject'].includes(args.decision)) throw new Error('decision must be approve or reject');
      const transcript = await this.latestTranscript(sessionId);
      const idempotencyKey = `approval:${args.interactionId}:${transcript.turnId || transcript.sequence}`;
      return writeOnce(
        (key) => this.backend.resolveApproval({
          sessionId,
          interactionId: args.interactionId,
          binding: args.binding,
          decision: args.decision,
          transcript,
          idempotencyKey: key,
        }),
        idempotencyKey,
      );
    }
    if (toolName === 'bridge_chat_stop') {
      oneTarget(args);
      const idempotencyKey = `stop:${this.idFactory()}`;
      return writeOnce(
        (key) => this.backend.stopWork({ ...args, idempotencyKey: key }),
        idempotencyKey,
      );
    }
    throw new Error(`Unknown voice-controller tool: ${toolName}`);
  }

  async callWork(toolName, args) {
    requireString(args.sessionId, 'sessionId');
    const idempotencyKey = `${toolName}:${this.idFactory()}`;
    if (toolName === 'bridge_chat_emit_progress') {
      requireString(args.text, 'text');
      return writeOnce(
        (key) => this.backend.emitProgress({ ...args, idempotencyKey: key }),
        idempotencyKey,
      );
    }
    if (toolName === 'bridge_chat_request_input') {
      if (!Array.isArray(args.questions) || !args.questions.length) throw new Error('questions are required');
      return writeOnce(
        (key) => this.backend.requestInput({ ...args, idempotencyKey: key }),
        idempotencyKey,
      );
    }
    if (toolName === 'bridge_chat_request_approval') {
      return writeOnce(
        (key) => this.backend.requestApproval({ ...args, idempotencyKey: key }),
        idempotencyKey,
      );
    }
    if (toolName === 'bridge_chat_publish_artifact') {
      if (!args.artifact) throw new Error('artifact is required');
      return writeOnce(
        (key) => this.backend.publishArtifact({ ...args, idempotencyKey: key }),
        idempotencyKey,
      );
    }
    if (toolName === 'bridge_chat_finish') {
      return writeOnce(
        (key) => this.backend.finishWork({ ...args, idempotencyKey: key }),
        idempotencyKey,
      );
    }
    throw new Error(`Unknown work-reporter tool: ${toolName}`);
  }

  async acknowledgeAnnouncement(args) {
    if (this.profile !== 'voice-controller') {
      throw new Error('Announcement acknowledgement is only available to voice-controller');
    }
    requireString(args.noticeId, 'noticeId');
    if (!['spoken', 'interrupted', 'failed'].includes(args.deliveryStatus)) {
      throw new Error('deliveryStatus must be spoken, interrupted, or failed');
    }
    return this.backend.ackAnnouncement(args);
  }
}
