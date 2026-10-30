'use strict';

const { publicCall, unwrap, bindMethods } = require('./common.cjs');
const { PersistenceError } = require('../errors.cjs');

// Starting a retry changes both the session projection and its attempt history.
module.exports = function sessionsApi({ getRepositories, transaction }) {
  const methods = bindMethods(() => getRepositories().sessions, [
    'create', 'get', 'list', 'finishAttempt', 'finish', 'attempts', 'linkConversation', 'conversations',
  ]);
  return Object.freeze({
    ...methods,
    startAttempt: publicCall((sessionId, input = {}) => transaction(() => {
      const repositories = getRepositories();
      if (!unwrap(repositories.sessions.get(sessionId))) throw new PersistenceError('NOT_FOUND', 'Session not found');
      const attempt = unwrap(repositories.sessions.createAttempt(sessionId, input));
      unwrap(repositories.sessions.markActive(sessionId, attempt.startedAt));
      return attempt;
    })),
  });
};
