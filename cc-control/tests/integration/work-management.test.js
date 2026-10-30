import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const persistence = require('../../server/persistence/index.cjs');
const { createPersistenceApplication } = require('../../server/application/persistence.cjs');
const { handle: handlePersistence } = require('../../server/web/api/persistence.cjs');
let root, project, app;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-work-test-'));
  project = path.join(root, 'project');
  fs.mkdirSync(project);
  app = createPersistenceApplication({ persistenceApi: persistence, databaseFilePath: path.join(root, 'db.sqlite'), environmentFilePath: path.join(root, 'environment.json') });
});
afterEach(() => { app.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe('work management', () => {
  it('serves draft requirements and project Bugs through the Web API', async () => {
    async function request(method, endpoint, body) {
      const req = new PassThrough();
      req.method = method;
      const res = { writeHead(code) { this.status = code; }, end(raw) { this.body = JSON.parse(raw); } };
      const rt = { ctx: { projectRoot: project } };
      const url = new URL(endpoint, 'http://localhost');
      const result = handlePersistence(req, res, url, rt, { persistenceApplication: app });
      req.end(body ? JSON.stringify(body) : undefined);
      expect(await result).toBe(true);
      return res;
    }
    const draft = await request('POST', '/api/persistence/requirements', { draft: true, requestText: 'A new idea' });
    expect(draft.status).toBe(201);
    expect(draft.body.data.lifecycleStatus).toBe('draft');
    const requirements = await request('GET', '/api/persistence/requirements');
    expect(requirements.body.data.items).toHaveLength(1);
    const createdBug = await request('POST', '/api/persistence/bugs', { title: 'Unexpected result' });
    expect(createdBug.body.data.requirementId).toBeNull();
    const bugs = await request('GET', '/api/persistence/bugs');
    expect(bugs.body.data).toHaveLength(1);
  });
  it('keeps a draft out of todo until a Plan has executable tasks', () => {
    const requirement = app.createDraftRequirement(project, { requestText: 'Create a report' });
    expect(requirement.lifecycleStatus).toBe('draft');
    expect(app.startPlanSession(project, requirement.id).session.kind).toBe('plan');
    expect(() => app.approvePlan(project, requirement.id, requirement.revision)).toThrow('Plan 尚无可执行任务');
  });

  it('lets the CLI workflow endpoint sync and approve a completed Plan', async () => {
    const requirement = app.createDraftRequirement(project, { requestText: 'Create a report' });
    app.updateProject(project, { activeRequirementId: requirement.id });
    app.startPlanSession(project, requirement.id);
    const req = new PassThrough();
    req.method = 'POST';
    const res = { writeHead(code) { this.status = code; }, end(raw) { this.body = JSON.parse(raw); } };
    const rt = { ctx: { projectRoot: project, stores: { state: { readSync: () => ({ tasks: [{ id: 'T1', title: 'Implement report', status: 'pending' }] }) } } } };
    const handled = handlePersistence(req, res, new URL('/workflow/plan/approve', 'http://localhost'), rt, { persistenceApplication: app });
    req.end(JSON.stringify({ requirementId: requirement.id }));
    expect(await handled).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body.requirement.lifecycleStatus).toBe('todo');
    expect(app.listTasks(project, requirement.id)).toHaveLength(1);
  });

  it('records a human closure reason as an event, without another status', () => {
    const bug = app.createBug(project, { title: 'Duplicated problem' });
    expect(() => app.transitionBug(project, bug.id, 'close', { expectedRevision: bug.revision, reason: '重复问题' })).toThrow('需要人工确认');
    const closed = app.transitionBug(project, bug.id, 'close', { expectedRevision: bug.revision, actor: 'human', reason: '重复问题' });
    expect(closed.lifecycleStatus).toBe('closed');
    const event = app.listWorkEvents(project, 'bug', bug.id)[0];
    expect(event.payload.reason).toBe('重复问题');
    expect(event.actorType).toBe('human');
  });

  it('does not initialize Git or guess a target branch', () => {
    const requirement = app.createDraftRequirement(project, { requestText: 'Implement feature' });
    expect(() => app.writeWorkConfig(project, { git: { repositoryRoot: project, targetBranch: 'dev' } })).toThrow();
    expect(fs.existsSync(path.join(project, '.git'))).toBe(false);
    expect(() => app.prepareRequirementWorktree(project, requirement.id, { owner: 'idle' })).toThrow();
  });

  it('requires the reviewed branch HEAD to be merged into the configured target', () => {
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
    fs.writeFileSync(path.join(project, 'file.txt'), 'base');
    git('add', 'project/file.txt'); git('commit', '-qm', 'base');
    const targetBranch = git('branch', '--show-current');
    app.writeWorkConfig(project, { git: { repositoryRoot: root, targetBranch }, automation: { maxConcurrentTotal: 1 } });
    git('checkout', '-qb', 'feature/test');
    fs.writeFileSync(path.join(project, 'file.txt'), 'change');
    git('add', 'project/file.txt'); git('commit', '-qm', 'change');
    const headSha = git('rev-parse', 'HEAD');
    const gitWork = require('../../server/application/git-work.cjs');
    expect(() => gitWork.verifyMerged(project, { branchName: 'feature/test', headSha })).toThrow('尚未合入');
    git('checkout', '-q', targetBranch); git('merge', '-q', '--ff-only', 'feature/test');
    expect(gitWork.verifyMerged(project, { branchName: 'feature/test', headSha }).mergedHeadSha).toBe(headSha);
    expect(() => gitWork.verifyMerged(project, { branchName: 'feature/test', headSha, targetHeadSha: 'stale' })).toThrow('已更新');
  });

  it('prepares a separate worktree with the same logical project identity', () => {
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
    fs.writeFileSync(path.join(project, 'file.txt'), 'base');
    git('add', 'project/file.txt'); git('commit', '-qm', 'base');
    const requirement = app.createDraftRequirement(project, { requestText: 'Do the work' });
    app.updateRequirement(project, requirement.id, { status: 'planned', lifecycleStatus: 'todo' });
    app.updateProject(project, { activeRequirementId: requirement.id });
    persistence.tasks.create({ requirementId: requirement.id, taskKey: 'T1', title: 'Implement' });
    fs.writeFileSync(path.join(project, '.awf', 'state.json'), JSON.stringify({ tasks: [{ id: 'T1', title: 'Implement', status: 'pending' }] }));
    app.writeWorkConfig(project, { git: { repositoryRoot: root, targetBranch: git('branch', '--show-current') } });
    const managed = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-managed-test-'));
    process.env.AWF_WORKTREE_ROOT = managed;
    try {
      const prepared = app.prepareRequirementWorktree(project, requirement.id, { owner: 'manual' });
      expect(prepared.projectPath).not.toBe(project);
      expect(() => app.assertRunClaim(project, requirement.id)).toThrow('独立工作区');
      expect(app.assertRunClaim(prepared.projectPath, requirement.id).itemId).toBe(requirement.id);
      expect(app.getRequirement(prepared.projectPath, requirement.id)?.projectId).toBe(requirement.projectId);
      expect(fs.existsSync(path.join(prepared.projectPath, '.awf', 'state.json'))).toBe(true);
      expect(() => app.prepareRequirementWorktree(project, requirement.id, { owner: 'manual' })).toThrow('正在处理');
      git('worktree', 'remove', '--force', prepared.worktreePath);
      git('branch', '-D', prepared.branchName);
    } finally {
      delete process.env.AWF_WORKTREE_ROOT;
      fs.rmSync(managed, { recursive: true, force: true });
    }
  });

  it('gives a project Bug a hidden Plan carrier in a separate branch', () => {
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
    fs.writeFileSync(path.join(project, 'file.txt'), 'base');
    git('add', 'project/file.txt'); git('commit', '-qm', 'base');
    const bug = app.createBug(project, { title: 'Broken export', description: 'Steps to reproduce' });
    app.writeWorkConfig(project, { git: { repositoryRoot: root, targetBranch: git('branch', '--show-current') } });
    const managed = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bug-managed-test-'));
    process.env.AWF_WORKTREE_ROOT = managed;
    try {
      const prepared = app.prepareBugWorktree(project, bug.id, { owner: 'manual' });
      expect(prepared.branchName).toContain('/bug/');
      expect(app.getBug(project, bug.id).lifecycleStatus).toBe('in_progress');
      const hidden = app.getRequirement(prepared.projectPath, prepared.requirementId);
      expect(hidden.workKind).toBe('bugfix');
      expect(hidden.originBugId).toBe(bug.id);
      expect(app.listRequirements(project, { workKind: 'requirement' }).items).toHaveLength(0);
      git('worktree', 'remove', '--force', prepared.worktreePath);
      git('branch', '-D', prepared.branchName);
    } finally {
      delete process.env.AWF_WORKTREE_ROOT;
      fs.rmSync(managed, { recursive: true, force: true });
    }
  });
});
