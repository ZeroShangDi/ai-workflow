/**
 * skills.js — 把包内的 `skills/<name>/SKILL.md` 注册成 DSH 技能
 *
 * 为什么不是「把技能目录投影到 `$DSH_HOME/skills` 然后等平台扫」：
 *   - DSH 的 `skill-filesystem` 在 web 组合里位于 **agent preset 平面**（host 行 disabled，F18），
 *     技能根是固定的一组（`<项目>/.dsh/skills`、`$DSH_HOME/skills` 等），插件往里塞等于
 *     **全局可见** —— 用户自己开的普通会话也会看到全部 AWF 技能，还会抢同名技能；
 *   - `skills` 服务本身有运行时注册口（`register()`，RUNTIME_RANK），在 **setup 窗口**
 *     用 `agentCtx` 注册即落在该 agent 的作用域层 —— 只有 AWF 自己建的会话看得到。
 *
 * 于是：**安装 = 软链插件目录，技能由插件在会话建立时自己注册**，不再往用户 home 里铺链接森林。
 * 副作用是把 install.cjs 里那套 `installSkills/uninstallSkills` 变成纯清理路径（见那里的注释）。
 *
 * `resourceBase` 指向技能目录：部分技能带 `references/*.md`，DSH 会用它解析相对资源。
 */

import { listSkills } from './assets.js';

/** 注册来源标签（DSH 的 SkillSummary.provider，提示词里可见，便于分辨技能出自哪） */
const PROVIDER = 'awf-dsh';

/**
 * 来源桶（`SkillSummary.source`）。**必填**，且 register 时**不校验**、load 时才校验 ——
 * 少了它的表现极具迷惑性：技能在 `/` 目录里看得见（summary 不需要它），
 * 一调用就 `Error: loaded skill "X" source must be a string`（`dsh-skill/lib/index.js:486`）。
 * 真机踩到过一次。我们是在会话作用域运行时注册的，所以是 `runtime` 桶。
 */
const SOURCE = 'runtime';

/**
 * 给一个会话注册包内全部技能。
 * @param {object} agentCtx setup 窗口里拿到的 agent 作用域 ctx
 * @param {{log: Function}} [deps]
 * @returns {{registered: string[], failed: Array<{name: string, reason: string}>}}
 */
export function registerSkills(agentCtx, { log = () => {} } = {}) {
  const skills = typeof agentCtx?.get === 'function' ? agentCtx.get('skills') : undefined;
  if (!skills?.register) {
    // 明确告警而不是静默：没有技能面，plan 阶段的 awf-plan-* 方法论就加载不到
    log('warn', 'skills 服务不可用 —— 本会话没有 AWF 技能（命令正文里的「按需加载技能」会落空）');
    return { registered: [], failed: [{ name: '(all)', reason: 'skills 服务不可用' }] };
  }

  const { skills: entries, skipped } = listSkills();
  for (const s of skipped) log('warn', `技能跳过：${s.dir} —— ${s.reason}`);

  const registered = [];
  const failed = [];
  for (const s of entries) {
    try {
      // `register()` 返回的就是该作用域的 effect disposer —— 注册在 setup 窗口（agent 作用域）里，
      // 随会话销毁自动注销，这里不需要再包一层 effect。
      skills.register(toRegistration(s));
      registered.push(s.name);
    } catch (err) {
      // 单条失败不拖垮其余（同名冲突时 DSH 是 first-wins + 警告，这里也要留痕）
      log('warn', `技能 ${s.name} 注册失败：${err.message}`);
      failed.push({ name: s.name, reason: err.message });
    }
  }
  log('info', `已注册 ${registered.length} 个技能到本会话`);
  return { registered, failed };
}

/** assets 条目 → DSH 的 SkillRegistration（纯函数，便于单测） */
export function toRegistration(s) {
  return {
    name: s.name,
    description: s.description,
    content: s.body,
    ...(s.whenToUse ? { whenToUse: s.whenToUse } : {}),
    source: SOURCE,
    provider: PROVIDER,
    resourceBase: { kind: 'directory', path: s.dir },
    invocation: { modelInvocable: true, userInvocable: true },
  };
}
