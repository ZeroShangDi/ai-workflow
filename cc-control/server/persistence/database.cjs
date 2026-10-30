'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { errorResult, PersistenceError } = require('./errors.cjs');
const { migrate } = require('./migrations.cjs');

function defaultDatabasePath() {
  return path.join(os.homedir(), '.awf', 'awf.sqlite');
}

function loadDriver() {
  try { return require('node:sqlite'); } catch (error) {
    throw new PersistenceError('STORAGE', `node:sqlite is unavailable in this Node.js runtime (${error.code || error.message}); use a Node.js version that provides node:sqlite`);
  }
}

function openConnection({ filePath = defaultDatabasePath(), readOnly = false, timeout = 5000 } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new PersistenceError('VALIDATION', 'filePath must be a non-empty string');
  }
  if (!readOnly) fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = loadDriver();
  const connection = new DatabaseSync(filePath, {
    readOnly,
    enableForeignKeyConstraints: true,
    timeout,
    defensive: true,
  });
  connection.exec('PRAGMA foreign_keys = ON');
  connection.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(timeout))}`);
  if (!readOnly) {
    connection.exec('PRAGMA journal_mode = WAL');
    connection.exec('PRAGMA synchronous = NORMAL');
  }
  return { connection, filePath: path.resolve(filePath) };
}

function createDatabase({ filePath, readOnly = false, timeout = 5000 } = {}) {
  const opened = openConnection({ filePath, readOnly, timeout });
  const connection = opened.connection;
  let closed = false;
  let transactionDepth = 0;
  let savepointSeq = 0;

  function assertOpen() {
    if (closed) throw new PersistenceError('CLOSED', 'Database handle is closed');
  }

  function withTransaction(fn) {
    assertOpen();
    if (readOnly) throw new PersistenceError('STORAGE', 'Cannot write through a read-only database handle');
    const nested = transactionDepth > 0;
    const savepoint = nested ? `awf_sp_${++savepointSeq}` : null;
    connection.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    transactionDepth += 1;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        throw new PersistenceError('VALIDATION', 'SQLite transaction callbacks must be synchronous; do not return a Promise');
      }
      connection.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      try {
        connection.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK');
        if (nested) connection.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } catch { /* preserve original error */ }
      throw error;
    } finally {
      transactionDepth -= 1;
    }
  }

  function close() {
    if (closed) return { ok: true, data: undefined };
    try {
      connection.close();
      closed = true;
      return { ok: true, data: undefined };
    } catch (error) { return errorResult(error); }
  }

  let schemaVersion = 0;
  try {
    if (!readOnly) schemaVersion = migrate(connection);
    else schemaVersion = Number(connection.prepare('PRAGMA user_version').get().user_version);
  } catch (error) {
    try { connection.close(); } catch { /* ignore cleanup failure */ }
    throw error;
  }

  return {
    filePath: opened.filePath,
    schemaVersion,
    readOnly,
    get isOpen() { return !closed; },
    connection,
    withTransaction,
    transaction(callback) {
      try { return { ok: true, data: withTransaction(callback) }; }
      catch (error) { return errorResult(error); }
    },
    close,
  };
}

module.exports = { createDatabase, defaultDatabasePath, openConnection };
