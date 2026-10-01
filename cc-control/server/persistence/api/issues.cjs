'use strict';

const { publicCall, unwrap, bindMethods } = require('./common.cjs');
const { PersistenceError } = require('../errors.cjs');

// Promotion is a business operation spanning issue, requirement and event rows.
module.exports = function issuesApi({ getRepositories, transaction }) {
  const methods = bindMethods(() => getRepositories().issues, ['get', 'list', 'events']);
  return Object.freeze({
    ...methods,
    create: publicCall((input = {}) => transaction(() => {
      const repository = getRepositories().issues;
      const issue = unwrap(repository.create(input));
      unwrap(repository.recordEvent(issue.id, 'created'));
      return issue;
    })),
    update: publicCall((id, input = {}) => transaction(() => {
      const repository = getRepositories().issues;
      const issue = unwrap(repository.update(id, input));
      if (Object.keys(input).length) unwrap(repository.recordEvent(id, 'updated', input));
      return issue;
    })),
    promote: publicCall((id, input = {}) => transaction(() => {
      const repositories = getRepositories();
      const issue = unwrap(repositories.issues.get(id));
      if (!issue) throw new PersistenceError('NOT_FOUND', 'Issue not found');

      let requirementId = issue.requirementId;
      if (!requirementId) {
        const requirement = unwrap(repositories.requirements.create({
          id: input.requirementId,
          projectId: issue.projectId,
          title: input.title || issue.title,
          requestText: input.requestText || issue.body,
        }));
        requirementId = requirement.id;
      }

      unwrap(repositories.issues.assignRequirement(id, requirementId));
      unwrap(repositories.issues.recordEvent(id, 'promoted', { requirementId }));
      return {
        issue: unwrap(repositories.issues.get(id)),
        requirement: unwrap(repositories.requirements.get(requirementId)),
      };
    })),
  });
};
