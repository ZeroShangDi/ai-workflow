'use strict';

const { readJson, send } = require('./util.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { initWorkspace } = require('../../shared/workspace.cjs');
const { resolveAdapterName, resolveProjectAdapters, ADAPTER_NAMES, ADAPTER_ENV } = require('../../adapters/ports.cjs');
const { applyAdapter } = require('../../shared/workspace.cjs');
const { projectSessionEnv } = require('../../shared/session-env.cjs');
const { selectProjectDirectory } = require('../../application/directory-picker.cjs');
const { listBranches } = require('../../application/git-work.cjs');

function respond(res, status, body) {
  send(res, status, body);
  return true;
}

function isProjectInitialized(projectRoot) {
  const configPath = path.join(projectRoot, '.awf', 'config.json');
  const statePath = path.join(projectRoot, '.awf', 'state.json');
  try {
    JSON.parse(fs.readFileSync(configPath, 'utf8'));
    JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return true;
  } catch { return false; }
}

/** HTTP endpoints for persistence-backed workflow data; all storage stays behind Server. */
async function handle(req, res, url, rt, deps) {
  if (!deps.persistenceApplication) return false;
  // Public Web API uses a conventional namespace. Normalize it here so older
  // /data/* callers remain compatible while browsers use /api/persistence/*.
  const pathname = url.pathname.startsWith('/api/persistence/')
    ? `/data/${url.pathname.slice('/api/persistence/'.length)}`
    : url.pathname === '/workflow/plan/start' ? '/data/plan/prepare'
      : url.pathname === '/workflow/plan/finish' ? '/data/plan/finish'
        : url.pathname === '/workflow/run/start' ? '/data/run/start'
          : url.pathname === '/workflow/run/finish' ? '/data/run/finish' : url.pathname;
  const app = deps.persistenceApplication;

  if (req.method === 'GET' && pathname === '/data/projects') {
    return respond(res, 200, { ok: true, projects: app.listProjects().map((row) => ({
      projectId: row.project.id, projectName: row.project.name, projectRoot: row.checkout.rootPath,
      environmentId: row.environmentId,
    })) });
  }

  if (req.method === 'GET' && pathname === '/data/init-options') {
    return respond(res, 200, { ok: true, options: [
      { key: 'force', type: 'boolean', label: '补全缺失文件', description: '项目已初始化时，补齐缺少的工作区文件；不会覆盖已有文件。', default: false },
    ], adapters: ADAPTER_NAMES.map((name) => ({ value: name, label: name === 'cc' ? 'Claude Code' : 'DSH' })) });
  }

  if (req.method === 'POST' && pathname === '/data/projects/inspect') {
    const body = await readJson(req) || {};
    const projectRoot = typeof body.path === 'string' ? path.resolve(body.path) : '';
    if (!projectRoot || !fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
      return respond(res, 400, { ok: false, error: '请选择一个存在的项目目录' });
    }
    const requestedAdapter = body.adapter && ADAPTER_NAMES.includes(body.adapter) ? body.adapter : null;
    const inspectEnv = requestedAdapter ? { ...process.env, [ADAPTER_ENV]: requestedAdapter } : process.env;
    const adapter = resolveAdapterName(projectRoot, { env: inspectEnv });
    const awfRoot = path.join(projectRoot, '.awf');
    const initialized = isProjectInitialized(projectRoot);
    const checks = resolveProjectAdapters(projectRoot, { env: inspectEnv }).checks();
    const registered = app.listProjects().some((row) => path.resolve(row.checkout.rootPath) === projectRoot);
    return respond(res, 200, {
      ok: true, project: { path: projectRoot, name: path.basename(projectRoot), adapter, initialized, registered,
        status: registered ? '已添加' : initialized ? '已初始化' : fs.existsSync(awfRoot) ? '部分初始化' : '未初始化' },
      checks,
    });
  }

  if (req.method === 'POST' && pathname === '/data/projects/initialize') {
    const body = await readJson(req) || {};
    const projectRoot = typeof body.path === 'string' ? path.resolve(body.path) : '';
    if (!projectRoot || !fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
      return respond(res, 400, { ok: false, error: '请选择一个存在的项目目录' });
    }
    const adapter = ADAPTER_NAMES.includes(body.adapter) ? body.adapter : resolveAdapterName(projectRoot, { env: process.env });
    if (body.adapter && !ADAPTER_NAMES.includes(body.adapter)) return respond(res, 400, { ok: false, error: `不支持的平台：${body.adapter}` });
    if (body.adapter) applyAdapter(projectRoot, adapter, { onlyIfMissing: false });
    const projectRuntime = deps.registry.runtimeFor(projectRoot);
    const checks = projectRuntime.ctx.adapters.checks();
    if (checks.some((check) => !check.ok)) return respond(res, 409, { ok: false, error: '初始化前置检查未通过', checks });
    const profile = projectRuntime.ctx.adapters.tools.profile;
    if (adapter === 'dsh') {
      const installed = profile.installProfile({ profile: process.env.AWF_DSH_PROFILE || 'web',
        awfBase: `http://127.0.0.1:${projectRuntime.ctx.port}`, webPort: Number(process.env.AWF_DSH_WEB_PORT) || 3080 });
      if (installed.error) return respond(res, 500, { ok: false, error: installed.error });
    } else {
      const installed = profile.installProfile(projectRoot);
      if (!installed.written) return respond(res, 500, { ok: false, error: installed.error || '项目插件注册失败' });
      profile.installProjectMcp(projectRoot, projectRuntime.ctx.port);
    }
    const result = initWorkspace(projectRoot, { force: body.options?.force === true, adapter });
    const initialized = isProjectInitialized(projectRoot);
    if (!initialized) return respond(res, 409, { ok: false, error: '项目工作区尚未完整初始化；对于已有 .awf/ 的项目，请勾选“补全缺失文件”后重试', project: { path: projectRoot, name: path.basename(projectRoot), adapter, initialized: false, status: '未初始化' }, result, checks });
    return respond(res, 200, { ok: true, project: { path: projectRoot, name: path.basename(projectRoot), adapter, initialized: true, status: '已初始化' }, result, checks });
  }

  if (req.method === 'POST' && pathname === '/data/projects/add') {
    const body = await readJson(req) || {};
    const projectRoot = typeof body.path === 'string' ? path.resolve(body.path) : '';
    if (!projectRoot || !fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) return respond(res, 400, { ok: false, error: '请选择一个存在的项目目录' });
    if (!isProjectInitialized(projectRoot)) {
      return respond(res, 409, { ok: false, error: '项目尚未初始化' });
    }
    const context = app.ensureProject(projectRoot);
    const registeredRuntime = deps.registry.runtimeFor(projectRoot);
    return respond(res, 201, { ok: true, projectRoot, project: context.project, environmentId: context.environment.id, runtime: registeredRuntime.ctx.adapter });
  }

  if (req.method === 'POST' && pathname === '/data/projects/select-folder') {
    try {
      const result = await selectProjectDirectory();
      return respond(res, 200, { ok: true, ...result });
    } catch (error) {
      return respond(res, 501, { ok: false, error: error.message });
    }
  }

  if (req.method === 'GET' && pathname === '/data/workspace') {
    const workspace = app.workspaceData(rt.ctx.projectRoot, url.searchParams.get('requirementId'));
    return respond(res, 200, { ok: true, workspace });
  }

  if (req.method === 'GET' && pathname === '/data/work-config') {
    return respond(res, 200, { ok: true, data: app.readWorkConfig(rt.ctx.projectRoot) });
  }
  if (req.method === 'GET' && pathname === '/data/work-config/branches') {
    return respond(res, 200, { ok: true, branches: listBranches(url.searchParams.get('repositoryRoot')) });
  }
  if (req.method === 'POST' && pathname === '/data/work-config') {
    const body = await readJson(req) || {};
    return respond(res, 200, { ok: true, data: app.writeWorkConfig(rt.ctx.projectRoot, body) });
  }
  if (req.method === 'GET' && pathname === '/data/work-claims') {
    return respond(res, 200, { ok: true, data: app.listProjectWorkClaims(rt.ctx.projectRoot) });
  }
  const recoverClaim = pathname.match(/^\/data\/work-claims\/([^/]+)\/recover$/);
  if (req.method === 'POST' && recoverClaim) {
    const body = await readJson(req) || {};
    const claim = app.listProjectWorkClaims(rt.ctx.projectRoot).find((row) => row.id === decodeURIComponent(recoverClaim[1]));
    if (!claim) return respond(res, 404, { ok: false, error: '租约不存在' });
    const checkout = app.listProjects().find((entry) => claim.worktreePath && (entry.checkout.rootPath === claim.worktreePath || entry.checkout.rootPath.startsWith(`${claim.worktreePath}${path.sep}`)));
    const workRuntime = checkout && deps.registry.runtimeFor(checkout.checkout.rootPath);
    if (workRuntime?.runHost?.snapshot()?.runs?.some((run) => ['running', 'queued'].includes(run.status))) return respond(res, 409, { ok: false, error: 'Run 仍在执行，不能释放租约' });
    if (workRuntime?.session?.state === 'busy') return respond(res, 409, { ok: false, error: 'AI 会话仍在处理，不能释放租约' });
    const requirementId = claim.itemType === 'requirement' ? claim.itemId
      : app.listRequirements(rt.ctx.projectRoot, { workKind: 'bugfix', limit: 200 }).items.find((row) => row.originBugId === claim.itemId)?.id;
    if (requirementId && app.listRequirementSessions(rt.ctx.projectRoot, requirementId, { limit: 200 })?.items?.some((session) => session.status === 'active')) return respond(res, 409, { ok: false, error: 'Plan 或 Run 会话仍处于活动状态，请先结束会话' });
    const data = app.releaseWorkClaim(rt.ctx.projectRoot, claim.id, body);
    return respond(res, 200, { ok: true, data });
  }

  if (req.method === 'POST' && pathname === '/data/plan/save') {
    const body = await readJson(req) || {};
    const requirementId = body.requirementId || app.workspaceData(rt.ctx.projectRoot).activeRequirement?.id;
    if (!requirementId) return respond(res, 404, { ok: false, error: '当前项目没有可编辑的需求' });
    const result = app.savePlan(rt.ctx.projectRoot, requirementId, body);
    if (!result) return respond(res, 404, { ok: false, error: '需求不存在' });
    return respond(res, 200, { ok: true, ...result });
  }

  // Plan conversation setup. Server creates the requirement/session and owns
  // prompt construction; interactive terminal ownership can remain with CLI.
  if (req.method === 'POST' && pathname === '/data/plan/prepare') {
    const body = await readJson(req) || {};
    let requirement;
    if (body.requirementId) {
      requirement = app.getRequirement(rt.ctx.projectRoot, body.requirementId);
      if (!requirement) return respond(res, 404, { ok: false, error: '需求不存在' });
    } else {
      const active = body.resume ? app.workspaceData(rt.ctx.projectRoot).activeRequirement : null;
      if (active) requirement = active;
      const requestText = String(body.requestText || '').trim();
      if (!requirement && !requestText) return respond(res, 400, { ok: false, error: '新建 Plan 需要 requestText；恢复 Plan 需要已有需求' });
      if (!requirement) {
        const created = app.createRequirementWithPlan(rt.ctx.projectRoot, {
          requirement: { title: String(body.title || requestText).slice(0, 120), requestText },
          plan: { title: body.sessionTitle || `Plan · ${requestText.slice(0, 60)}` },
        });
        requirement = created.requirement;
      }
    }
    app.updateProject(rt.ctx.projectRoot, { activeRequirementId: requirement.id });
    const started = app.startPlanSession(rt.ctx.projectRoot, requirement.id);
    if (!started) return respond(res, 409, { ok: false, error: 'Plan 会话不存在' });
    rt.ctx.logger.setWorkflowIdentity?.({ sessionId: started.session.id, attemptId: started.attempt.id });
    if (!body.resume) {
      const { archiveOldStateForPlan } = await import('../../shared/state.js');
      archiveOldStateForPlan(rt.ctx.projectRoot, {
        workflowSessionId: started.session.id, attemptId: started.attempt.id,
      });
    }
    const { planEntry } = await import('../../shared/prompts.js');
    const prompt = await planEntry(requirement.requestText, !!body.resume, { adapter: rt.ctx.adapter });
    if (body.launch === true) {
      try {
        const port = rt.ctx.adapters.ports.session;
        const sessionWasThere = await port.exists();
        const cwd = sessionWasThere ? await port.cwd() : null;
        const reuse = sessionWasThere && cwd && path.resolve(cwd) === path.resolve(rt.ctx.projectRoot);
        if (rt.ctx.adapter === 'cc') {
          const settings = rt.ctx.adapters.tools.settings.generateRunSettings({
            workdir: rt.ctx.projectRoot,
            contextUsageScript: path.join(rt.ctx.nameCtx.infraRoot, 'scripts', 'context-usage.mjs'),
          });
          fs.mkdirSync(path.dirname(rt.ctx.nameCtx.runSettingsPath), { recursive: true });
          fs.writeFileSync(rt.ctx.nameCtx.runSettingsPath, JSON.stringify(settings, null, 2));
          rt.ctx.adapters.tools.profile.installProjectMcp(rt.ctx.projectRoot, rt.ctx.port);
        }
        const beforeSeq = rt.session.sessionSeq;
        if (!reuse) {
          if (sessionWasThere) await port.kill();
          await port.start({ projectRoot: rt.ctx.projectRoot, env: projectSessionEnv(process.env, {
            projectRoot: rt.ctx.projectRoot, port: rt.ctx.port, sessionName: rt.ctx.runSessionName,
          }) });
          const deadline = Date.now() + Number(process.env.CC_SESSION_READY_TIMEOUT_MS || 60000);
          let lastNudgeAt = Date.now();
          while (rt.session.sessionSeq <= beforeSeq && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (Date.now() - lastNudgeAt >= 5000) { await port.nudge?.(); lastNudgeAt = Date.now(); }
          }
          if (rt.session.sessionSeq <= beforeSeq) throw new Error('等待 CC 会话启动超时');
        }
        if (rt.session.mainSessionId) app.linkSessionConversation(started.session.id, {
          provider: rt.ctx.adapter || 'unknown', externalConversationId: String(rt.session.mainSessionId),
        });
        if (!await rt.session.waitReady(Number(process.env.CC_SESSION_READY_TIMEOUT_MS || 60000))) throw new Error('CC 会话仍在处理中，请稍后重试');
        rt.ctx.logger.captureFromTranscript();
        rt.session.setBusy();
        rt.ctx.logger.logPrompt(prompt);
        await rt.ctx.host.sendPrompt(prompt);
      } catch (error) {
        app.finishSessionAttempt(rt.ctx.projectRoot, started.session.id, started.attempt.id, { status: 'failed', errorText: error.message });
        return respond(res, 502, { ok: false, error: `Plan 会话启动失败：${error.message}`, requirement, workflowSessionId: started.session.id });
      }
      return respond(res, 202, { ok: true, requirement, workflowSessionId: started.session.id, attemptId: started.attempt.id, title: started.session.title || requirement.title, launched: true });
    }
    if (rt.session.mainSessionId) app.linkSessionConversation(started.session.id, {
      provider: rt.ctx.adapter || 'unknown', externalConversationId: String(rt.session.mainSessionId),
    });
    return respond(res, 201, {
      ok: true, requirement, workflowSessionId: started.session.id,
      attemptId: started.attempt.id, prompt, title: started.session.title || requirement.title,
      detached: rt.ctx.adapters.ports.interactive?.detached === true,
    });
  }

  const finishPlan = pathname === '/data/plan/finish';
  if (req.method === 'POST' && finishPlan) {
    const body = await readJson(req) || {};
    if (!body.workflowSessionId || !body.attemptId) return respond(res, 400, { ok: false, error: 'workflowSessionId 和 attemptId 必填' });
    const row = app.finishSessionAttempt(rt.ctx.projectRoot, body.workflowSessionId, body.attemptId, {
      status: body.status === 'failed' ? 'failed' : 'completed',
      errorText: body.errorText || null,
      finishSession: true,
    });
    if (!row) return respond(res, 404, { ok: false, error: 'Plan attempt 不存在或不属于当前项目' });
    return respond(res, 200, { ok: true, attempt: row });
  }

  if (req.method === 'POST' && pathname === '/data/plan/generate') {
    const body = await readJson(req) || {};
    const workspace = app.workspaceData(rt.ctx.projectRoot, body.requirementId);
    const requirement = workspace.activeRequirement;
    if (!requirement) return respond(res, 404, { ok: false, error: '需求不存在' });
    const interactive = rt.ctx.adapters.ports.interactive;
    if (interactive?.detached !== true) {
      return respond(res, 501, { ok: false, error: `平台 ${rt.ctx.adapter} 的 Plan 必须在交互终端中启动；当前 Server 没有可脱离终端的入口` });
    }
    const started = app.startPlanSession(rt.ctx.projectRoot, requirement.id);
    if (!started) return respond(res, 409, { ok: false, error: 'Plan 会话不存在' });
    try {
      const { planEntry } = await import('../../shared/prompts.js');
      const prompt = await planEntry(requirement.requestText, false, { adapter: rt.ctx.adapter });
      const launched = await interactive.launchDialog({ cwd: rt.ctx.projectRoot, prompt, title: started.session.title || requirement.title });
      if (launched?.ok === false) return respond(res, 502, { ok: false, error: launched.error || 'Plan 会话启动失败' });
      if (launched?.sessionId) {
        const provider = rt.ctx.adapter || 'unknown';
        app.linkSessionConversation(started.session.id, {
          provider, externalConversationId: String(launched.sessionId),
        });
      }
      return respond(res, 202, { ok: true, workflowSessionId: started.session.id, attemptId: started.attempt.id, conversationId: launched?.sessionId || null, url: launched?.url || null });
    } catch (error) {
      return respond(res, 502, { ok: false, error: `Plan 会话启动失败：${error.message}` });
    }
  }

  if (req.method === 'POST' && pathname === '/data/plan/approve') {
    const body = await readJson(req) || {};
    const requirementId = body.requirementId || app.workspaceData(rt.ctx.projectRoot).activeRequirement?.id;
    if (!requirementId) return respond(res, 404, { ok: false, error: '当前项目没有待确认的需求' });
    if (app.ensureProject(rt.ctx.projectRoot).project.activeRequirementId === requirementId) {
      const state = rt.ctx.stores.state.readSync() || {};
      app.syncTasksFromState(rt.ctx.projectRoot, state.tasks || [], requirementId);
    }
    const result = app.approvePlan(rt.ctx.projectRoot, requirementId, body.version);
    if (!result) return respond(res, 404, { ok: false, error: '需求不存在' });
    return respond(res, 200, { ok: true, ...result });
  }

  if (req.method === 'GET' && pathname === '/data/state') {
    const workspace = app.workspaceData(rt.ctx.projectRoot);
    const state = rt.ctx.stores.state.readSync() || {};
    app.syncTaskStatusesFromState(rt.ctx.projectRoot, state.tasks || []);
    return respond(res, 200, { ...state, mode: state.mode || 'idle', tasks: workspace.tasks, plan: workspace.activeRequirement ? {
      summary: workspace.activeRequirement.summary || '', version: workspace.activeRequirement.revision,
    } : (state.plan || {}) });
  }

  if (req.method === 'POST' && pathname === '/data/run/start') {
    const body = await readJson(req) || {};
    const fileState = rt.ctx.stores.state.readSync() || {};
    const before = app.workspaceData(rt.ctx.projectRoot, body.requirementId);
    const requestedRequirementId = body.requirementId || before.activeRequirement?.id;
    if (requestedRequirementId) app.syncTasksFromState(rt.ctx.projectRoot, fileState.tasks || [], requestedRequirementId);
    const workspace = app.workspaceData(rt.ctx.projectRoot, requestedRequirementId);
    const requirement = workspace.activeRequirement;
    if (!requirement || !workspace.tasks.length) return respond(res, 409, { ok: false, error: '需求没有已确认的任务，暂时不能启动 Run' });
    app.assertRunClaim(rt.ctx.projectRoot, requirement.id);
    if (!['todo', 'in_progress'].includes(requirement.lifecycleStatus)) return respond(res, 409, { ok: false, error: '请先确认 Plan，再启动 Run' });
    const fileTaskIds = new Set((fileState.tasks || []).map((task) => task.id));
    if (workspace.tasks.some((task) => !fileTaskIds.has(task.taskKey || task.id))) {
      return respond(res, 409, { ok: false, error: '当前 Run 引擎仍读取 .awf/state.json；数据库任务尚未与该文件同步。为避免覆盖项目现场，本次没有启动。' });
    }
    const crypto = require('node:crypto');
    const runId = String(body.runId || `run-${crypto.randomUUID()}`);
    await rt.ensureRunHost();
    if (!rt.runHost) return respond(res, 503, { ok: false, error: `run host 未就绪: ${rt.runHostBootErr?.message || 'unknown'}` });
    app.finishPlanSession(rt.ctx.projectRoot, requirement.id, 'completed');
    const created = app.startRunSession(rt.ctx.projectRoot, requirement.id, {
      runId, title: `Run · ${requirement.title}`,
    });
    if (!created) return respond(res, 404, { ok: false, error: '需求不存在' });
    rt.ctx.logger.beginWorkflowSession?.({
      sessionId: created.session.id, attemptId: created.attempt.id,
      runId, kind: 'run', logDir: created.session.logDir,
    });
    let unsubscribe = () => {};
    unsubscribe = rt.runHost.subscribe((event) => {
      if (event.runId !== runId) return;
      if (event.type === 'gate.fix') {
        try {
          const gateId = event.payload?.taskId;
          const key = `run:${runId}:gate:${gateId}`;
          let bug = gateId && app.listBugs(rt.ctx.projectRoot, { requirementId: requirement.id }).find((row) => row.originEventKey === key);
          if (gateId && !bug) {
            bug = app.createBug(rt.ctx.projectRoot, {
              requirementId: requirement.id, sessionId: created.session.id,
              title: `${event.payload?.kind === 'test' ? '测试' : '审查'}未通过：${gateId}`,
              description: `Run ${runId} 的门禁 ${gateId} 发现问题；修复继续由派生任务处理。`,
              origin: 'run_gate', originEventKey: key, resolutionOwner: 'run', lifecycleStatus: 'in_progress',
            });
          }
          if (bug) {
            const latest = rt.ctx.stores.state.readSync() || {};
            app.syncTasksFromState(rt.ctx.projectRoot, latest.tasks || [], requirement.id);
            app.linkBugTask(rt.ctx.projectRoot, bug.id, gateId, 'discovered_by');
            if (event.payload?.fixId) app.linkBugTask(rt.ctx.projectRoot, bug.id, event.payload.fixId, 'fixed_by');
          }
        } catch (error) { console.warn(`[persistence] gate bug sync failed: ${error.message}`); }
      }
      if (['task.started', 'task.done', 'task.blocked'].includes(event.type)) {
        try {
          const latest = rt.ctx.stores.state.readSync() || {};
          app.syncTaskStatusesFromState(rt.ctx.projectRoot, latest.tasks || [], requirement.id);
          if (event.type === 'task.done' && event.payload?.verdict?.level === 'pass') {
            for (const bug of app.listBugs(rt.ctx.projectRoot, { requirementId: requirement.id }).filter((row) => row.origin === 'run_gate' && row.lifecycleStatus === 'in_progress')) {
              const gateId = bug.originEventKey?.split(':gate:')[1];
              if (gateId === event.payload?.taskId || gateId === event.payload?.id) {
                app.linkBugTask(rt.ctx.projectRoot, bug.id, gateId, 'verified_by');
                app.transitionBug(rt.ctx.projectRoot, bug.id, 'submit', { expectedRevision: bug.revision, actor: 'run' });
              }
            }
          }
        } catch (error) { console.warn(`[persistence] task status sync failed: ${error.message}`); }
      }
      if (event.type !== 'run.stopped') return;
      unsubscribe();
      const status = event.payload?.status === 'done' ? 'completed' : event.payload?.status === 'error' ? 'failed' : 'interrupted';
      try {
        app.finishSessionAttempt(rt.ctx.projectRoot, created.session.id, created.attempt.id, {
          status, errorText: event.payload?.error || null, finishSession: true,
        });
        const latest = rt.ctx.stores.state.readSync() || {};
        app.syncTaskStatusesFromState(rt.ctx.projectRoot, latest.tasks || [], requirement.id);
        const finalWorkspace = app.workspaceData(rt.ctx.projectRoot, requirement.id);
        const allTasksDone = finalWorkspace.tasks.length > 0 && finalWorkspace.tasks.every((task) => task.status === 'done');
        app.updateRequirement(rt.ctx.projectRoot, requirement.id, {
          status: 'in_progress',
          lifecycleStatus: status === 'completed' && allTasksDone ? 'pending_acceptance' : status === 'failed' ? 'failed' : 'in_progress',
        });
        if (requirement.workKind === 'bugfix' && requirement.originBugId) {
          const bug = app.getBug(rt.ctx.projectRoot, requirement.originBugId);
          if (bug?.lifecycleStatus === 'in_progress' && status === 'completed' && allTasksDone) app.transitionBug(rt.ctx.projectRoot, bug.id, 'submit', { actor: 'run', expectedRevision: bug.revision });
          else if (bug?.lifecycleStatus === 'in_progress' && status === 'failed') app.transitionBug(rt.ctx.projectRoot, bug.id, 'fail', { actor: 'run', expectedRevision: bug.revision });
        }
      } catch (error) { console.warn(`[persistence] run completion sync failed: ${error.message}`); }
      try { app.releaseWorkClaimAfterRun(rt.ctx.projectRoot, requirement.id); }
      catch (error) { console.warn(`[persistence] run claim release failed: ${error.message}`); }
    });
    const submitted = rt.runHost.submitRun({
      runId, mode: body.mode, workflowSessionId: created.session.id, attemptId: created.attempt.id,
    });
    if (!submitted.ok) {
      unsubscribe();
      app.finishSessionAttempt(rt.ctx.projectRoot, created.session.id, created.attempt.id, { status: 'failed', errorText: submitted.error });
      return respond(res, 409, { ok: false, error: submitted.error, runId });
    }
    if (requirement.lifecycleStatus === 'todo') app.transitionRequirement(rt.ctx.projectRoot, requirement.id, 'start', { expectedRevision: requirement.revision });
    return respond(res, 202, { ok: true, runId, workflowSessionId: created.session.id, attemptId: created.attempt.id, mode: submitted.mode });
  }

  if (req.method === 'POST' && pathname === '/data/run/finish') {
    const body = await readJson(req) || {};
    if (!body.workflowSessionId || !body.attemptId) return respond(res, 400, { ok: false, error: 'workflowSessionId 和 attemptId 必填' });
    const row = app.finishSessionAttempt(rt.ctx.projectRoot, body.workflowSessionId, body.attemptId, {
      status: body.status === 'failed' ? 'failed' : 'completed',
      errorText: body.errorText || null,
    });
    if (!row) return respond(res, 404, { ok: false, error: 'Run attempt 不存在或不属于当前项目' });
    return respond(res, 200, { ok: true, attempt: row });
  }

  if (req.method === 'GET' && pathname === '/data/decisions') {
    const decisions = app.listDecisions(rt.ctx.projectRoot, url.searchParams.get('requirementId') || undefined);
    return respond(res, 200, { ok: true, total: decisions.length, decisions });
  }

  if (req.method === 'GET' && pathname === '/data/proposals') {
    const proposals = app.listProposals(rt.ctx.projectRoot, url.searchParams.get('requirementId') || undefined);
    return respond(res, 200, { ok: true, proposals });
  }

  if (req.method === 'GET' && pathname === '/data/log-files') {
    const root = path.resolve(rt.ctx.projectRoot);
    const sessions = app.listProjectSessions(root);
    const files = [];
    for (const session of sessions) {
      const directory = path.resolve(root, session.logDir || '');
      if (!directory.startsWith(`${path.join(root, '.awf', 'logs')}${path.sep}`)) continue;
      let names = [];
      try { names = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name); } catch { /* session log folder may not exist yet */ }
      if (!names.length) files.push({ sessionId: session.id, kind: session.kind, sessionTitle: session.title, name: null, status: session.status });
      for (const name of names) files.push({ sessionId: session.id, kind: session.kind, sessionTitle: session.title, name, status: session.status });
    }
    return respond(res, 200, { ok: true, files });
  }

  if (req.method === 'GET' && pathname === '/data/log-content') {
    const sessionId = url.searchParams.get('sessionId');
    const fileName = url.searchParams.get('file');
    const session = app.listProjectSessions(rt.ctx.projectRoot).find((row) => row.id === sessionId);
    if (!session) return respond(res, 404, { ok: false, error: '会话不存在' });
    if (!fileName || path.basename(fileName) !== fileName) return respond(res, 400, { ok: false, error: '请选择有效的日志文件' });
    const directory = path.resolve(rt.ctx.projectRoot, session.logDir || '');
    const logsRoot = path.join(path.resolve(rt.ctx.projectRoot), '.awf', 'logs');
    if (!directory.startsWith(`${logsRoot}${path.sep}`)) return respond(res, 400, { ok: false, error: '日志路径不在项目日志目录内' });
    const target = path.join(directory, fileName);
    try { return respond(res, 200, { ok: true, sessionId, file: fileName, content: fs.readFileSync(target, 'utf8') }); }
    catch (error) { return respond(res, error.code === 'ENOENT' ? 404 : 500, { ok: false, error: '无法读取日志文件' }); }
  }

  const decisionAction = pathname.match(/^\/data\/decisions\/([^/]+)\/(approve|resolve|override)$/);
  if (req.method === 'POST' && decisionAction) {
    const body = await readJson(req) || {};
    const action = decisionAction[2];
    const status = action === 'override' ? 'overridden' : 'resolved';
    const row = app.updateDecision(rt.ctx.projectRoot, decodeURIComponent(decisionAction[1]), status, body);
    if (!row) return respond(res, 404, { ok: false, error: '决策不存在' });
    return respond(res, 200, { ok: true, decisionId: row.id, status: row.status });
  }

  const proposalAction = pathname.match(/^\/data\/proposals\/([^/]+)\/(approve|alternative)$/);
  if (req.method === 'POST' && proposalAction) {
    const body = await readJson(req) || {};
    const status = proposalAction[2] === 'approve' ? 'approved' : 'adjusted';
    const row = app.updateProposal(rt.ctx.projectRoot, decodeURIComponent(proposalAction[1]), status, body);
    if (!row) return respond(res, 404, { ok: false, error: '动态任务提案不存在' });
    return respond(res, 200, { ok: true, proposalId: decodeURIComponent(proposalAction[1]), status });
  }

  const taskAction = pathname.match(/^\/data\/tasks\/([^/]+)\/(retry|unblock)$/);
  if (req.method === 'POST' && taskAction) {
    const status = taskAction[2] === 'unblock' ? 'pending' : 'pending';
    const row = app.updateTask(rt.ctx.projectRoot, decodeURIComponent(taskAction[1]), { status, blockedReason: null });
    if (!row) return respond(res, 404, { ok: false, error: '任务不存在' });
    return respond(res, 200, { ok: true, taskId: row.id, status: row.status });
  }

  if (req.method === 'GET' && pathname === '/data/project') {
    return respond(res, 200, { ok: true, data: app.ensureProject(rt.ctx.projectRoot) });
  }

  if (req.method === 'GET' && pathname === '/data/requirements') {
    const data = app.listRequirements(rt.ctx.projectRoot, {
      status: url.searchParams.get('status') || undefined,
      lifecycleStatus: url.searchParams.get('lifecycleStatus') || undefined,
      workKind: 'requirement',
      limit: url.searchParams.get('limit') || undefined,
      cursor: url.searchParams.get('cursor') || undefined,
    });
    return respond(res, 200, { ok: true, data });
  }

  if (req.method === 'POST' && pathname === '/data/requirements') {
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return respond(res, 400, { ok: false, error: 'body must be a JSON object' });
    }
    if (body.draft === true) {
      const requirement = app.createDraftRequirement(rt.ctx.projectRoot, body);
      return respond(res, 201, { ok: true, data: requirement });
    }
    const data = app.createRequirementWithPlan(rt.ctx.projectRoot, body);
    app.updateProject(rt.ctx.projectRoot, { activeRequirementId: data.requirement.id });
    return respond(res, 201, { ok: true, data });
  }

  const requirementAction = pathname.match(/^\/data\/requirements\/([^/]+)\/(start|submit|accept|reject|fail|retry|cancel|edit)$/);
  if (req.method === 'POST' && requirementAction) {
    const body = await readJson(req) || {};
    const id = decodeURIComponent(requirementAction[1]);
    const action = requirementAction[2];
    const data = action === 'edit'
      ? app.updateRequirement(rt.ctx.projectRoot, id, {
        ...Object.fromEntries(['title', 'requestText', 'allowAiWork', 'boardPosition'].filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]])),
        expectedRevision: body.expectedRevision,
      })
      : app.transitionRequirement(rt.ctx.projectRoot, id, action, body);
    if (!data) return respond(res, 404, { ok: false, error: '需求不存在' });
    return respond(res, 200, { ok: true, data });
  }

  const requirementPrepare = pathname.match(/^\/data\/requirements\/([^/]+)\/prepare-worktree$/);
  if (req.method === 'POST' && requirementPrepare) {
    const body = await readJson(req) || {};
    const data = app.prepareRequirementWorktree(rt.ctx.projectRoot, decodeURIComponent(requirementPrepare[1]), body);
    if (!data) return respond(res, 404, { ok: false, error: '需求不存在' });
    const workRuntime = deps.registry.runtimeFor(data.projectPath);
    if (workRuntime.ctx.adapter === 'cc') {
      workRuntime.ctx.adapters.tools.profile.installProfile(data.projectPath);
      workRuntime.ctx.adapters.tools.profile.installProjectMcp(data.projectPath, workRuntime.ctx.port);
    }
    return respond(res, 201, { ok: true, data });
  }
  const requirementReview = pathname.match(/^\/data\/requirements\/([^/]+)\/review$/);
  if (req.method === 'GET' && requirementReview) {
    const data = app.reviewRequirement(rt.ctx.projectRoot, decodeURIComponent(requirementReview[1]));
    if (!data) return respond(res, 404, { ok: false, error: '需求不存在' });
    return respond(res, 200, { ok: true, data });
  }

  if (req.method === 'GET' && pathname === '/data/bugs') {
    const data = app.listBugs(rt.ctx.projectRoot, {
      requirementId: url.searchParams.get('requirementId') || undefined,
      lifecycleStatus: url.searchParams.get('lifecycleStatus') || undefined,
    });
    return respond(res, 200, { ok: true, data });
  }

  if (req.method === 'POST' && pathname === '/data/bugs') {
    const body = await readJson(req) || {};
    const data = app.createBug(rt.ctx.projectRoot, body);
    return respond(res, 201, { ok: true, data });
  }

  const bugPrepare = pathname.match(/^\/data\/bugs\/([^/]+)\/prepare-worktree$/);
  if (req.method === 'POST' && bugPrepare) {
    const body = await readJson(req) || {};
    const data = app.prepareBugWorktree(rt.ctx.projectRoot, decodeURIComponent(bugPrepare[1]), body);
    if (!data) return respond(res, 404, { ok: false, error: 'Bug 不存在' });
    const workRuntime = deps.registry.runtimeFor(data.projectPath);
    if (workRuntime.ctx.adapter === 'cc') {
      workRuntime.ctx.adapters.tools.profile.installProfile(data.projectPath);
      workRuntime.ctx.adapters.tools.profile.installProjectMcp(data.projectPath, workRuntime.ctx.port);
    }
    return respond(res, 201, { ok: true, data });
  }
  const bugReview = pathname.match(/^\/data\/bugs\/([^/]+)\/review$/);
  if (req.method === 'GET' && bugReview) {
    const data = app.reviewBug(rt.ctx.projectRoot, decodeURIComponent(bugReview[1]));
    if (!data) return respond(res, 404, { ok: false, error: 'Bug 不存在' });
    return respond(res, 200, { ok: true, data });
  }

  const bugAction = pathname.match(/^\/data\/bugs\/([^/]+)\/(start|submit|accept|reopen|fail|close|edit)$/);
  if (req.method === 'POST' && bugAction) {
    const body = await readJson(req) || {};
    const id = decodeURIComponent(bugAction[1]);
    const data = bugAction[2] === 'edit'
      ? app.updateBug(rt.ctx.projectRoot, id, {
        ...Object.fromEntries(['title', 'description', 'severity', 'allowAiWork'].filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]])),
        expectedRevision: body.expectedRevision,
      })
      : app.transitionBug(rt.ctx.projectRoot, id, bugAction[2], body);
    if (!data) return respond(res, 404, { ok: false, error: 'Bug 不存在' });
    return respond(res, 200, { ok: true, data });
  }

  const workEventsMatch = pathname.match(/^\/data\/work-events\/(requirement|bug)\/([^/]+)$/);
  if (req.method === 'GET' && workEventsMatch) {
    const data = app.listWorkEvents(rt.ctx.projectRoot, workEventsMatch[1], decodeURIComponent(workEventsMatch[2]));
    if (!data) return respond(res, 404, { ok: false, error: '工作项不存在' });
    return respond(res, 200, { ok: true, data });
  }

  const sessionsMatch = pathname.match(/^\/data\/requirements\/([^/]+)\/sessions$/);
  if (req.method === 'GET' && sessionsMatch) {
    const requirementId = decodeURIComponent(sessionsMatch[1]);
    const data = app.listRequirementSessions(rt.ctx.projectRoot, requirementId, {
      kind: url.searchParams.get('kind') || undefined,
      limit: url.searchParams.get('limit') || undefined,
      cursor: url.searchParams.get('cursor') || undefined,
    });
    if (!data) return respond(res, 404, { ok: false, error: 'requirement not found' });
    return respond(res, 200, { ok: true, data });
  }

  const requirementMatch = pathname.match(/^\/data\/requirements\/([^/]+)$/);
  if (req.method === 'GET' && requirementMatch) {
    const requirement = app.getRequirement(rt.ctx.projectRoot, decodeURIComponent(requirementMatch[1]));
    if (!requirement) return respond(res, 404, { ok: false, error: 'requirement not found' });
    return respond(res, 200, { ok: true, data: requirement });
  }

  return false;
}

module.exports = { handle };
