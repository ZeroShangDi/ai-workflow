import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { eventForDelivery, normalizeEvent } from './ws-protocol.mjs';

export class WsEventStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        topic TEXT NOT NULL,
        source TEXT NOT NULL,
        correlation_id TEXT,
        created_at TEXT NOT NULL,
        event_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_topic_cursor ON events(topic, cursor);
    `);
  }

  append(value) {
    const event = normalizeEvent(value);
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO events(event_id, topic, source, correlation_id, created_at, event_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      event.eventId,
      event.topic,
      event.source,
      event.correlationId,
      event.createdAt,
      JSON.stringify(event),
    );
    const row = this.db.prepare('SELECT cursor, event_json FROM events WHERE event_id = ?').get(event.eventId);
    return eventForDelivery(JSON.parse(row.event_json), row.cursor);
  }

  after(cursor, { topics = [], limit = 500 } = {}) {
    const start = Number(cursor || 0);
    if (!Number.isSafeInteger(start) || start < 0) throw new Error('cursor must be a non-negative integer');
    const bounded = Math.max(1, Math.min(1000, Number(limit) || 500));
    const rows = this.db.prepare(`
      SELECT cursor, event_json FROM events
      WHERE cursor > ?
      ORDER BY cursor ASC
      LIMIT ?
    `).all(start, bounded * Math.max(1, topics.length));
    return rows
      .map((row) => eventForDelivery(JSON.parse(row.event_json), row.cursor))
      .filter((event) => !topics.length || topics.some((topic) => {
        if (topic === event.topic) return true;
        return topic.endsWith('.*') && event.topic.startsWith(topic.slice(0, -1));
      }))
      .slice(0, bounded);
  }

  close() {
    this.db.close();
  }
}
