import { CYAN, DIM, GREEN, YELLOW, RESET } from './colors.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(rest).padStart(2, '0')}s`;
  if (minutes) return `${minutes}m ${String(rest).padStart(2, '0')}s`;
  return `${rest}s`;
}

/**
 * 多 Agent 任务列表。TTY 中始终在原行重绘；重定向输出时降级为普通事件日志。
 * 任务使用 Map 保留首次派发顺序，后续只修改状态。
 */
export function createTaskList({ output = process.stdout, intervalMs = 80 } = {}) {
  const tasks = new Map();
  // eval 需要捕获 awf run 的输出再透传到真实终端，子进程 stdout 会变成 pipe。
  // 仅由 eval 显式置位时仍启用重绘，普通重定向维持静态事件日志。
  const interactive = Boolean(output.isTTY || process.env.AWF_TASK_LIST_INTERACTIVE === '1');
  let frame = 0;
  let renderedLines = 0;
  let timer = null;

  function icon(status) {
    if (status === 'done') return `${GREEN}✓${RESET}`;
    if (status === 'blocked') return `${YELLOW}⚠${RESET}`;
    return `${CYAN}${FRAMES[frame % FRAMES.length]}${RESET}`;
  }

  function line(task) {
    const end = task.completedAt || Date.now();
    const elapsed = formatDuration(end - task.startedAt);
    return `     ${icon(task.status)} ${DIM}[${task.id}]${RESET} ${task.title || '未命名任务'} ${DIM}${elapsed}${RESET}`;
  }

  function clearRendered() {
    if (!interactive || renderedLines === 0) return;
    output.write(`\x1b[${renderedLines}A`);
    for (let i = 0; i < renderedLines; i++) {
      output.write('\r\x1b[2K');
      if (i < renderedLines - 1) output.write('\x1b[1B');
    }
    if (renderedLines > 1) output.write(`\x1b[${renderedLines - 1}A`);
  }

  function render() {
    if (!interactive || tasks.size === 0) return;
    clearRendered();
    output.write(`${[...tasks.values()].map(line).join('\n')}\n`);
    renderedLines = tasks.size;
  }

  function ensureTimer() {
    if (!interactive || timer) return;
    timer = setInterval(() => {
      if (![...tasks.values()].some((task) => task.status === 'active')) return;
      frame++;
      render();
    }, intervalMs);
    timer.unref?.();
  }

  return {
    update(id, title, status) {
      const current = tasks.get(id);
      const task = current || { id, title, status };
      task.title = title || task.title;
      task.status = status;
      if (!task.startedAt) task.startedAt = Date.now();
      if (status !== 'active' && !task.completedAt) task.completedAt = Date.now();
      tasks.set(id, task);

      if (interactive) {
        render();
        ensureTimer();
      } else {
        // 管道/日志文件无法原地更新，保留完整的状态事件。
        output.write(`${line(task)}\n`);
      }
    },

    /** 在动态列表上方安全输出一条普通日志。 */
    log(write) {
      if (!interactive || renderedLines === 0) return write();
      clearRendered();
      renderedLines = 0;
      write();
      render();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      render();
    },
  };
}
