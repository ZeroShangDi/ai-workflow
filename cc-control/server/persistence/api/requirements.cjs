'use strict';

const { publicCall, unwrap, bindMethods } = require('./common.cjs');

// Public requirement API. The create method can atomically create its initial
// plan session; callers never coordinate table writes themselves.
module.exports = function requirementsApi({ getRepositories, transaction }) {
  const requirementMethods = bindMethods(() => getRepositories().requirements, ['get', 'list', 'update']);
  const milestoneMethods = bindMethods(() => getRepositories().requirements.milestones, ['create', 'update', 'delete', 'list', 'setTasks', 'tasks']);

  return Object.freeze({
    ...requirementMethods,
    create: publicCall((input = {}) => unwrap(getRepositories().requirements.create(input))),
    createWithPlan: publicCall((input = {}) => transaction(() => {
      const repos = getRepositories();
      const requirement = unwrap(repos.requirements.create(input.requirement || input));
      const planSession = unwrap(repos.sessions.create({
        ...(input.plan || {}),
        requirementId: requirement.id,
        kind: 'plan',
      }));
      return { requirement, planSession };
    })),
    milestones: milestoneMethods,
  });
};
