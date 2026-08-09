import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { getPaths, pluginCmd } from '../lib/paths.js';
import { setupVersion } from '../lib/version.js';
import { logger } from '../lib/ui/log.js';

/**
 * awf plan — 启动规划会话
 *
 * 流程：
 *   1. 选择/确认版本号，写入 state.json
 *   2. 安装 profile settings（skills/commands 注入到目标项目的 .claude/settings.json）
 *   3. 拼接 prompt，spawn claude 进入交互式对话
 */
export async function planCommand(description, options) {
  const paths = getPaths();
  const cwd = process.cwd();

  // 1. 版本号
  await setupVersion(cwd);

  // 2. 安装 profile（增量合并，不影响已有配置）
  installProfile(cwd, paths);

  // 3. 发起交互式对话
  await spawnClaude(cwd, buildPlanPrompt(description, options.resume));
}

// ── plan 专用 helper ──

/** 拼接 plan 阶段发送给 Claude Code 的 prompt 字符串 */
function buildPlanPrompt(description, resume) {
  if (resume) return `${pluginCmd('w-plan')} --resume 请恢复上次规划会话，继续对齐需求`;
  if (description) return `${pluginCmd('w-plan')} ${description}`;
  return `${pluginCmd('w-plan')} 请开始需求规划`;
}

/** spawn Claude Code 交互式进程 */
function spawnClaude(cwd, prompt) {
  return new Promise((resolve, reject) => {
    logger.info('启动规划会话...');
    logger.info(`  ${prompt}\n`);

    const proc = spawn('claude', [
      '--settings', path.join(cwd, '.claude', 'settings.json'),
      '--dangerously-skip-permissions',
      prompt,
    ], { stdio: 'inherit', cwd });

    proc.on('close', (code) => {
      if (code === 0 || code === null) { logger.success('规划会话结束'); resolve(); }
      else reject(new Error(`claude 异常退出，code: ${code}`));
    });
    proc.on('error', (err) => reject(new Error(`无法启动 claude: ${err.message}`)));
  });
}

/** 将 profile 的 settings.json 模板安装到目标项目 */
function installProfile(cwd, paths) {
  const profileDir = path.join(paths.projectRoot, 'profiles', 'plugin-code');
  installProfileSettings(cwd, profileDir, paths.projectRoot);
}

function installProfileSettings(projectRoot, profileDir, pkgRoot) {
  const templatePath = path.join(profileDir, 'settings.json');
  if (!fs.existsSync(templatePath)) {
    return { written: false, path: null, error: `settings.json not found in ${profileDir}` };
  }

  const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  const resolved = resolvePkg(template, pkgRoot);

  const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let existing = {};
  if (fs.existsSync(settingsPath)) {
    existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  }

  const merged = mergeSettings(existing, resolved);
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n');
  return { written: true, path: settingsPath };
}

/** 深合并 settings.json，数组去重追加，对象递归合并 */
function mergeSettings(base, incoming) {
  const result = { ...base };
  for (const [key, val] of Object.entries(incoming)) {
    if (!(key in result)) {
      result[key] = val;
    } else if (Array.isArray(val) && Array.isArray(result[key])) {
      const existing = new Set(result[key]);
      for (const item of val) { if (!existing.has(item)) { result[key].push(item); existing.add(item); } }
    } else if (isPlainObject(val) && isPlainObject(result[key])) {
      result[key] = mergeSettings(result[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/** 递归替换字符串和对象中的 <pkg> 占位符为 package 根路径 */
function resolvePkg(obj, pkgRoot) {
  if (typeof obj === 'string') return obj.replace(/<pkg>/g, pkgRoot);
  if (Array.isArray(obj)) return obj.map((v) => resolvePkg(v, pkgRoot));
  if (isPlainObject(obj)) {
    const result = {};
    for (const [k, v] of Object.entries(obj)) result[k] = resolvePkg(v, pkgRoot);
    return result;
  }
  return obj;
}

/** 判断值是否为纯对象（非数组、非 null） */
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
