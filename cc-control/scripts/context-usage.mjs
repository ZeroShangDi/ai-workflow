#!/usr/bin/env node
/**
 * 状态行命令 — 从 Claude Code statusline stdin JSON 提取上下文占用，写入 .awf/context/usage.json
 *
 * 作用链：awf run 会话的 statusLine 配置（.awf/run-settings.json，bootstrap 以 --settings 注入）
 *   → 每个状态事件 / refreshInterval 触发本脚本
 *   → 解析 context_window → 写 .awf/context/usage.json
 *   → CLI 任务前上下文检查（maybeCompactContext 的 formatContextUsage）读取实测百分比
 *
 * 降级：statusline 未配置 / used_percentage 为 null（会话早期）→ usage.json 无百分比
 *   → CLI 回退为「未知，AI 自行估算」
 *
 * stdout 输出状态行文本（如 "ctx 62%"），任何异常静默降级，绝不中断状态行。
 */
import fs from 'node:fs';
import path from 'node:path';

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (c) => (raw += c));
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(''));
    // 兜底：stdin 异常不结束时不让状态行卡死（正常路径由 end 提前 resolve）
    const timer = setTimeout(() => resolve(raw), 500);
    timer.unref?.();
  });
}

async function main() {
  let info = {};
  try { info = JSON.parse((await readStdin()) || '{}'); } catch { /* 非 JSON 输入 → 无数据 */ }

  const cw = info?.context_window;
  // 写盘位置：优先用 CLI 注入的固定 workdir（argv[2]），否则回退会话 cwd ——
  // 会话 cwd 会随 AI 在任务间 cd 漂移，导致 usage.json 写到别处、CLI 读到旧值。
  const cwd = process.argv[2] || info?.cwd || process.cwd();
  const pct = typeof cw?.used_percentage === 'number' ? cw.used_percentage : null;

  if (cw) {
    try {
      const dir = path.join(cwd, '.awf', 'context');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'usage.json'),
        JSON.stringify(
          {
            used_percentage: pct,
            remaining_percentage: typeof cw.remaining_percentage === 'number' ? cw.remaining_percentage : null,
            context_window_size: cw.context_window_size ?? null,
            total_input_tokens: cw.total_input_tokens ?? null,
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch { /* 写失败不影响状态行 */ }
  }

  process.stdout.write(pct !== null ? `ctx ${pct}%` : 'ctx ?');
}

main();
