'use strict';

const { normalizeError, PersistenceError } = require('../errors.cjs');

// Public methods return their data directly and throw normalized errors.
function publicCall(fn) {
  return (...args) => {
    try {
      const value = fn(...args);
      return value && typeof value.then === 'function'
        ? value.catch((error) => { throw normalizeError(error); })
        : value;
    } catch (error) {
      throw normalizeError(error);
    }
  };
}

// Internal repositories use Result wrappers; unwrap failures inside a transaction
// so they throw and trigger rollback.
function unwrap(result) {
  if (result?.ok === true) return result.data;
  if (result?.ok === false) {
    const failure = result.error || {};
    throw new PersistenceError(failure.code || 'STORAGE', failure.message || 'Persistence operation failed', failure.details);
  }
  return result;
}

// Repository modules use the shared result helper internally; translate those
// results back to exceptions inside the boundary so a unit of work can rollback.
function unwrapRepository(value) {
  if (typeof value === 'function') {
    return (...args) => {
      const result = value(...args);
      if (result && typeof result.then === 'function') return result.then(unwrap);
      return unwrap(result);
    };
  }
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unwrapRepository(child)])));
  }
  return value;
}

function bindMethods(getRepository, names) {
  return Object.freeze(Object.fromEntries(names.map((name) => [name, publicCall((...args) => {
    const repository = getRepository();
    return repository[name](...args);
  })])));
}

module.exports = { publicCall, unwrap, unwrapRepository, bindMethods };
