'use strict';
/**
 * run-settings.cjs — run 专用 settings 生成（statusLine 等 cc 格式）
 *
 * 归位 cli run.js writeRunSettings 的 settings 内容构造，作为「settings 渲染归 cc」的基座。
 * 输出写入 run-settings.json（单 run：.awf/run-settings.json；T1-070 起每 run 渲染：
 * statusLine 可注入 per-run usage 路径，usage 落 .awf/runs/<sid>/context/usage.json，
 * 即按 __SID__ 展开后的每 run 位置）。T1-065：cross-session messaging 降级 tmux 后移除
 * crossSessionInbound（inbox 死代码）。
 */

/**
 * 生成 run-session 专属 settings 对象。
 * @param {{ workdir: string, contextUsageScript: string, usagePath?: string }} opts
 *   contextUsageScript - 指向 infra 的 scripts/context-usage.mjs（statusLine 调用）
 *   usagePath（可选）- per-run 上下文占用落点（T1-070 每 run 渲染 __SID__ 后
 *     .awf/runs/<sid>/context/usage.json）；缺省由 context-usage.mjs 落 <workdir>/.awf/context/
 * @returns {{ statusLine: object }}
 */
function generateRunSettings({ workdir, contextUsageScript, usagePath }) {
  const args = [`"${contextUsageScript}"`, `"${workdir}"`];
  if (usagePath) args.push(`"${usagePath}"`);
  return {
    statusLine: {
      type: 'command',
      command: `node ${args.join(' ')}`,
      refreshInterval: 30,
    },
  };
}

module.exports = { generateRunSettings };
