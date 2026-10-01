'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { createDatabase, defaultDatabasePath } = require('../database.cjs');
const { normalizeError, PersistenceError } = require('../errors.cjs');
const { publicCall, unwrapRepository } = require('./common.cjs');

let database = null;
let repositories = null;
let configuredPath = null;
let configuredTimeout = 5000;

function openStore() {
  if (!database || !database.isOpen) {
    database = createDatabase({ filePath: configuredPath || defaultDatabasePath(), timeout: configuredTimeout });
    repositories = unwrapRepository({
      projects: require('../repositories/projects.cjs')(database),
      environments: require('../repositories/environments.cjs')(database),
      checkouts: require('../repositories/checkouts.cjs')(database),
      requirements: require('../repositories/requirements.cjs')(database),
      sessions: require('../repositories/sessions.cjs')(database),
      tasks: require('../repositories/tasks.cjs')(database),
      decisions: require('../repositories/decisions.cjs')(database),
      proposals: require('../repositories/proposals.cjs')(database),
      bugs: require('../repositories/bugs.cjs')(database),
      issues: require('../repositories/issues.cjs')(database),
      architecture: require('../repositories/architecture.cjs')(database),
      events: require('../repositories/events.cjs')(database),
      artifacts: require('../repositories/artifacts.cjs')(database),
      legacyIds: require('../repositories/legacy_ids.cjs')(database),
    });
  }
  return database;
}

// Repository access is lazy and process-scoped. No caller receives the DB handle.
function getRepositories() {
  openStore();
  return repositories;
}

function makeModule(key, names) {
  return Object.freeze(Object.fromEntries(names.map((name) => [name, publicCall((...args) => getRepositories()[key][name](...args))])));
}

function makeApiModule(factory) {
  return factory({
    getRepositories,
    transaction(callback) { return openStore().withTransaction(callback); },
  });
}

function initializePersistence(options = {}) {
  try {
    if (database?.isOpen) {
      const requested = options.filePath ? path.resolve(options.filePath) : configuredPath;
      if (requested && requested !== database.filePath) throw new PersistenceError('CONFLICT', 'Persistence is already initialized with a different database path');
      return { filePath: database.filePath, schemaVersion: database.schemaVersion };
    }
    if (options.filePath) configuredPath = path.resolve(options.filePath);
    if (options.timeout !== undefined) configuredTimeout = options.timeout;
    openStore();
    return { filePath: database.filePath, schemaVersion: database.schemaVersion };
  } catch (error) { throw normalizeError(error); }
}

function shutdownPersistence() {
  if (!database) return undefined;
  const result = database.close();
  if (!result.ok) throw normalizeError(new PersistenceError(result.error.code, result.error.message, result.error.details));
  database = null;
  repositories = null;
  return undefined;
}

const getDatabaseInfo = publicCall(() => {
  openStore();
  return { filePath: database.filePath, schemaVersion: database.schemaVersion };
});

const integrityCheck = publicCall(() => {
  openStore();
  const integrity = database.connection.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check);
  const foreignKeys = database.connection.prepare('PRAGMA foreign_key_check').all();
  return { ok: integrity.length === 1 && integrity[0] === 'ok' && foreignKeys.length === 0, integrity, foreignKeys };
});

async function backupDatabase(destinationPath) {
  try {
    openStore();
    if (!destinationPath) throw new PersistenceError('VALIDATION', 'destinationPath is required');
    const destination = path.resolve(String(destinationPath));
    if (destination === database.filePath) throw new PersistenceError('VALIDATION', 'Backup destination must differ from the source database');
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const { backup } = require('node:sqlite');
    await backup(database.connection, destination);
    return { filePath: destination };
  } catch (error) { throw normalizeError(error); }
}

// Public methods are organized by data module. Repositories remain private.
module.exports = Object.freeze({
  initializePersistence,
  shutdownPersistence,
  getDatabaseInfo,
  integrityCheck,
  backupDatabase,
  projects: makeModule('projects', ['create', 'get', 'list', 'update']),
  environments: makeModule('environments', ['register', 'list', 'touch']),
  checkouts: makeModule('checkouts', ['register', 'list', 'resolve']),
  requirements: makeApiModule(require('./requirements.cjs')),
  sessions: makeApiModule(require('./sessions.cjs')),
  tasks: makeModule('tasks', ['create', 'get', 'list', 'update', 'dependencies', 'setDependencies', 'addCommit', 'commits', 'recordExecution', 'executions']),
  decisions: makeModule('decisions', ['create', 'get', 'list', 'update', 'linkTask', 'appendEvent', 'events']),
  proposals: makeApiModule(require('./proposals.cjs')),
  bugs: makeModule('bugs', ['create', 'get', 'list', 'linkTask', 'update']),
  issues: makeApiModule(require('./issues.cjs')),
  architecture: makeModule('architecture', ['list', 'upsert']),
  events: makeModule('events', ['append', 'list']),
  artifacts: makeModule('artifacts', ['register', 'list']),
  legacyIds: makeModule('legacyIds', ['register', 'resolve']),
});
