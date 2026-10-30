'use strict';

const { publicCall, unwrap, bindMethods } = require('./common.cjs');

// A proposal status change and its audit event form one atomic operation.
module.exports = function proposalsApi({ getRepositories, transaction }) {
  const methods = bindMethods(() => getRepositories().proposals, ['create', 'get', 'list', 'events']);
  return Object.freeze({
    ...methods,
    recordEvent: publicCall((id, input = {}) => transaction(() => {
      const repository = getRepositories().proposals;
      const event = unwrap(repository.createEvent(id, input));
      if (input.status) unwrap(repository.updateStatus(id, input.status));
      return event;
    })),
  });
};
