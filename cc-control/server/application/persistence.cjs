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
const gitWork = require('./git-work.cjs');
const { PersistenceError } = require('../persistence/errors.cjs');
const workError = message => new PersistenceError('CONFLICT', message);

const MANIFEST_VERSION = 1;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw workError(`Cannot read persistence identity file ${filePath}: ${error.message}`);
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
      throw workError(`Invalid project identity manifest: ${filePath}`);
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
      throw workError(`Invalid environment identity file: ${environmentPath}`);
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

  function createDraftRequirement(projectRoot, input = {}) {
    const { project } = ensureProject(projectRoot);
    const requestText = String(input.requestText || '').trim();
    if (!requestText) throw workError('需求内容不能为空');
    return unwrap(persistenceApi.requirements.create({
      projectId: project.id,
      title: String(input.title || requestText).trim().slice(0, 120),
      requestText,
      lifecycleStatus: 'draft',
      allowAiWork: input.allowAiWork === true,
    }));
  }

  function listBugs(projectRoot, filters = {}) {
    const { project } = ensureProject(projectRoot);
    return unwrap(persistenceApi.bugs.list({ ...filters, projectId: project.id }));
  }

  function getBug(projectRoot, bugId) {
    const { project } = ensureProject(projectRoot);
    const bug = unwrap(persistenceApi.bugs.get(bugId));
    return bug?.projectId === project.id ? bug : null;
  }

  function createBug(projectRoot, input = {}) {
    const { project } = ensureProject(projectRoot);
    if (input.requirementId && !getRequirement(projectRoot, input.requirementId)) throw workError('需求不属于当前项目');
    return unwrap(persistenceApi.bugs.create({
      ...input, projectId: project.id, title: String(input.title || '').trim(),
      origin: input.origin || (input.requirementId ? 'run_observation' : 'project_report'),
      allowAiWork: input.requirementId ? false : input.allowAiWork === true,
      resolutionOwner: input.requirementId ? 'run' : null,
    }));
  }

  function updateBug(projectRoot, bugId, patch = {}) {
    if (!getBug(projectRoot, bugId)) return null;
    return unwrap(persistenceApi.bugs.update(bugId, patch));
  }

  function linkBugTask(projectRoot, bugId, taskKey, relation) {
    const bug = getBug(projectRoot, bugId);
    if (!bug || !bug.requirementId) return null;
    const task = listTasks(projectRoot, bug.requirementId).find((item) => item.id === taskKey || item.taskKey === taskKey);
    return task ? unwrap(persistenceApi.bugs.linkTask(bug.id, task.id, relation)) : null;
  }

  function transitionRequirement(projectRoot, requirementId, action, input = {}) {
    const row = getRequirement(projectRoot, requirementId);
    if (!row) return null;
    const from = row.lifecycleStatus;
    const allowed = { start: ['todo'], submit: ['in_progress'], accept: ['pending_acceptance'], reject: ['pending_acceptance'], fail: ['in_progress'], retry: ['failed'], cancel: ['draft', 'todo', 'failed'] };
    if (!allowed[action]?.includes(from)) throw workError(`需求当前状态 ${from} 不能执行 ${action}`);
    if (action === 'start' && !listTasks(projectRoot, requirementId)?.length) throw workError('需求还没有可执行的 Plan 任务');
    if (action === 'submit' && !listTasks(projectRoot, requirementId)?.every((task) => task.status === 'done')) throw workError('仍有未完成任务');
    const to = { start: 'in_progress', submit: 'pending_acceptance', accept: 'done', reject: 'in_progress', fail: 'failed', retry: 'todo', cancel: 'cancelled' }[action];
    const patch = { lifecycleStatus: to, expectedRevision: input.expectedRevision };
    if (action === 'start') patch.status = 'in_progress';
    if (action === 'retry') patch.status = 'planned';
    if (action === 'accept') {
      if (!input.confirmedBy && input.actor !== 'human') throw workError('需要人工确认');
      if (!input.targetHeadSha) throw workError('请先刷新并审查目标分支');
      const merged = gitWork.verifyMerged(projectRoot, input);
      const claims = unwrap(persistenceApi.workClaims.list({ projectId: row.projectId, itemType: 'requirement', itemId: row.id }));
      if (claims.length && claims[0].branchName !== merged.branchName) throw workError('验收分支与此需求的工作分支不一致');
      patch.status = 'done';
      patch.acceptedHeadSha = merged.headSha;
      patch.mergedHeadSha = merged.mergedHeadSha;
    }
    const updated = updateRequirement(projectRoot, requirementId, patch);
    unwrap(persistenceApi.workEvents.append({ projectId: row.projectId, itemType: 'requirement', itemId: row.id,
      eventType: action, payload: { from, to, note: input.note || null, confirmedBy: input.confirmedBy || null },
      actorType: input.confirmedBy ? 'human' : input.actor || 'system', idempotencyKey: `${action}:${updated.revision}` }));
    if (action === 'accept') {
      const claim = unwrap(persistenceApi.workClaims.list({ projectId: row.projectId, itemType: 'requirement', itemId: row.id, status: 'active' }))[0];
      if (claim) unwrap(persistenceApi.workClaims.release(claim.id, claim.token));
    }
    return updated;
  }

  function transitionBug(projectRoot, bugId, action, input = {}) {
    const row = getBug(projectRoot, bugId);
    if (!row) return null;
    const from = row.lifecycleStatus;
    const allowed = { start: ['open', 'failed'], submit: ['in_progress'], accept: ['pending_acceptance'], reopen: ['pending_acceptance', 'closed'], fail: ['in_progress'], close: ['open'] };
    if (!allowed[action]?.includes(from)) throw workError(`Bug 当前状态 ${from} 不能执行 ${action}`);
    if (row.requirementId && action === 'start' && input.actor !== 'run') throw workError('需求内 Bug 由当前 Run 派生任务处理');
    if (row.requirementId && action === 'submit' && input.actor !== 'run') throw workError('需求内 Bug 只能由 Run 门禁复测推进');
    if (!row.requirementId && action === 'submit') {
      const hidden = unwrap(persistenceApi.requirements.list({ projectId: row.projectId, workKind: 'bugfix', limit: 200 })).items.find((item) => item.originBugId === row.id);
      if (!hidden || hidden.lifecycleStatus !== 'pending_acceptance') throw workError('修复 Run 尚未完成，不能提交 Bug 验收');
    }
    if (['accept', 'close'].includes(action) && !input.confirmedBy && input.actor !== 'human') throw workError('需要人工确认');
    if (action === 'close' && !String(input.reason || '').trim()) throw workError('请填写关闭原因');
    if (action === 'accept' && !input.targetHeadSha) throw workError('请先刷新并审查目标分支');
    const merged = action === 'accept' ? gitWork.verifyMerged(projectRoot, input) : null;
    if (merged) {
      const claims = unwrap(persistenceApi.workClaims.list({ projectId: row.projectId, itemType: row.requirementId ? 'requirement' : 'bug', itemId: row.requirementId || row.id }));
      if (claims.length && claims[0].branchName !== merged.branchName) throw workError('验收分支与此 Bug 的工作分支不一致');
    }
    const to = { start: 'in_progress', submit: 'pending_acceptance', accept: 'closed', reopen: 'open', fail: 'failed', close: 'closed' }[action];
    const updated = updateBug(projectRoot, bugId, {
      lifecycleStatus: to, expectedRevision: input.expectedRevision,
      ...(action === 'accept' ? { acceptedHeadSha: merged.headSha, mergedHeadSha: merged.mergedHeadSha } : {}),
    });
    unwrap(persistenceApi.workEvents.append({ projectId: row.projectId, itemType: 'bug', itemId: row.id,
      eventType: action, payload: { from, to, reason: input.reason || null, confirmedBy: input.confirmedBy || null },
      actorType: input.confirmedBy ? 'human' : input.actor || 'system', idempotencyKey: `${action}:${updated.revision}` }));
    if (action === 'accept' && !row.requirementId) {
      const hidden = unwrap(persistenceApi.requirements.list({ projectId: row.projectId, workKind: 'bugfix', limit: 200 })).items.find((item) => item.originBugId === row.id);
      if (hidden && hidden.lifecycleStatus === 'pending_acceptance') updateRequirement(projectRoot, hidden.id, { lifecycleStatus: 'done', status: 'done', acceptedHeadSha: merged.headSha, mergedHeadSha: merged.mergedHeadSha });
      const claim = unwrap(persistenceApi.workClaims.list({ projectId: row.projectId, itemType: 'bug', itemId: row.id, status: 'active' }))[0];
      if (claim) unwrap(persistenceApi.workClaims.release(claim.id, claim.token));
    }
    return updated;
  }

  function listWorkEvents(projectRoot, itemType, itemId) {
    const row = itemType === 'requirement' ? getRequirement(projectRoot, itemId) : getBug(projectRoot, itemId);
    if (!row) return null;
    return unwrap(persistenceApi.workEvents.list({ projectId: row.projectId, itemType, itemId }));
  }

  function listActiveWorkClaims() {
    unwrap(persistenceApi.workClaims.expireStale());
    return unwrap(persistenceApi.workClaims.list({ status: 'active' }));
  }

  function listProjectWorkClaims(projectRoot) {
    const { project } = ensureProject(projectRoot);
    return unwrap(persistenceApi.workClaims.list({ projectId: project.id })).map(({ token, ...row }) => row);
  }

  function releaseWorkClaim(projectRoot, claimId, confirmation = {}) {
    const input = typeof confirmation === 'string' ? { confirmedBy: confirmation } : confirmation;
    if (!String(input?.confirmedBy || '').trim() && input?.actor !== 'human') throw workError('需要人工确认恢复工作区');
    const { project } = ensureProject(projectRoot);
    const claim = unwrap(persistenceApi.workClaims.get(claimId));
    if (!claim || claim.projectId !== project.id || claim.status !== 'active') throw workError('活动租约不存在');
    const released = unwrap(persistenceApi.workClaims.release(claim.id, claim.token));
    unwrap(persistenceApi.workEvents.append({ projectId: project.id, itemType: claim.itemType, itemId: claim.itemId,
      eventType: 'claim_recovered', payload: { worktreePath: claim.worktreePath, confirmedBy: input.confirmedBy || null }, actorType: 'human', idempotencyKey: `claim_recovered:${claim.id}` }));
    return { id: released.id, status: released.status, worktreePath: released.worktreePath };
  }

  function prepareRequirementWorktree(projectRoot, requirementId, input = {}) {
    const row = getRequirement(projectRoot, requirementId);
    if (!row) return null;
    if (!['todo', 'in_progress'].includes(row.lifecycleStatus)) throw workError('只有待办或需继续执行的需求才能准备工作区');
    if (!listTasks(projectRoot, requirementId)?.length) throw workError('需求没有可执行任务');
    if (input.owner === 'idle' && !row.allowAiWork) throw workError('该需求尚未授权闲时处理');
    const context = ensureProject(projectRoot);
    const prior = unwrap(persistenceApi.workClaims.list({ projectId: context.project.id, itemType: 'requirement', itemId: requirementId }))[0];
    if (row.lifecycleStatus === 'in_progress' && !prior?.worktreePath) throw workError('执行中的需求缺少原工作区，不能另建分支');
    if (context.project.activeRequirementId !== requirementId && !prior?.worktreePath) throw workError('当前状态文件属于其他需求，需先切换并准备该需求的状态');
    if (!prior?.worktreePath) {
      const state = readJson(path.join(projectRoot, '.awf', 'state.json')) || {};
      const fileTaskIds = new Set((state.tasks || []).map((task) => String(task.id)));
      if (listTasks(projectRoot, requirementId).some((task) => !fileTaskIds.has(String(task.taskKey || task.id)))) {
        throw workError('当前状态文件与需求任务不一致，请先同步 Plan 任务');
      }
    }
    const claim = unwrap(persistenceApi.workClaims.claim({ projectId: context.project.id, itemType: 'requirement', itemId: requirementId,
      owner: input.owner || 'manual', leaseSeconds: input.leaseSeconds || 3600 }));
    try {
      const prepared = gitWork.prepareWorktree(projectRoot, { projectId: context.project.id, itemType: 'requirement', itemId: requirementId, requirementId, priorBaseSha: prior?.baseSha });
      unwrap(persistenceApi.workClaims.attach(claim.id, claim.token, prepared));
      ensureProject(prepared.projectPath);
      return { ...prepared, claimId: claim.id };
    } catch (error) {
      unwrap(persistenceApi.workClaims.release(claim.id, claim.token));
      throw error;
    }
  }

  function prepareBugWorktree(projectRoot, bugId, input = {}) {
    const bug = getBug(projectRoot, bugId);
    if (!bug) return null;
    if (bug.requirementId) throw workError('需求内 Bug 由当前 Run 的派生任务处理');
    if (!['open', 'failed'].includes(bug.lifecycleStatus)) throw workError('当前 Bug 不能启动独立修复');
    if (input.owner === 'idle' && !bug.allowAiWork) throw workError('该 Bug 尚未授权闲时处理');
    const context = ensureProject(projectRoot);
    const prior = unwrap(persistenceApi.workClaims.list({ projectId: context.project.id, itemType: 'bug', itemId: bug.id }))[0];
    const existing = unwrap(persistenceApi.requirements.list({ projectId: context.project.id, workKind: 'bugfix', limit: 200 })).items.find((row) => row.originBugId === bug.id);
    const requirement = existing || unwrap(persistenceApi.requirements.createWithPlan({
      requirement: { projectId: context.project.id, title: `修复：${bug.title}`, requestText: `${bug.title}\n\n${bug.description}`, workKind: 'bugfix', originBugId: bug.id },
      plan: { title: `Bug Plan · ${bug.title}`, originEnvironmentId: context.environment.id },
    })).requirement;
    const claim = unwrap(persistenceApi.workClaims.claim({ projectId: context.project.id, itemType: 'bug', itemId: bug.id,
      owner: input.owner || 'manual', leaseSeconds: input.leaseSeconds || 3600 }));
    try {
      const prepared = gitWork.prepareWorktree(projectRoot, { projectId: context.project.id, itemType: 'bug', itemId: bug.id, requirementId: requirement.id, priorBaseSha: prior?.baseSha });
      unwrap(persistenceApi.workClaims.attach(claim.id, claim.token, prepared));
      ensureProject(prepared.projectPath);
      transitionBug(projectRoot, bug.id, 'start', { expectedRevision: bug.revision, actor: input.owner || 'manual' });
      return { ...prepared, claimId: claim.id };
    } catch (error) {
      unwrap(persistenceApi.workClaims.release(claim.id, claim.token));
      throw error;
    }
  }

  function reviewBug(projectRoot, bugId) {
    const bug = getBug(projectRoot, bugId);
    if (!bug) return null;
    const itemType = bug.requirementId ? 'requirement' : 'bug';
    const itemId = bug.requirementId || bug.id;
    const claim = unwrap(persistenceApi.workClaims.list({ projectId: bug.projectId, itemType, itemId }))[0];
    if (!claim?.branchName) throw workError('Bug 没有关联的独立工作分支');
    return gitWork.reviewBranch(projectRoot, claim);
  }

  function releaseWorkClaimAfterRun(projectRoot, requirementId) {
    const requirement = getRequirement(projectRoot, requirementId);
    if (!requirement) return null;
    const itemType = requirement.workKind === 'bugfix' ? 'bug' : 'requirement';
    const itemId = requirement.workKind === 'bugfix' ? requirement.originBugId : requirement.id;
    const claim = unwrap(persistenceApi.workClaims.list({ projectId: requirement.projectId, itemType, itemId, status: 'active' }))[0];
    return claim ? unwrap(persistenceApi.workClaims.release(claim.id, claim.token)) : null;
  }

  function assertRunClaim(projectRoot, requirementId) {
    const requirement = getRequirement(projectRoot, requirementId);
    if (!requirement) throw workError('需求不存在');
    // Existing projects without Git configuration retain their manual Run path.
    // Managed work uses the configured repository and must stay in its claim.
    if (!gitWork.readConfig(projectRoot).git) return null;
    const itemType = requirement.workKind === 'bugfix' ? 'bug' : 'requirement';
    const itemId = requirement.workKind === 'bugfix' ? requirement.originBugId : requirement.id;
    const claim = unwrap(persistenceApi.workClaims.list({ projectId: requirement.projectId, itemType, itemId, status: 'active' }))[0];
    if (!claim?.worktreePath) throw workError('请先在项目管理中创建独立工作区');
    const actual = fs.realpathSync(projectRoot);
    const worktree = fs.realpathSync(claim.worktreePath);
    if (actual !== worktree && !actual.startsWith(`${worktree}${path.sep}`)) throw workError('Run 必须在领取的独立工作区内启动');
    return claim;
  }

  function reviewRequirement(projectRoot, requirementId) {
    const row = getRequirement(projectRoot, requirementId);
    if (!row) return null;
    const claim = unwrap(persistenceApi.workClaims.list({ projectId: row.projectId, itemType: 'requirement', itemId: row.id }))[0];
    if (!claim?.branchName) throw workError('需求没有已准备的独立工作分支');
    return { ...gitWork.reviewBranch(projectRoot, claim), tasks: listTasks(projectRoot, requirementId).map(({ id, title, status }) => ({ id, title, status })) };
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
    return unwrap(persistenceApi.tasks.list({ requirementId, limit: 200 })).items
      .sort((left, right) => (Number(left.position) || 0) - (Number(right.position) || 0)
        || String(left.createdAt || '').localeCompare(String(right.createdAt || '')))
      .map((row) => {
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
    const requirement = getRequirement(projectRoot, requirementId);
    if (!requirement) return null;
    if (!['draft', 'failed'].includes(requirement.lifecycleStatus)) throw workError('当前需求状态不能重新启动 Plan');
    const sessions = unwrap(persistenceApi.sessions.list({ requirementId, kind: 'plan', limit: 200 })).items;
    const session = sessions[0] || unwrap(persistenceApi.sessions.create({
      requirementId, kind: 'plan', title: `Plan · ${requirement.title}`,
      originEnvironmentId: context.environment.id,
    }));
    const attempt = unwrap(persistenceApi.sessions.startAttempt(session.id, {
      environmentId: context.environment.id, provider: context.project.name,
    }));
    // Plan activity is a session detail; draft remains draft until a human approves it.
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
      eventType: 'decision_requested', payload: { options: input.options || [], questions: input.questions || [], context: input.context || null },
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
    const requirement = getRequirement(projectRoot, requirementId);
    if (!requirement) return null;
    if (!['draft', 'failed'].includes(requirement.lifecycleStatus)) throw workError('当前需求状态不能修改 Plan');
    return unwrap(persistenceApi.plans.save({ ...input, requirementId }));
  }

  function approvePlan(projectRoot, requirementId, version) {
    const requirement = getRequirement(projectRoot, requirementId);
    if (!requirement) return null;
    if (!['draft', 'failed'].includes(requirement.lifecycleStatus)) throw workError('只有草稿或失败需求可以确认 Plan');
    if (!listTasks(projectRoot, requirementId)?.length) throw workError('Plan 尚无可执行任务，不能进入待办');
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
    // Run attempt 可能先以失败结束，而 CC 会话随后仍完成并落账所有任务；
    // 每次从 state.json 同步任务时，也据持久化后的完整任务集推进需求状态。
    const finalStatuses = new Map(persisted.map((task) => [task.id, task.status]));
    for (const task of updates) finalStatuses.set(task.id, task.status);
    if (finalStatuses.size > 0 && [...finalStatuses.values()].every((status) => status === 'done')) {
      const requirement = getRequirement(projectRoot, requirementId);
      if (requirement && requirement.lifecycleStatus === 'in_progress') {
        updateRequirement(projectRoot, requirementId, { lifecycleStatus: 'pending_acceptance' });
      }
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
        request: { question: row.question, options: requested?.payload?.options || [], questions: requested?.payload?.questions || [], form: row.decisionType || 'text' },
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
    createDraftRequirement,
    listBugs,
    getBug,
    createBug,
    updateBug,
    linkBugTask,
    transitionRequirement,
    transitionBug,
    listWorkEvents,
    listActiveWorkClaims,
    listProjectWorkClaims,
    releaseWorkClaim,
    readWorkConfig: gitWork.readConfig,
    writeWorkConfig: gitWork.writeConfig,
    prepareRequirementWorktree,
    prepareBugWorktree,
    reviewRequirement,
    reviewBug,
    releaseWorkClaimAfterRun,
    assertRunClaim,
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
