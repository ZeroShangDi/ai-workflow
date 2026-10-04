'use strict';
const http = require('node:http');
const path = require('node:path');

function post(port, projectRoot, endpoint, body = {}) {
  const url = new URL(endpoint, `http://127.0.0.1:${port}`);
  url.searchParams.set('p', projectRoot);
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        try {
          const result = JSON.parse(text);
          if (response.statusCode >= 400 || !result.ok) reject(new Error(result.error || `HTTP ${response.statusCode}`));
          else resolve(result);
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.setTimeout(90000, () => request.destroy(new Error('闲时任务启动超时')));
    request.end(payload);
  });
}

function createIdleScheduler({ app, registry, anyHostActive, touch, port, submit = post }) {
  let timer = null;
  let running = false;
  async function tick() {
    if (running || anyHostActive()) return;
    if (registry.all().some(runtime => runtime.session?.state === 'busy')) return;
    running = true;
    try {
      const claims = app.listActiveWorkClaims();
      if (claims.length) {
        const claim = claims.length === 1 ? claims[0] : null;
        if (claim?.owner === 'idle' && claim.worktreePath) {
          const checkout = app.listProjects().find(entry => entry.checkout.rootPath === claim.worktreePath || entry.checkout.rootPath.startsWith(`${claim.worktreePath}${path.sep}`));
          const projectPath = checkout?.checkout.rootPath;
          if (claim.itemType === 'requirement' && projectPath) {
            const requirement = app.getRequirement(projectPath, claim.itemId);
            const state = registry.runtimeFor(projectPath).ctx.stores.state.readSync() || {};
            if (requirement?.lifecycleStatus === 'todo' && state.mode !== 'run') {
              touch?.();
              await submit(port, projectPath, '/api/persistence/run/start', { requirementId: requirement.id });
            }
            return;
          }
          if (claim.itemType !== 'bug') return;
          const hidden = projectPath && app.listRequirements(projectPath, { workKind: 'bugfix', limit: 200 }).items.find(row => row.originBugId === claim.itemId);
          if (hidden?.lifecycleStatus === 'draft') {
            const planSession = app.listRequirementSessions(projectPath, hidden.id, { kind: 'plan', limit: 1 })?.items?.[0];
            if (planSession?.status === 'completed') {
              const state = registry.runtimeFor(projectPath).ctx.stores.state.readSync() || {};
              app.syncTasksFromState(projectPath, state.tasks || [], hidden.id);
              if (app.listTasks(projectPath, hidden.id)?.length) app.approvePlan(projectPath, hidden.id, hidden.revision);
            }
            return;
          }
          if (hidden?.lifecycleStatus === 'todo') {
            touch?.();
            await submit(port, projectPath, '/api/persistence/run/start', { requirementId: hidden.id });
          }
        }
        return;
      }
      for (const entry of app.listProjects()) {
        const root = entry.checkout.rootPath;
        // Managed worktrees are execution checkouts, not independent projects.
        if (root.includes(`${path.sep}.awf${path.sep}worktrees${path.sep}`)) continue;
        const config = app.readWorkConfig(root);
        if (!config.git) continue;
        const state = registry.runtimeFor(root).ctx.stores.state.readSync() || {};
        if (state.mode && state.mode !== 'idle') continue;
        const activeId = app.ensureProject(root).project.activeRequirementId;
        const requirement = activeId ? app.getRequirement(root, activeId) : null;
        if (requirement?.workKind === 'requirement' && requirement.lifecycleStatus === 'todo' && requirement.allowAiWork) {
          touch?.();
          const prepared = await submit(port, root, `/api/persistence/requirements/${encodeURIComponent(requirement.id)}/prepare-worktree`, { owner: 'idle' });
          await submit(port, prepared.data.projectPath, '/api/persistence/run/start', { requirementId: requirement.id });
          return;
        }
        const bug = app.listBugs(root).find(row => !row.requirementId && row.lifecycleStatus === 'open' && row.allowAiWork);
        if (bug) {
          touch?.();
          const prepared = await submit(port, root, `/api/persistence/bugs/${encodeURIComponent(bug.id)}/prepare-worktree`, { owner: 'idle' });
          await submit(port, prepared.data.projectPath, '/api/persistence/plan/prepare', { requirementId: prepared.data.requirementId, launch: true });
          return;
        }
      }
    } catch (error) {
      console.warn(`[idle-work] ${error.message}`);
    } finally { running = false; }
  }
  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, 30000);
      timer.unref?.();
      setTimeout(() => { void tick(); }, 5000).unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    tick,
  };
}

module.exports = { createIdleScheduler };
