'use strict';
/**
 * run-settings.cjs — run 专用 settings 生成（statusLine/crossSessionInbound 等 cc 格式）
 *
 * 归位 cli run.js writeRunSettings 的 settings 内容构造，作为「settings 渲染归 cc」的基座
 * （W1-070 每 run settings 渲染 __SID__ 时在此扩展）。输出写入 .awf/run-settings.json 供
 * claude --settings 注入（合并语义，仅覆盖声明键，不动用户/项目 settings）。
 */

/**
 * 生成 run-session 专属 settings 对象。
 * @param {{ workdir: string, contextUsageScript: string }} opts
 *   contextUsageScript - 指向 infra 的 scripts/context-usage.mjs（statusLine 调用）
 * @returns {{ crossSessionInbound: string, statusLine: object }}
 */
function generateRunSettings({ workdir, contextUsageScript }) {
  return {
    crossSessionInbound: 'accept',
    statusLine: {
      type: 'command',
      command: `node "${contextUsageScript}" "${workdir}"`,
      refreshInterval: 30,
    },
  };
}

module.exports = { generateRunSettings };
