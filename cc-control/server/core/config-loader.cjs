'use strict';
/**
 * config-loader.cjs — 共享配置加载原语（默认值合并 + env 覆盖 + 校验）
 *
 * 形态：CJS 共享模块（与 decision-config.cjs 同一约定），CLI(ESM) 以
 *   import loader from './config-loader.cjs'
 * 消费，server/脚本(CJS) 以 require() 消费，双端同一实现。
 *
 * 目标：把散落在 cli/server/scripts/插件的「配置读取 + 常量默认 + env 覆盖」收敛为一套
 * 可校验原语，为「config 单源 / 运行期常量收敛到 config+env」提供底座。本模块只提供原语，
 * 不绑定具体配置源——默认值与 env 名由消费方在 rules 里声明（plugin/config.json 是注册单源、
 * .awf/config.json 是项目 run 单源，env 是运行覆盖层）。
 *
 * 三类能力：
 *   1. 默认值合并 —— loadConfig 依 rules 逐 key 用 default 兜底；deepMerge 做整段对象合并
 *   2. env 覆盖    —— 规则声明 env 名，环境变量优先级最高（env > 文件 > default），
 *                      env 字符串按 type 强转（boolean/integer/number/json）
 *   3. 校验        —— 声明式类型/边界校验，strict 抛 ConfigError（聚合全部字段错误），
 *                     非 strict 对非法字段回落 default（保留现有 .awf/config.json 静默回落语义）
 *
 * 消费约定：点分 key 定位嵌套字段（如 'run.agents.max'）；文件侧来自 JSON 已带类型，不强制转，
 * 只校验；env 侧一律是字符串，先强转后校验。
 */

const fs = require('node:fs');

/** 校验失败聚合错误：errors 为逐字段说明（严格模式抛出） */
class ConfigError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 深合并：普通对象逐层递归合并（patch 优先），数组/标量整体替换；返回新对象，不改入参。
 * 典型用途：默认配置整段 + 用户 JSON 覆盖 → 默认值合并。
 */
function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out = { ...base };
  for (const [k, pv] of Object.entries(patch)) {
    out[k] = isPlainObject(pv) && isPlainObject(out[k]) ? deepMerge(out[k], pv) : pv;
  }
  return out;
}

/**
 * 读 JSON 文件 → 解析值。
 *   optional=false（缺省）：缺失 / 非法 JSON → 抛 ConfigError（配置单源必须存在时用）
 *   optional=true：缺失 / 非法 JSON → 返回 null（默认兜底由消费方接管，如 .awf/config.json）
 */
function readJsonFile(filePath, { optional = false } = {}) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  } catch (err) {
    if (optional) return null;
    // 保留底层 fs 错误码（如 ENOENT）：调用方可能据此做「配置缺失→优雅跳过」的分支
    const e = new ConfigError(`读取配置文件失败：${filePath}（${err.code || err.message}）`);
    e.code = err.code;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    if (optional) return null;
    throw new ConfigError(`配置文件非法 JSON：${filePath}`);
  }
}

/** 点分路径读取（内部）；段缺失返回 undefined */
function getPath(obj, dottedPath) {
  let cur = obj;
  for (const seg of dottedPath.split('.')) {
    if (cur === undefined || cur === null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** 点分路径写入（内部）；父段缺失自动建普通对象 */
function setPath(obj, dottedPath, value) {
  const segs = dottedPath.split('.');
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (!isPlainObject(cur[seg])) cur[seg] = {};
    cur = cur[seg];
  }
  cur[segs[segs.length - 1]] = value;
  return obj;
}

const TYPE_NAMES = { string: '字符串', number: '数字', integer: '整数', boolean: '布尔值', object: '对象', array: '数组', json: 'JSON' };

/** 由 default 推断 env 强转类型（缺省 string） */
function inferType(defaultValue) {
  if (typeof defaultValue === 'boolean') return 'boolean';
  if (typeof defaultValue === 'number') return Number.isInteger(defaultValue) ? 'integer' : 'number';
  return 'string';
}

/** 格式化值（错误信息用），超长截断 */
function repr(value) {
  const s = typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/** env 字符串按 type 强转；失败返回 { error } */
function coerceEnv(raw, type) {
  const s = String(raw);
  try {
    switch (type) {
      case 'boolean': {
        const t = s.toLowerCase();
        if (t === 'true' || t === '1') return { value: true };
        if (t === 'false' || t === '0') return { value: false };
        return { error: `仅接受 true/false/1/0` };
      }
      case 'integer': {
        const n = Number(s);
        return Number.isInteger(n) ? { value: n } : { error: `需为整数` };
      }
      case 'number': {
        const n = Number(s);
        return Number.isFinite(n) ? { value: n } : { error: `需为有限数字` };
      }
      case 'json':
        return { value: JSON.parse(s) };
      case 'string':
      default:
        return { value: s };
    }
  } catch {
    return { error: `需为合法 ${TYPE_NAMES[type] || type}` };
  }
}

/**
 * 校验最终值是否符合规则；返回错误列表（空 = 通过）。
 * 文件/默认值已带类型，只做类型与边界校验；env 值已在 coerceEnv 强转。
 */
function checkValue(value, rule) {
  const errors = [];
  const type = rule.type;
  if (type && type !== 'json') {
    const ok =
      type === 'integer'
        ? Number.isInteger(value)
        : type === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : type === 'boolean'
            ? typeof value === 'boolean'
            : type === 'string'
              ? typeof value === 'string'
              : type === 'array'
                ? Array.isArray(value)
                : type === 'object'
                  ? isPlainObject(value)
                  : true;
    if (!ok) errors.push(`应为 ${TYPE_NAMES[type]}，收到 ${repr(value)}`);
  }
  if (typeof value === 'number') {
    if (rule.min !== undefined && value < rule.min) errors.push(`不能小于 ${rule.min}`);
    if (rule.max !== undefined && value > rule.max) errors.push(`不能大于 ${rule.max}`);
  }
  if (typeof value === 'string' && rule.pattern && !rule.pattern.test(value)) {
    errors.push(`不匹配 ${rule.pattern}`);
  }
  if (rule.enum && !rule.enum.includes(value)) errors.push(`应为 ${rule.enum.join(' | ')} 之一，收到 ${repr(value)}`);
  return errors;
}

/**
 * 加载一份配置：default 兜底 + 文件覆盖 + env 覆盖 + 校验。
 *
 * spec = {
 *   rules,             // { '<点分key>': rule }；rule = { default?, env?, type?, required?, min?, max?, pattern?, enum? }
 *                      //   type: string|number|integer|boolean|object|array|json（缺省按 default 推断，无 default 视为 string）
 *   source,            // { filePath, optional? } 可选文件源（JSON，点分 key 读取）
 *   env,               // 环境变量对象（缺省 process.env）
 *   strict             // 缺省 true：任一字段非法/必填缺失 → 抛 ConfigError（聚合全部字段）
 *                      // false：非法字段回落 default（无 default 则丢弃该字段，不抛）
 *   passthrough        // 缺省 false：true = 以整份文件为基底，rules 只对其声明的 key 兜底/覆盖/校验，
 *                      //               未声明的文件字段原样保留（整份文档校验/局部改写的加载形态）
 * }
 *
 * 优先级：env（rule.env 命中）> 文件值 > rule.default。
 * 返回按点分 key 展开为嵌套对象的配置；strict 抛 ConfigError，其 errors 为逐字段原因。
 */
function loadConfig({ rules, source, env = process.env, strict = true, passthrough = false } = {}) {
  const fileObj = source ? readJsonFile(source.filePath, { optional: source.optional }) : null;
  const errors = [];
  // passthrough：以文件为基底保留未声明字段；否则仅输出 rules 声明的 key
  const out = passthrough && isPlainObject(fileObj) ? fileObj : {};

  for (const [key, specRule] of Object.entries(rules || {})) {
    const rule = { type: inferType(specRule.default), required: false, ...specRule };
    if (rule.type === undefined) rule.type = 'string';

    const hasEnv = rule.env != null && env[rule.env] !== undefined;
    const fileValue = fileObj === null ? undefined : getPath(fileObj, key);
    const hasFile = fileValue !== undefined;
    const hasDefault = rule.default !== undefined;

    if (!hasEnv && !hasFile && !hasDefault) {
      // 无任何来源：strict 下必填缺失算错；非 strict 视为可选，直接跳过
      if (strict && rule.required) errors.push(`[${key}] 缺少必填配置${rule.env ? `（可用环境变量 ${rule.env} 提供）` : ''}`);
      continue;
    }

    let value;
    let fieldErrors = [];
    if (hasEnv) {
      const coerced = coerceEnv(env[rule.env], rule.type);
      if (coerced.error) fieldErrors.push(`[${key}] 环境变量 ${rule.env} 需为 ${TYPE_NAMES[rule.type]}：${coerced.error}，收到 ${repr(env[rule.env])}`);
      else value = coerced.value;
    } else {
      value = hasFile ? fileValue : rule.default;
    }
    if (fieldErrors.length === 0) fieldErrors = checkValue(value, rule).map((e) => `[${key}] ${e}`);

    if (fieldErrors.length > 0) {
      if (strict) {
        errors.push(...fieldErrors);
        value = undefined; // 出错字段不写回（随后整份抛 ConfigError）
      } else if (hasDefault) {
        value = rule.default; // 非严格：非法回落默认
      } else {
        continue; // 非严格且无默认：丢弃该字段（保持现状的静默回落）
      }
    }
    if (value !== undefined) setPath(out, key, value);
  }

  if (strict && errors.length > 0) {
    throw new ConfigError(`配置校验失败（${errors.length} 项）：\n  ${errors.join('\n  ')}`, errors);
  }
  return out;
}

module.exports = { ConfigError, deepMerge, readJsonFile, loadConfig };
