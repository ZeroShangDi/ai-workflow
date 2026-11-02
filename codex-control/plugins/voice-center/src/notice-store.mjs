import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TERMINAL = new Set(['spoken', 'interrupted', 'failed']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class NoticeStore {
  constructor({
    filePath,
    now = () => new Date(),
    idFactory = () => crypto.randomUUID(),
  }) {
    this.filePath = filePath ? path.resolve(filePath) : null;
    this.now = now;
    this.idFactory = idFactory;
    this.value = this.#load();
  }

  #load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return { notices: {} };
    const value = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (!value || typeof value !== 'object' || !value.notices) return { notices: {} };
    return value;
  }

  #write() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  accept(event) {
    const noticeId = typeof event.noticeId === 'string' && event.noticeId.trim()
      ? event.noticeId.trim().slice(0, 256)
      : event.eventId;
    if (!noticeId || typeof event.text !== 'string' || !event.text.trim()) {
      throw new Error('noticeId and text are required');
    }
    const existing = this.value.notices[noticeId];
    if (existing) return { notice: clone(existing), duplicate: true };
    const createdAt = this.now().toISOString();
    const notice = {
      noticeId,
      eventId: event.eventId || `evt_${this.idFactory()}`,
      topic: event.topic || 'task.progress',
      text: event.text.trim().slice(0, 4000),
      sessionId: event.sessionId || null,
      source: event.source || 'bridge-control',
      createdAt,
      updatedAt: createdAt,
      status: 'queued',
      deliveredAt: null,
      acknowledgedAt: null,
      error: null,
    };
    this.value.notices[noticeId] = notice;
    const entries = Object.entries(this.value.notices)
      .sort((left, right) => Date.parse(left[1].updatedAt) - Date.parse(right[1].updatedAt));
    for (const [id] of entries.slice(0, Math.max(0, entries.length - 500))) {
      delete this.value.notices[id];
    }
    this.#write();
    return { notice: clone(notice), duplicate: false };
  }

  markDelivered(noticeId, sessionId) {
    const notice = this.value.notices[noticeId];
    if (!notice) return null;
    notice.status = 'queued';
    notice.deliveredAt = notice.deliveredAt || this.now().toISOString();
    notice.updatedAt = this.now().toISOString();
    notice.deliverySessionId = sessionId;
    this.#write();
    return clone(notice);
  }

  acknowledge(noticeId, status, error = null) {
    if (!TERMINAL.has(status)) throw new Error('invalid notice status');
    const notice = this.value.notices[noticeId];
    if (!notice) return null;
    notice.status = status;
    notice.error = error;
    notice.acknowledgedAt = this.now().toISOString();
    notice.updatedAt = notice.acknowledgedAt;
    this.#write();
    return clone(notice);
  }

  pending({ sessionId = null } = {}) {
    return Object.values(this.value.notices)
      .filter((notice) => !TERMINAL.has(notice.status))
      .filter((notice) => !sessionId || !notice.sessionId || notice.sessionId === sessionId)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
      .map(clone);
  }

  get(noticeId) {
    const value = this.value.notices[noticeId];
    return value ? clone(value) : null;
  }

  summary() {
    const notices = Object.values(this.value.notices);
    return {
      total: notices.length,
      pending: notices.filter((notice) => !TERMINAL.has(notice.status)).length,
    };
  }
}
