'use strict';

class PersistenceError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'PersistenceError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function errorResult(error) {
  if (error instanceof PersistenceError) {
    return { ok: false, error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } };
  }
  const rawMessage = String(error?.message || error || 'Persistence error');
  const isConstraint = /SQLITE_CONSTRAINT|constraint failed|UNIQUE constraint|FOREIGN KEY constraint/i.test(rawMessage);
  const code = isConstraint ? 'CONFLICT' : 'STORAGE';
  return { ok: false, error: { code, message: isConstraint ? 'Database constraint conflict' : 'Persistence operation failed' } };
}

function normalizeError(error) {
  if (error instanceof PersistenceError) return error;
  const normalized = errorResult(error).error;
  return new PersistenceError(normalized.code, normalized.message, normalized.details);
}

function protect(fn) {
  try {
    return { ok: true, data: fn() };
  } catch (error) {
    return errorResult(error);
  }
}

module.exports = { PersistenceError, errorResult, normalizeError, protect };
