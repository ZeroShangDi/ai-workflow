'use strict';
/**
 * run-id.cjs — run 标识（sid/run-id）：生成 / 校验 / 派生规则
 *
 * 统一 run 标识的单一实现，替代散落的 runStamp 拼装并为其提供校验/派生规则。
 * 命名规则（SID_PATTERN）同时被 run-context 引用，是 sid 合法性的唯一来源。
 *
 *   - 派生（deriveRunId）：`${version}-<compactISO>`，与现行 runStamp 完全一致
 *     （.awf/logs/<version>-<ts>，ts = toISOString 的 :/. → -、取 19 位），保证
 *     T1-019/072 runStamp→sid 归一可无痛迁移。
 *   - 生成（generateRunId）：派生之上默认追加短随机后缀（base36），保证同版本同秒的
 *     多 run 并发也不冲突；entropy:false 退化为纯派生（= runStamp）。
 *   - 校验（validateRunId）：匹配 [A-Za-z0-9][A-Za-z0-9._-]{0,63}（≤64 字符），
 *     可用于路径/会话名/socket 名，防注入。
 *
 * 本模块只做纯函数，不读写文件、不依赖 cwd；now/random 可注入便于测试与确定性派生。
 */

const SID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SID_MAX_LEN = 64;

/** 校验 run id 是否合法（也接受 null/undefined → false） */
function validateRunId(id) {
  return typeof id === 'string' && SID_PATTERN.test(id);
}

/** 时间戳归一：Date/ISO/字符串 → `YYYY-MM-DDTHH-mm-ss`（19 位，:/. → -），与 runStamp 对齐 */
function normalizeStamp(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) throw new Error(`run-id: 非法时间戳（${String(ts)}）`);
  return d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * 派生 run id：`${version}-<compactISO>`（= runStamp 形状）。
 * @param {{ version: string, ts?: Date|string }} input
 */
function deriveRunId({ version, ts = new Date() } = {}) {
  if (typeof version !== 'string' || version.length === 0) throw new Error(`run-id: version 缺失（${String(version)}）`);
  const id = `${version}-${normalizeStamp(ts)}`;
  if (id.length > SID_MAX_LEN) throw new Error(`run-id: 派生结果超长（${id.length}>${SID_MAX_LEN}）：${id}`);
  if (!validateRunId(id)) throw new Error(`run-id: 派生结果非法：${id}（version 含不允许字符？）`);
  return id;
}

/** 默认熵：2 字节随机数 → base36（≤4 字符），保证并发唯一 */
function defaultEntropy() {
  return require('node:crypto').randomBytes(2).readUInt16BE(0).toString(36);
}

/**
 * 生成唯一 run id：派生 + 短随机后缀；entropy:false 退化为纯派生（= runStamp）。
 * @param {{ version: string, ts?: Date|string, entropy?: boolean, random?: string }} input
 */
function generateRunId({ version, ts = new Date(), entropy = true, random } = {}) {
  const base = deriveRunId({ version, ts });
  if (!entropy) return base;
  const suffix = random != null ? random : defaultEntropy();
  const id = `${base}-${suffix}`;
  if (id.length > SID_MAX_LEN || !validateRunId(id)) {
    throw new Error(`run-id: 生成结果非法/超长：${id}`);
  }
  return id;
}

/**
 * runStamp→sid 归一（T1-072）：显式 sid 即 run stamp（决策/日志/指标按此隔离不串 run）；
 * 无 sid 回退派生 `${version}-<ts>`（与 run-logger 现行 runStamp 对齐）。
 * @param {{ sid?: string, version: string, ts?: Date|string }} input
 */
function resolveRunStamp({ sid, version, ts = new Date() } = {}) {
  if (sid != null && sid !== '') {
    if (!validateRunId(sid)) throw new Error(`run-id: 非法 sid ${String(sid)}`);
    return sid;
  }
  return deriveRunId({ version, ts });
}

module.exports = { SID_PATTERN, SID_MAX_LEN, validateRunId, normalizeStamp, deriveRunId, generateRunId, resolveRunStamp };
