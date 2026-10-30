import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BridgeError } from './errors.mjs';

const TERMINAL_WORK = new Set(['completed', 'failed', 'interrupted', 'blocked', 'stopped']);

export function defaultEventDirectory(env = process.env) {
  return path.resolve(
    env.CODEX_CONTROL_EVENT_DIR || path.join(os.homedir(), '.codex-control', 'events'),
  );
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* Parent policy may be stricter. */ }
}

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const rows = [];
  const text = fs.readFileSync(filePath, 'utf8');
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new BridgeError(500, 'event_store_corrupt', `Invalid event at ${filePath}:${index + 1}`, {
        cause: error.message,
      });
    }
  }
  return rows;
}

function appendLine(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function eventId(value) {
  return `evt_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

export class ControlEventBus {
  constructor({
    eventDir = defaultEventDirectory(),
    now = () => new Date(),
  } = {}) {
    this.eventDir = path.resolve(eventDir);
    this.taskFile = path.join(this.eventDir, 'task-events.jsonl');
    this.transcriptFile = path.join(this.eventDir, 'voice-transcripts.jsonl');
    this.now = now;
    ensureDirectory(this.eventDir);
  }

  appendTaskEvent({ topic, text, workId = null, sessionId = null, payload = {}, dedupeKey }) {
    if (typeof topic !== 'string' || !topic.trim()) throw new Error('event topic is required');
    if (typeof text !== 'string' || !text.trim()) throw new Error('event text is required');
    const normalizedDedupe = String(dedupeKey || `${topic}:${this.now().toISOString()}`);
    const id = eventId(`${topic}\0${normalizedDedupe}`);
    const records = readLines(this.taskFile);
    const duplicate = records.find((record) => record.eventId === id);
    if (duplicate) return { duplicate: true, event: duplicate };
    const event = {
      schemaVersion: 1,
      eventId: id,
      noticeId: id,
      topic: topic.trim(),
      text: text.trim().slice(0, 4000),
      source: 'bridge-control',
      sessionId,
      workId,
      createdAt: this.now().toISOString(),
      payload,
      dedupeKey: normalizedDedupe,
    };
    appendLine(this.taskFile, event);
    return { duplicate: false, event };
  }

  readTaskEvents({ after = '0', limit = 100, topics = [], sessionId = null } = {}) {
    if (!/^(0|[1-9][0-9]*)$/.test(String(after))) {
      throw new BridgeError(409, 'cursor_resync', 'invalid event cursor');
    }
    const start = Number(after);
    const topicSet = new Set(Array.isArray(topics) ? topics : []);
    const records = readLines(this.taskFile);
    if (start > records.length) {
      throw new BridgeError(409, 'cursor_resync', 'event cursor is ahead of retained events', {
        lastCursor: String(records.length),
      });
    }
    const events = records
      .slice(start, start + Math.max(1, Math.min(100, Number(limit) || 100)))
      .filter((event) => !topicSet.size || topicSet.has(event.topic))
      .filter((event) => !sessionId || event.sessionId === sessionId || event.payload?.controlSessionId === sessionId);
    return {
      events,
      nextCursor: String(start + Math.min(records.length - start, Math.max(1, Math.min(100, Number(limit) || 100)))),
      lastCursor: String(records.length),
    };
  }

  latestTranscript(sessionId) {
    const records = readLines(this.transcriptFile)
      .filter((record) => record && record.sessionId === sessionId && typeof record.text === 'string');
    return records.at(-1) || null;
  }

  workIsTerminal(status) {
    return TERMINAL_WORK.has(status);
  }
}
