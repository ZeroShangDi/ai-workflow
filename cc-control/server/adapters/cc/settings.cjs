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
  // 每个参数都加双引号：这三个都是绝对路径，可能含空格，不加会被 shell 拆错
  const args = [`"${contextUsageScript}"`, `"${workdir}"`];
  // usagePath 可选：给了才作为第 3 个位置参数传给脚本（每 run 的 usage.json 落点）
  if (usagePath) args.push(`"${usagePath}"`);
  return {
    statusLine: {
      // cc 的 statusLine 契约：type 'command' + command 字符串，cc 会周期性地跑它并用 stdout 做状态行
      type: 'command',
      command: `node ${args.join(' ')}`,
      // 刷新间隔（秒）：30s 一次，够及时又不至于频繁 spawn 脚本
      refreshInterval: 30,
    },
  };
}

module.exports = { generateRunSettings };
