import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { VoiceControlError } from './errors.mjs';

const MAX_EVENT_TEXT = 4000;

export function defaultEventDirectory(env = process.env) {
  return path.resolve(
    env.CODEX_CONTROL_EVENT_DIR || path.join(os.homedir(), '.codex-control', 'events'),
  );
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Existing deployments may enforce permissions through their parent directory.
  }
}

function appendJsonLine(filePath, value) {
  ensurePrivateDirectory(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const rows = [];
  const text = fs.readFileSync(filePath, 'utf8');
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new VoiceControlError(
        'event_store_corrupt',
        `Invalid JSON event at ${filePath}:${index + 1}`,
        { status: 500, cause: error },
      );
    }
  }
  return rows;
}

function eventText(value) {
  if (typeof value?.text === 'string') return value.text.trim();
  if (typeof value?.payload?.summary === 'string') return value.payload.summary.trim();
  if (typeof value?.payload?.message === 'string') return value.payload.message.trim();
  return '';
}

export class LocalVoiceEvents {
  constructor({ eventDir = null, taskFile = null } = {}) {
    const resolvedEventDir = eventDir || null;
    this.eventDir = resolvedEventDir ? path.resolve(resolvedEventDir) : null;
    this.taskFile = taskFile
      ? path.resolve(taskFile)
      : (this.eventDir ? path.join(this.eventDir, 'task-events.jsonl') : null);
    if (this.taskFile) ensurePrivateDirectory(path.dirname(this.taskFile));
  }

  readTaskEvents() {
    return this.taskFile ? readJsonLines(this.taskFile) : [];
  }

  static normalizeTaskEvent(value, { now = () => new Date(), idFactory = () => crypto.randomUUID() } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new VoiceControlError('invalid_event', 'event must be an object', { status: 400 });
    }
    const topic = typeof value.topic === 'string' ? value.topic.trim() : '';
    const text = eventText(value);
    if (!topic || topic.length > 128) {
      throw new VoiceControlError('invalid_event', 'event.topic is required', { status: 400 });
    }
    if (!text || text.length > MAX_EVENT_TEXT) {
      throw new VoiceControlError(
        'invalid_event',
        `event text must contain 1-${MAX_EVENT_TEXT} characters`,
        { status: 400 },
      );
    }
    const eventId = typeof value.eventId === 'string' && value.eventId.trim()
      ? value.eventId.trim()
      : `evt_${idFactory()}`;
    if (eventId.length > 256) {
      throw new VoiceControlError('invalid_event', 'event.eventId is too long', { status: 400 });
    }
    return {
      schemaVersion: 1,
      eventId,
      topic,
      text,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : now().toISOString(),
      sessionId: typeof value.sessionId === 'string' && value.sessionId.trim()
        ? value.sessionId.trim()
        : null,
      source: typeof value.source === 'string' && value.source.trim()
        ? value.source.trim().slice(0, 128)
        : 'bridge-control',
      payload: value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)
        ? value.payload
        : {},
    };
  }
}

export class TaskEventInbox {
  constructor({
    eventDir = null,
    taskFile = null,
    onEvent,
    intervalMs = 500,
  } = {}) {
    if (typeof onEvent !== 'function') throw new Error('onEvent is required');
    this.events = new LocalVoiceEvents(eventDir ? { eventDir } : { taskFile });
    this.onEvent = onEvent;
    this.intervalMs = intervalMs;
    this.seen = new Set();
    this.timer = null;
    this.polling = false;
  }

  poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const value of this.events.readTaskEvents()) {
        if (!value || typeof value.eventId !== 'string' || this.seen.has(value.eventId)) continue;
        this.seen.add(value.eventId);
        try {
          this.onEvent(value);
        } catch {
          // A malformed producer event is skipped; valid later events still flow.
        }
      }
    } finally {
      this.polling = false;
    }
  }

  start() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
