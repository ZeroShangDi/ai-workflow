'use strict';

// 展示状态属于一次订阅；重连回放按宿主时间计算耗时，不按事件被 CLI 读到的时间计时。
function eventTime(e) {
  const at = typeof e.at === 'number' ? e.at : Date.parse(e.at);
  return Number.isFinite(at) ? at : Date.now();
}

function taskLine(icon, id, title, startedAt, endedAt = Date.now()) {
  const secs = startedAt == null ? 0 : Math.max(0, Math.round((endedAt - startedAt) / 1000));
  return `  ${icon} [${id}] ${title || '未命名任务'} ${secs}s`;
}

const defaultSeen = new Map();
function renderEvent(e, seen = defaultSeen) {
  const p = e.payload || {};
  const id = p.taskId || p.id || '';
  const at = eventTime(e);
  switch (e.type) {
    case 'run.started': return `▶ run 开始（mode=${p.mode || '-'}）`;
    case 'run.stopped': return `■ run 结束（status=${p.status || '-'}）`;
    case 'run.error': return `✖ run 出错：${p.error || ''}`;
    case 'task.started':
      seen.set(id, { title: p.title || '', startedAt: at });
      return taskLine('●', id, p.title, at, at);
    case 'task.done':
    case 'task.blocked': {
      const task = seen.get(id);
      return taskLine(e.type === 'task.done' ? '✓' : '⚠', id, task?.title || p.title, task?.startedAt, at);
    }
    case 'gate.fix': return `  ⚑ 门禁 ${id} 非 pass → 派生修复任务 ${p.fixId || '(未派生)'}`;
    default: return `  · ${e.type}`;
  }
}

// 动态行必须占一物理行。对非 ASCII 字符保守预留两列，避免中文/emoji 标题换行后擦错行。
function fitLine(line, columns) {
  const plain = line.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  if (!columns) return plain;
  const suffix = plain.match(/ \d+s$/)?.[0] || '';
  const content = suffix ? plain.slice(0, -suffix.length) : plain;
  let result = '';
  let width = 0;
  for (const char of content) {
    width += char.codePointAt(0) < 128 ? 1 : 2;
    if (width > columns - suffix.length - 3) return `${result}…${suffix}`;
    result += char;
  }
  return result + suffix;
}

/** TTY 仅重绘活动任务，完成后输出一行；管道保留开始/完成事件，供日志和评测解析。 */
function createRunDisplay({ output = process.stdout, print = (line) => console.log(line) } = {}) {
  const interactive = Boolean(output.isTTY || process.env.AWF_TASK_LIST_INTERACTIVE === '1');
  const seen = new Map();
  const active = new Set();
  let lines = 0;
  let timer = null;
  let suspended = false;

  function clear() {
    if (lines) output.write(`\x1b[${lines}A\r\x1b[0J`);
    lines = 0;
  }

  function draw() {
    if (!interactive || suspended) return;
    clear();
    // 底部区域不超过终端高度；已完成的任务留在普通滚屏记录中。
    const visible = [...active].slice(-Math.max(1, (output.rows || 24) - 2));
    for (const id of visible) {
      const task = seen.get(id);
      output.write(`${fitLine(taskLine('●', id, task.title, task.startedAt), output.columns)}\n`);
    }
    lines = visible.length;
  }

  function log(line) {
    clear();
    print(line);
    draw();
  }

  return {
    event(e) {
      const line = renderEvent(e, seen);
      if (!interactive) return print(line);
      const id = e.payload?.taskId || e.payload?.id || '';
      if (e.type === 'task.started') {
        active.add(id);
        draw();
        if (!timer) {
          timer = setInterval(draw, 1000);
          timer.unref?.();
        }
      } else if (e.type === 'task.done' || e.type === 'task.blocked') {
        active.delete(id);
        log(line);
      } else {
        log(line);
      }
    },
    log,
    // 决策模块会直接写 stdout 并等待输入；期间不能让定时重绘覆盖提示/输入。
    async duringPrompt(fn) {
      suspended = true;
      clear();
      try { return await fn(); } finally { suspended = false; draw(); }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      draw();
      lines = 0;
    },
  };
}

module.exports = { createRunDisplay, renderEvent };
