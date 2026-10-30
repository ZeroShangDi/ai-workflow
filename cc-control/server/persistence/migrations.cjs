'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PersistenceError } = require('./errors.cjs');
const { now } = require('./repositories/common.cjs');

const SCHEMA_DIR = path.join(__dirname, 'schema');

function migrationFiles() {
  return fs.readdirSync(SCHEMA_DIR)
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort()
    .map((name) => ({
      version: Number(name.match(/^(\d+)/)[1]),
      name,
      sql: fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8'),
    }));
}

function migrate(db) {
  const applied = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!applied) db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const getVersion = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations');
  const record = db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)');
  let current = Number(getVersion.get().version);
  for (const migration of migrationFiles()) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, now());
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
      current = migration.version;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction may already be rolled back */ }
      throw new PersistenceError('STORAGE', `Migration ${migration.name} failed: ${error.message}`);
    }
  }
  const maxFile = migrationFiles().at(-1)?.version ?? 0;
  if (current < maxFile) throw new PersistenceError('STORAGE', `Database migration incomplete: ${current}/${maxFile}`);
  return current;
}

module.exports = { migrate, migrationFiles, SCHEMA_DIR };
