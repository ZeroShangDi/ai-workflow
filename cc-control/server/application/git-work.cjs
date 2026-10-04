'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { PersistenceError } = require('../persistence/errors.cjs');
const workError = message => new PersistenceError('CONFLICT', message);

function runGit(root, args) {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 5 * 1024 * 1024 }).trim(); }
  catch (error) { throw workError(String(error.stderr || error.message || 'Git 操作失败').trim()); }
}

function configPath(projectRoot) { return path.join(projectRoot, '.awf', 'work.json'); }

function readConfig(projectRoot) {
  try { return JSON.parse(fs.readFileSync(configPath(projectRoot), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { git: null, automation: { maxConcurrentTotal: 1 } }; throw error; }
}

function validateConfig(projectRoot, input) {
  const git = input?.git;
  if (!git || typeof git.repositoryRoot !== 'string' || typeof git.targetBranch !== 'string') throw workError('请设置 Git 仓库根目录和目标分支');
  if (!fs.existsSync(path.resolve(git.repositoryRoot))) throw workError('Git 仓库根目录不存在');
  if (!fs.existsSync(path.resolve(projectRoot))) throw workError('项目目录不存在');
  const repositoryRoot = fs.realpathSync(path.resolve(git.repositoryRoot));
  const root = fs.realpathSync(path.resolve(projectRoot));
  const actualTop = fs.realpathSync(runGit(repositoryRoot, ['rev-parse', '--show-toplevel']));
  if (actualTop !== repositoryRoot) throw workError('repositoryRoot 必须是 Git 仓库根目录');
  const relative = path.relative(repositoryRoot, root);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw workError('项目目录不在指定 Git 仓库内');
  if (git.projectRelativePath !== undefined && path.normalize(git.projectRelativePath) !== (relative || '.')) throw workError('projectRelativePath 与项目目录不一致');
  const targetBranch = git.targetBranch.trim();
  if (!targetBranch || targetBranch.startsWith('-')) throw workError('目标分支无效');
  runGit(repositoryRoot, ['rev-parse', '--verify', `refs/heads/${targetBranch}^{commit}`]);
  const max = Number(input?.automation?.maxConcurrentTotal ?? 1);
  if (max !== 1) throw workError('当前运行引擎只支持全局同时处理 1 项');
  return { git: { repositoryRoot, projectRelativePath: relative || '.', targetBranch }, automation: { maxConcurrentTotal: max } };
}

function writeConfig(projectRoot, input) {
  const config = validateConfig(projectRoot, input);
  const file = configPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return config;
}

function listBranches(repositoryRoot) {
  if (!repositoryRoot || !fs.existsSync(repositoryRoot)) throw workError('请先选择 Git 仓库根目录');
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const actualTop = fs.realpathSync(runGit(root, ['rev-parse', '--show-toplevel']));
  if (actualTop !== root) throw workError('请选择 Git 仓库根目录');
  const output = runGit(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  return output ? output.split('\n').filter(Boolean) : [];
}

function verifyMerged(projectRoot, { branchName, headSha, targetHeadSha } = {}) {
  const stored = readConfig(projectRoot);
  const config = validateConfig(path.join(stored.git?.repositoryRoot || projectRoot, stored.git?.projectRelativePath || '.'), stored);
  if (!branchName || !headSha || branchName === config.git.targetBranch) throw workError('请提供独立工作分支及其提交 SHA');
  const root = config.git.repositoryRoot;
  const branchHead = runGit(root, ['rev-parse', '--verify', `refs/heads/${branchName}^{commit}`]);
  if (branchHead !== headSha) throw workError('待验收提交与工作分支当前 HEAD 不一致，请重新审查');
  const targetHead = runGit(root, ['rev-parse', '--verify', `refs/heads/${config.git.targetBranch}^{commit}`]);
  if (targetHeadSha && targetHeadSha !== targetHead) throw workError('目标分支自审查后已更新，请刷新验收材料');
  try { runGit(root, ['merge-base', '--is-ancestor', headSha, targetHead]); }
  catch { throw workError('工作分支提交尚未合入目标分支'); }
  return { headSha, mergedHeadSha: targetHead, branchName, targetBranch: config.git.targetBranch };
}

function reviewBranch(projectRoot, { branchName, baseSha } = {}) {
  const stored = readConfig(projectRoot);
  const config = validateConfig(path.join(stored.git?.repositoryRoot || projectRoot, stored.git?.projectRelativePath || '.'), stored);
  if (!branchName || !baseSha) throw workError('尚未记录该工作项的独立工作分支');
  const root = config.git.repositoryRoot;
  const headSha = runGit(root, ['rev-parse', '--verify', `refs/heads/${branchName}^{commit}`]);
  const targetHeadSha = runGit(root, ['rev-parse', '--verify', `refs/heads/${config.git.targetBranch}^{commit}`]);
  let merged = false;
  try { runGit(root, ['merge-base', '--is-ancestor', headSha, targetHeadSha]); merged = true; } catch { /* not merged */ }
  const summary = runGit(root, ['diff', '--stat', `${baseSha}..${headSha}`]);
  const diff = runGit(root, ['diff', '--no-ext-diff', '--no-color', `${baseSha}..${headSha}`]);
  return { branchName, baseSha, headSha, targetBranch: config.git.targetBranch, targetHeadSha, merged, summary, diff: diff.slice(0, 300000), truncated: diff.length > 300000 };
}

function prepareWorktree(projectRoot, { projectId, itemType, itemId, requirementId, priorBaseSha } = {}) {
  const config = validateConfig(projectRoot, readConfig(projectRoot));
  const repositoryRoot = config.git.repositoryRoot;
  const branchName = `codex/${itemType === 'bug' ? 'bug' : 'feature'}/${String(itemId).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 36)}`;
  runGit(repositoryRoot, ['check-ref-format', '--branch', branchName]);
  const branchExists = (() => { try { runGit(repositoryRoot, ['rev-parse', '--verify', `refs/heads/${branchName}`]); return true; } catch { return false; } })();
  const baseSha = runGit(repositoryRoot, ['rev-parse', '--verify', `refs/heads/${config.git.targetBranch}^{commit}`]);
  const managedRoot = path.resolve(process.env.AWF_WORKTREE_ROOT || path.join(os.homedir(), '.awf', 'worktrees'));
  const worktreePath = path.join(managedRoot, String(projectId), `${itemType}-${itemId}`);
  if (branchExists) {
    if (!fs.existsSync(worktreePath) || fs.realpathSync(runGit(worktreePath, ['rev-parse', '--show-toplevel'])) !== fs.realpathSync(worktreePath)) {
      throw workError('工作分支已存在但原工作区不可用，请人工恢复，不能创建同名分支');
    }
    const projectPath = path.resolve(worktreePath, config.git.projectRelativePath);
    const identity = JSON.parse(fs.readFileSync(path.join(projectPath, '.awf', 'project.json'), 'utf8'));
    if (identity.projectId !== projectId) throw workError('原工作区项目身份不匹配');
    return { worktreePath, projectPath, branchName, baseSha: priorBaseSha || runGit(repositoryRoot, ['merge-base', baseSha, branchName]), requirementId, recovered: true };
  }
  if (fs.existsSync(worktreePath)) throw workError('托管工作区路径已存在，请先检查并恢复原工作区');
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  runGit(repositoryRoot, ['worktree', 'add', '-b', branchName, worktreePath, baseSha]);
  const projectPath = path.resolve(worktreePath, config.git.projectRelativePath);
  try {
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) throw workError('目标分支中没有项目目录');
    const sourceAwf = path.join(projectRoot, '.awf');
    const targetAwf = path.join(projectPath, '.awf');
    fs.mkdirSync(targetAwf, { recursive: true });
    for (const name of ['project.json', 'config.json', 'state.json', 'work.json']) {
      const source = path.join(sourceAwf, name);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(targetAwf, name));
    }
    if (!fs.existsSync(path.join(targetAwf, 'project.json'))) throw workError('项目身份文件缺失');
    return { worktreePath, projectPath, branchName, baseSha, requirementId };
  } catch (error) {
    try { runGit(repositoryRoot, ['worktree', 'remove', '--force', worktreePath]); } catch { /* preserve the original error */ }
    try { runGit(repositoryRoot, ['branch', '-D', branchName]); } catch { /* keep recoverable branch if cleanup fails */ }
    throw error;
  }
}

module.exports = { readConfig, writeConfig, listBranches, verifyMerged, reviewBranch, validateConfig, prepareWorktree };
