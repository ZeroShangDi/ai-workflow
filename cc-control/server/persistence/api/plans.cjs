'use strict';

const { publicCall, unwrap } = require('./common.cjs');

/** Save a reviewed plan as one transaction across its requirement and task rows. */
module.exports = function plansApi({ getRepositories, transaction }) {
  return Object.freeze({
    save: publicCall((input = {}) => transaction(() => {
      const repositories = getRepositories();
      const requirementId = input.requirementId;
      const requirement = unwrap(repositories.requirements.update(requirementId, {
        summary: String(input.summary || ''),
        status: 'planned',
        expectedRevision: input.version,
      }));
      const tasks = [];
      for (const task of input.tasks || []) {
        const existing = unwrap(repositories.tasks.get(task.id));
        if (!existing || existing.requirementId !== requirementId) continue;
        const updated = unwrap(repositories.tasks.update(task.id, {
          title: task.title,
          acceptance: JSON.stringify(task.acceptance || []),
          expectedRevision: task.revision,
        }));
        if (Array.isArray(task.deps)) unwrap(repositories.tasks.setDependencies(task.id, task.deps));
        tasks.push(updated);
      }
      return { requirement, tasks };
    })),
    approve: publicCall((input = {}) => transaction(() => {
      const repositories = getRepositories();
      const requirement = unwrap(repositories.requirements.update(input.requirementId, {
        status: 'planned', expectedRevision: input.version,
      }));
      if (input.planSessionId) unwrap(repositories.sessions.finish(input.planSessionId, { status: 'completed' }));
      return { requirement };
    })),
  });
};
