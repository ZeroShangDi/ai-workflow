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
 * 边界：本模块只做纯函数，不读写文件、不依赖 cwd（时间/随机均可注入），也不决定 sid 的
 * 语义来源（那是 run-context / server 的职责）。所有派生结果都会自检长度与合法性，宁抛错不含糊。
 */

/** sid 合法字符集：首字符必须是字母数字（避免以 -/. 开头拼出奇怪路径），后续允许 . _ -，总长 ≤64 */
const SID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** 与 SID_PATTERN 的 {0,63} 对应的总长度上限（首字符 + 最多 63） */
const SID_MAX_LEN = 64;

/**
 * 校验 run id 是否合法（也接受 null/undefined → false）。
 * 这是 sid 合法性的唯一判据，run-context 等均复用它，不要另写正则。
 * @param {*} id
 * @returns {boolean}
 */
function validateRunId(id) {
  return typeof id === 'string' && SID_PATTERN.test(id);
}

/**
 * 时间戳归一：Date/ISO/字符串 → `YYYY-MM-DDTHH-mm-ss`（19 位，:/. → -），与 runStamp 对齐。
 * slice(0,19) 截到「秒」：与 runStamp / 版本快照文件名（<version>-<ts>）保持同一精度，
 * 迁移时旧日志名可直接对应。
 * @param {Date|string} ts
 * @returns {string} 19 位紧凑时间戳
 * @throws {Error} 无法解析为合法时间
 */
function normalizeStamp(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) throw new Error(`run-id: 非法时间戳（${String(ts)}）`);
  return d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * 派生 run id：`${version}-<compactISO>`（= runStamp 形状）。
 * @param {{ version: string, ts?: Date|string }} input
 * @returns {string} 形如 `0.2.0-2026-09-12T10-30-00`
 * @throws {Error} version 缺失/非字符串，或派生结果超长、含非法字符（version 里带了不允许的字符）
 */
function deriveRunId({ version, ts = new Date() } = {}) {
  if (typeof version !== 'string' || version.length === 0) throw new Error(`run-id: version 缺失（${String(version)}）`);
  const id = `${version}-${normalizeStamp(ts)}`;
  // 自检：version 来自外部（state.version / 配置），可能含中文、/ 等非法字符，此处兜住
  if (id.length > SID_MAX_LEN) throw new Error(`run-id: 派生结果超长（${id.length}>${SID_MAX_LEN}）：${id}`);
  if (!validateRunId(id)) throw new Error(`run-id: 派生结果非法：${id}（version 含不允许字符？）`);
  return id;
}

/** 默认熵：2 字节随机数 → base36（≤4 字符），保证并发唯一 */
function defaultEntropy() {
  // 延迟 require：只有真正需要熵时才加载 crypto，且便于测试替换随机源
  return require('node:crypto').randomBytes(2).readUInt16BE(0).toString(36);
}

/**
 * 生成唯一 run id：派生 + 短随机后缀；entropy:false 退化为纯派生（= runStamp）。
 * @param {{ version: string, ts?: Date|string, entropy?: boolean, random?: string }} input
 *   entropy=false → 不加后缀；random 可注入固定后缀（测试用，跳过随机）
 * @returns {string} entropy 时形如 `<version>-<ts>-<base36>`
 * @throws {Error} 派生失败，或加后缀后超长/非法
 */
function generateRunId({ version, ts = new Date(), entropy = true, random } = {}) {
  const base = deriveRunId({ version, ts });
  if (!entropy) return base;
  const suffix = random != null ? random : defaultEntropy();
  const id = `${base}-${suffix}`;
  // 加了后缀可能触发长度上限（base 接近 64 时），这里再自检一次
  if (id.length > SID_MAX_LEN || !validateRunId(id)) {
    throw new Error(`run-id: 生成结果非法/超长：${id}`);
  }
  return id;
}

/**
 * runStamp→sid 归一（T1-072）：显式 sid 即 run stamp（决策/日志/指标按此隔离不串 run）；
 * 无 sid 回退派生 `${version}-<ts>`（与 run-logger 现行 runStamp 对齐）。
 * @param {{ sid?: string, version: string, ts?: Date|string }} input
 * @returns {string} 归一后的 run 标签
 * @throws {Error} 显式 sid 非法；或（无 sid 时）version/ts 无法派生
 */
function resolveRunStamp({ sid, version, ts = new Date() } = {}) {
  // '' 视为「未提供」：env 里未设置的 CC_RUN_ID 可能传成空串，不能当成非法 sid 报错
  if (sid != null && sid !== '') {
    if (!validateRunId(sid)) throw new Error(`run-id: 非法 sid ${String(sid)}`);
    return sid;
  }
  return deriveRunId({ version, ts });
}

// 对外：校验/归一/派生/生成四类原语 + 两个常量（SID_PATTERN 被 run-context 复用为合法性单源）。
module.exports = { SID_PATTERN, SID_MAX_LEN, validateRunId, normalizeStamp, deriveRunId, generateRunId, resolveRunStamp };
