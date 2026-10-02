'use strict';

/**
 * Server-owned persistence application boundary.
 *
 * The HTTP API and project runtime depend on this application service, never on
 * SQLite internals. It owns stable project/environment identity and translates
 * a local checkout path into the IDs used by persistence APIs.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const defaultPersistence = require('../persistence/index.cjs');

const MANIFEST_VERSION = 1;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read persistence identity file ${filePath}: ${error.message}`);
  }
}

/** Create a file once; concurrent Server processes use whichever identity won. */
function createJsonIfMissing(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.closeSync(fd);
    fd = undefined;
    // link is atomic and fails if another process already created the identity.
    fs.linkSync(temporaryPath, filePath);
    fs.unlinkSync(temporaryPath);
    return value;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporaryPath); } catch { /* already moved/removed */ }
    if (error.code !== 'EEXIST') throw error;
    return readJson(filePath);
  }
}

function ensureProjectManifest(projectRoot) {
  const root = path.resolve(projectRoot);
  const filePath = path.join(root, '.awf', 'project.json');
  const existing = readJson(filePath);
  if (existing) {
    if (typeof existing.projectId !== 'string' || !existing.projectId.trim()) {
      throw new Error(`Invalid project identity manifest: ${filePath}`);
    }
    return { ...existing, projectId: existing.projectId };
  }
  return createJsonIfMissing(filePath, {
    version: MANIFEST_VERSION,
    projectId: crypto.randomUUID(),
  });
}

function createPersistenceApplication({ persistenceApi = defaultPersistence, environmentFilePath, databaseFilePath } = {}) {
  if (databaseFilePath) persistenceApi.initializePersistence({ filePath: databaseFilePath });
  const environmentPath = path.resolve(environmentFilePath || path.join(os.homedir(), '.awf', 'environment.json'));
  let environment = null;
  const projects = new Map();

  function unwrap(result) {
    if (result && Object.hasOwn(result, 'ok') && result.ok === false) {
      const error = new Error(result.error?.message || 'Persistence operation failed');
      error.code = result.error?.code || 'STORAGE';
      throw error;
    }
    return result && result.ok === true && Object.hasOwn(result, 'data') ? result.data : result;
  }

  function ensureEnvironment() {
    if (environment) return environment;
    const existing = readJson(environmentPath);
    if (existing && typeof existing.id === 'string' && existing.id.trim()) {
      environment = existing;
    } else if (existing) {
      throw new Error(`Invalid environment identity file: ${environmentPath}`);
    } else {
      environment = createJsonIfMissing(environmentPath, {
        version: 1,
        id: crypto.randomUUID(),
      });
    }
    return environment;
  }

  /** Register (or refresh) a project checkout and return its persistent IDs. */
  function ensureProject(projectRoot) {
    const rootPath = path.resolve(projectRoot);
    const registered = projects.get(rootPath);
    if (registered) return registered;
    const manifest = ensureProjectManifest(rootPath);
    const env = ensureEnvironment();
    let project = unwrap(persistenceApi.projects.get(manifest.projectId));
    if (!project) {
      project = unwrap(persistenceApi.projects.create({
        id: manifest.projectId,
        name: path.basename(rootPath),
      }));
    }
    const registeredEnvironment = unwrap(persistenceApi.environments.register({ id: env.id }));
    const checkout = unwrap(persistenceApi.checkouts.register({
      projectId: project.id,
      environmentId: registeredEnvironment.id,
      rootPath,
    }));
    const result = Object.freeze({ project, environment: registeredEnvironment, checkout });
    projects.set(rootPath, result);
    return result;
  }

  function getRequirement(projectRoot, requirementId) {
    const { project } = ensureProject(projectRoot);
    const requirement = persistenceApi.requirements.get(requirementId);
    return requirement?.projectId === project.id ? requirement : null;
  }

  function listRequirements(projectRoot, filters = {}) {
    const { project } = ensureProject(projectRoot);
    return unwrap(persistenceApi.requirements.list({ ...filters, projectId: project.id }));
  }

  function createRequirementWithPlan(projectRoot, input = {}) {
    const { project, environment } = ensureProject(projectRoot);
    const requirement = { ...(input.requirement || {}), projectId: project.id };
    const plan = input.plan ? { ...input.plan, originEnvironmentId: environment.id } : undefined;
    const result = unwrap(persistenceApi.requirements.createWithPlan({ requirement, plan }));
    updateProject(projectRoot, { activeRequirementId: result.requirement.id });
    return result;
  }

  function listRequirementSessions(projectRoot, requirementId, filters = {}) {
    if (!getRequirement(projectRoot, requirementId)) return null;
    return unwrap(persistenceApi.sessions.list({ ...filters, requirementId }));
  }

  function listProjects() {
    const rows = unwrap(persistenceApi.projects.list({ limit: 200 })).items;
    const env = ensureEnvironment();
    return rows.flatMap((project) => unwrap(persistenceApi.checkouts.list({ projectId: project.id, environmentId: env.id })).map((checkout) => ({
      project: { id: project.id, name: project.name, status: project.status }, environmentId: env.id, checkout,
    })));
  }

  function isProjectRegistered(projectRoot) {
    const root = path.resolve(projectRoot);
    return listProjects().some((row) => path.resolve(row.checkout.rootPath) === root);
  }

  function projectData(projectRoot) { return workspaceData(projectRoot); }

  function listTasks(projectRoot, requirementId) {
    const requirement = getRequirement(projectRoot, requirementId);
    if (!requirement) return null;
    return unwrap(persistenceApi.tasks.list({ requirementId, limit: 200 })).items.map((row) => {
      const detail = row.details || {};
      let acceptance = row.acceptance || [];
      if (typeof acceptance === 'string') {
        try { acceptance = JSON.parse(acceptance); } catch { acceptance = acceptance.split('\n').filter(Boolean); }
      }
      return {
        ...row,
        acceptance: Array.isArray(acceptance) ? acceptance : [],
        deps: unwrap(persistenceApi.tasks.dependencies(row.id)).map((dep) => dep.id),
        files: detail.files || [],
        wbsRef: detail.wbsRef || null,
      };
    });
  }

  function updateProject(projectRoot, patch) {
    const context = ensureProject(projectRoot);
    const project = unwrap(persistenceApi.projects.update(context.project.id, patch));
    const updated = Object.freeze({ ...context, project });
    projects.set(path.resolve(projectRoot), updated);
    return project;
  }

  function updateRequirement(projectRoot, requirementId, patch) {
    if (!getRequirement(projectRoot, requirementId)) return null;
    return unwrap(persistenceApi.requirements.update(requirementId, patch));
  }

  function listProjectSessions(projectRoot) {
    const rows = projectData(projectRoot).requirements;
    return rows.flatMap((row) => unwrap(persistenceApi.sessions.list({ requirementId: row.id, limit: 200 })).items)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  function updateDecision(projectRoot, id, status, payload = {}) {
    const { project } = ensureProject(projectRoot);
    const row = unwrap(persistenceApi.decisions.get(id));
    if (!row || row.projectId !== project.id) return null;
    const storedStatus = status === 'approved' ? 'resolved' : status;
    const updated = unwrap(persistenceApi.decisions.update(id, { status: storedStatus }));
    unwrap(persistenceApi.decisions.appendEvent(id, {
      eventType: status === 'overridden' ? 'decision_overridden' : 'decision_reviewed',
      payload, actorType: 'human',
      idempotencyKey: `${status}:${payload.reviewer || ''}:${payload.note || payload.instruction || ''}`,
    }));
    return updated;
  }

  function updateProposal(projectRoot, id, status, payload = {}) {
    const { project } = ensureProject(projectRoot);
    const row = unwrap(persistenceApi.proposals.get(id));
    if (!row || row.projectId !== project.id) return null;
    return unwrap(persistenceApi.proposals.recordEvent(id, { eventType: status, status, payload, }));
  }

  function updateTask(projectRoot, id, patch) {
    const row = unwrap(persistenceApi.tasks.get(id));
    if (!row) return null;
    const requirement = getRequirement(projectRoot, row.requirementId);
    if (!requirement) return null;
    return unwrap(persistenceApi.tasks.update(id, patch));
  }

  function createRunSession(projectRoot, requirementId, { runId, title, logDir } = {}) {
    const context = ensureProject(projectRoot);
    if (!getRequirement(projectRoot, requirementId)) return null;
    const session = unwrap(persistenceApi.sessions.create({
      requirementId, kind: 'run', status: 'created', title: title || 'Run',
      // 省略 logDir 时由 sessions repository 按实际 sessionId 生成稳定目录。
      logDir,
      originEnvironmentId: context.environment.id,
    }));
    const attempt = unwrap(persistenceApi.sessions.startAttempt(session.id, {
      environmentId: context.environment.id,
      provider: context.project.name,
      runId,
    }));
    return { session, attempt };
  }

  /** Reuse one Run conversation per requirement; interruptions create attempts, not new sessions. */
  function startRunSession(projectRoot, requirementId, { title, logDir, runId } = {}) {
    const context = ensureProject(projectRoot);
    if (!getRequirement(projectRoot, requirementId)) return null;
    const existing = unwrap(persistenceApi.sessions.list({ requirementId, kind: 'run', limit: 200 })).items[0];
    const session = existing || unwrap(persistenceApi.sessions.create({
      requirementId, kind: 'run', status: 'created', title: title || 'Run',
      logDir,
      originEnvironmentId: context.environment.id,
    }));
    if (existing) {
      for (const prior of unwrap(persistenceApi.sessions.attempts(session.id))) {
        if (prior.status === 'running') unwrap(persistenceApi.sessions.finishAttempt(prior.id, { status: 'interrupted', errorText: 'A later Run attempt replaced this unfinished attempt' }));
      }
    }
    const attempt = unwrap(persistenceApi.sessions.startAttempt(session.id, {
      environmentId: context.environment.id, provider: context.project.name, runId,
    }));
    return { session, attempt };
  }

  function finishSessionAttempt(projectRoot, sessionId, attemptId, { status = 'completed', errorText = null, finishSession = false } = {}) {
    const session = unwrap(persistenceApi.sessions.get(sessionId));
    if (!session || !getRequirement(projectRoot, session.requirementId)) return null;
    const ownsAttempt = unwrap(persistenceApi.sessions.attempts(sessionId)).some((item) => item.id === attemptId);
    if (!ownsAttempt) return null;
    const attempt = unwrap(persistenceApi.sessions.finishAttempt(attemptId, { status, errorText }));
    if (finishSession) unwrap(persistenceApi.sessions.finish(sessionId, { status }));
    return attempt;
  }

  function startPlanSession(projectRoot, requirementId) {
    const context = ensureProject(projectRoot);
    if (!getRequirement(projectRoot, requirementId)) return null;
    const sessions = unwrap(persistenceApi.sessions.list({ requirementId, kind: 'plan', limit: 200 })).items;
    const session = sessions[0];
    if (!session) return null;
    const attempt = unwrap(persistenceApi.sessions.startAttempt(session.id, {
      environmentId: context.environment.id, provider: context.project.name,
    }));
    updateRequirement(projectRoot, requirementId, { status: 'in_progress' });
    return { session, attempt };
  }

  function finishPlanSession(projectRoot, requirementId, status = 'completed') {
    if (!getRequirement(projectRoot, requirementId)) return null;
    const session = unwrap(persistenceApi.sessions.list({ requirementId, kind: 'plan', limit: 200 })).items[0];
    if (!session) return null;
    for (const attempt of unwrap(persistenceApi.sessions.attempts(session.id))) {
      if (attempt.status === 'running') unwrap(persistenceApi.sessions.finishAttempt(attempt.id, { status }));
    }
    return unwrap(persistenceApi.sessions.finish(session.id, { status }));
  }

  function recordDecisionRequested(projectRoot, input = {}) {
    const context = ensureProject(projectRoot);
    const requirement = input.requirementId
      ? getRequirement(projectRoot, input.requirementId)
      : workspaceData(projectRoot).activeRequirement;
    if (!requirement) return null;
    let session = input.sessionId ? unwrap(persistenceApi.sessions.get(input.sessionId)) : null;
    if (!session && input.externalConversationId) {
      const candidates = unwrap(persistenceApi.sessions.list({ requirementId: requirement.id, limit: 200 })).items;
      session = candidates.find((candidate) => unwrap(persistenceApi.sessions.conversations(candidate.id))
        .some((conversation) => conversation.provider === input.provider
          && conversation.externalConversationId === input.externalConversationId)) || null;
    }
    if (!session) session = unwrap(persistenceApi.sessions.list({ requirementId: requirement.id, kind: 'run', limit: 1 })).items[0]
      || unwrap(persistenceApi.sessions.list({ requirementId: requirement.id, kind: 'plan', limit: 1 })).items[0];
    const row = unwrap(persistenceApi.decisions.create({
      id: input.id, projectId: context.project.id, requirementId: requirement.id,
      sessionId: session?.id, decisionType: input.decisionType || 'text', status: 'open', question: input.question,
    }));
    unwrap(persistenceApi.decisions.appendEvent(row.id, {
      eventType: 'decision_requested', payload: { options: input.options || [], context: input.context || null },
      actorType: 'agent', idempotencyKey: `requested:${row.id}`,
    }));
    if (input.taskId) unwrap(persistenceApi.decisions.linkTask(row.id, input.taskId));
    return row;
  }

  function recordDecisionAnswered(projectRoot, decisionId, input = {}) {
    const { project } = ensureProject(projectRoot);
    const row = unwrap(persistenceApi.decisions.get(decisionId));
    if (!row || row.projectId !== project.id) return null;
    const updated = unwrap(persistenceApi.decisions.update(decisionId, { status: 'resolved', result: { value: input.value } }));
    unwrap(persistenceApi.decisions.appendEvent(decisionId, {
      eventType: 'decision_completed', payload: { value: input.value },
      actorType: input.answeredBy === 'human' ? 'human' : 'agent', actorId: input.answeredBy || null,
      idempotencyKey: `answered:${decisionId}`,
    }));
    return updated;
  }

  function recordDecisionCompleted(projectRoot, decisionId, result = {}) {
    const { project } = ensureProject(projectRoot);
    let row = unwrap(persistenceApi.decisions.get(decisionId));
    if (!row) row = recordDecisionRequested(projectRoot, {
      id: decisionId, decisionType: result.type || 'agent', question: result.question || '',
    });
    if (!row || row.projectId !== project.id) return null;
    const updated = unwrap(persistenceApi.decisions.update(decisionId, { status: result.finality === 'deferred' ? 'deferred' : 'resolved', result }));
    unwrap(persistenceApi.decisions.appendEvent(decisionId, {
      eventType: 'decision_completed', payload: result, actorType: 'agent',
      idempotencyKey: `completed:${decisionId}`,
    }));
    return updated;
  }

  function linkSessionConversation(sessionId, { provider, externalConversationId } = {}) {
    return unwrap(persistenceApi.sessions.linkConversation(sessionId, { provider, externalConversationId }));
  }

  function linkActiveSessionConversation(projectRoot, input = {}) {
    const context = ensureProject(projectRoot);
    const requirementId = context.project.activeRequirementId;
    if (!requirementId || !input.externalConversationId) return null;
    const sessions = unwrap(persistenceApi.sessions.list({ requirementId, limit: 200 })).items
      .filter((session) => ['created', 'active'].includes(session.status))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const alreadyLinked = sessions.find((session) => unwrap(persistenceApi.sessions.conversations(session.id))
      .some((conversation) => conversation.provider === input.provider
        && conversation.externalConversationId === String(input.externalConversationId)));
    if (alreadyLinked) return alreadyLinked;
    return sessions[0] ? linkSessionConversation(sessions[0].id, input) : null;
  }

  function appendSessionLog(projectRoot, externalConversationId, { role, text } = {}) {
    if (!externalConversationId || !text) return false;
    const context = ensureProject(projectRoot);
    const requirementRows = unwrap(persistenceApi.requirements.list({ projectId: context.project.id, limit: 200 })).items;
    const sessions = requirementRows.flatMap((requirement) => unwrap(persistenceApi.sessions.list({ requirementId: requirement.id, limit: 200 })).items);
    const session = sessions.find((row) => unwrap(persistenceApi.sessions.conversations(row.id))
      .some((conversation) => conversation.externalConversationId === String(externalConversationId)));
    if (!session?.logDir) return false;
    const root = path.resolve(projectRoot);
    const logsRoot = path.join(root, '.awf', 'logs');
    const directory = path.resolve(root, session.logDir);
    if (!directory.startsWith(`${logsRoot}${path.sep}`)) return false;
    fs.mkdirSync(directory, { recursive: true });
    const stamp = new Date().toISOString();
    fs.appendFileSync(path.join(directory, 'conversation.log'), `[${stamp}] ${role || 'message'}\n${String(text)}\n\n`, 'utf8');
    return true;
  }

  function savePlan(projectRoot, requirementId, input = {}) {
    if (!getRequirement(projectRoot, requirementId)) return null;
    return unwrap(persistenceApi.plans.save({ ...input, requirementId }));
  }

  function approvePlan(projectRoot, requirementId, version) {
    if (!getRequirement(projectRoot, requirementId)) return null;
    const planSession = unwrap(persistenceApi.sessions.list({ requirementId, kind: 'plan', limit: 200 })).items[0];
    return unwrap(persistenceApi.plans.approve({ requirementId, version, planSessionId: planSession?.id }));
  }

  function syncTaskStatusesFromState(projectRoot, stateTasks = [], requestedRequirementId) {
    const context = ensureProject(projectRoot);
    const requirementId = requestedRequirementId || context.project.activeRequirementId;
    if (!requirementId) return [];
    const persisted = unwrap(persistenceApi.tasks.list({ requirementId, limit: 200 })).items;
    const updates = [];
    for (const fileTask of stateTasks) {
      const row = persisted.find((task) => task.id === fileTask.id || task.taskKey === fileTask.id);
      const status = ['done', 'completed', 'complete', 'verified'].includes(fileTask.status) ? 'done'
        : (['active', 'running', 'in_progress'].includes(fileTask.status) ? 'active'
          : (fileTask.status === 'blocked' ? 'blocked' : 'pending'));
      if (!row || row.status === status) continue;
      updates.push(unwrap(persistenceApi.tasks.update(row.id, { status })));
    }
    return updates;
  }

  /** Reconcile the state-file task projection into SQLite through the Server-owned boundary. */
  function syncTasksFromState(projectRoot, stateTasks = [], requestedRequirementId) {
    const context = ensureProject(projectRoot);
    const requirementId = requestedRequirementId || context.project.activeRequirementId;
    if (!requirementId || !getRequirement(projectRoot, requirementId)) return [];
    const current = unwrap(persistenceApi.tasks.list({ requirementId, limit: 200 })).items;
    const resolved = new Map();
    const savedRows = [];
    const taskStatus = (value) => ['done', 'completed', 'complete', 'verified'].includes(value) ? 'done'
      : (['active', 'running', 'in_progress'].includes(value) ? 'active'
        : (value === 'blocked' ? 'blocked' : 'pending'));
    for (let index = 0; index < stateTasks.length; index += 1) {
      const task = stateTasks[index] || {};
      if (!task.id || !task.title) continue;
      const row = current.find((item) => item.id === task.id || item.taskKey === String(task.id));
      const input = {
        taskKey: String(task.id), title: task.title, kind: task.kind || 'dev',
        status: taskStatus(task.status), prompt: task.prompt || '',
        acceptance: JSON.stringify(Array.isArray(task.acceptance) ? task.acceptance : task.acceptance ? [task.acceptance] : []),
        blockedReason: task.blockedReason || null,
        details: {
          ...(row?.details || {}), ...(task.exec ? { exec: task.exec } : {}),
          ...(task.files ? { files: task.files } : {}), ...(task.wbsRef ? { wbsRef: task.wbsRef } : {}),
          ...(task.constraints ? { constraints: task.constraints } : {}),
        },
        position: Number.isFinite(task.position) ? task.position : index,
      };
      const saved = row
        ? unwrap(persistenceApi.tasks.update(row.id, input))
        : unwrap(persistenceApi.tasks.create({ requirementId, ...input }));
      resolved.set(String(task.id), saved);
      savedRows.push(saved);
    }
    for (const task of stateTasks) {
      const row = resolved.get(String(task?.id));
      if (!row || !Array.isArray(task.deps)) continue;
      const dependencyIds = task.deps.map((id) => resolved.get(String(id))?.id).filter(Boolean);
      unwrap(persistenceApi.tasks.setDependencies(row.id, dependencyIds));
    }
    return savedRows;
  }

  function workspaceData(projectRoot, requestedRequirementId) {
    const context = ensureProject(projectRoot);
    const rows = unwrap(persistenceApi.requirements.list({ projectId: context.project.id, limit: 200 })).items;
    const requirement = rows.find((row) => row.id === requestedRequirementId)
      || rows.find((row) => row.id === context.project.activeRequirementId) || rows[0] || null;
    const projectSessions = rows.flatMap((row) => unwrap(persistenceApi.sessions.list({ requirementId: row.id, limit: 200 })).items)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const tasks = requirement ? listTasks(projectRoot, requirement.id) : [];
    return {
      project: context.project,
      environment: { ...context.environment, status: 'ready', runtime: process.version },
      requirements: rows.map((row) => ({ ...row, text: row.requestText })),
      sessions: projectSessions,
      activeRequirement: requirement,
      tasks,
      plan: requirement ? {
        status: ['draft', 'new'].includes(requirement.status) ? 'empty' : 'approved',
        version: requirement.revision,
        summary: requirement.summary || '',
        tasks,
      } : { status: 'empty', version: 0, summary: '', tasks: [] },
    };
  }

  function listDecisions(projectRoot, requirementId) {
    const { project } = ensureProject(projectRoot);
    const rows = unwrap(persistenceApi.decisions.list({ projectId: project.id, requirementId }));
    return rows.map((row) => {
      const events = unwrap(persistenceApi.decisions.events(row.id));
      const links = unwrap(persistenceApi.decisions.linkedTasks(row.id));
      const latest = events.at(-1);
      const requested = events.find((event) => event.eventType === 'decision_requested');
      return {
        decision_id: row.id, runStamp: row.workflowSessionId || '', event: latest?.eventType === 'decision_reviewed' ? 'decision_reviewed' : 'decision_completed',
        status: row.status === 'open' ? 'pending_review' : (row.status === 'resolved' ? 'approved' : row.status),
        task_id: links?.[0]?.taskId || null,
        request: { question: row.question, options: requested?.payload?.options || [], form: row.decisionType || 'text' },
        result: row.result || {},
      };
    });
  }

  function listProposals(projectRoot, requirementId) {
    const { project } = ensureProject(projectRoot);
    return unwrap(persistenceApi.proposals.list({ projectId: project.id })).filter((row) => !requirementId || row.requirementId === requirementId).map((row) => ({
      proposalId: row.id, status: row.status, createdAt: row.createdAt,
      reason: row.payload?.reason || row.payload?.title || '动态任务提案',
      changes: row.payload?.changes || {}, decision: row.payload?.decision || null,
    }));
  }

  return Object.freeze({
    ensureProject,
    ensureEnvironment,
    getRequirement,
    listRequirements,
    createRequirementWithPlan,
    listRequirementSessions,
    listProjects,
    isProjectRegistered,
    projectData,
    workspaceData,
    updateProject,
    updateRequirement,
    listProjectSessions,
    updateDecision,
    updateProposal,
    updateTask,
    createRunSession,
    startRunSession,
    finishSessionAttempt,
    startPlanSession,
    finishPlanSession,
    recordDecisionRequested,
    recordDecisionAnswered,
    recordDecisionCompleted,
    linkSessionConversation,
    linkActiveSessionConversation,
    appendSessionLog,
    savePlan,
    approvePlan,
    syncTaskStatusesFromState,
    syncTasksFromState,
    listTasks,
    listDecisions,
    listProposals,
    close: () => persistenceApi.shutdownPersistence(),
  });
}

module.exports = { createPersistenceApplication, ensureProjectManifest };
