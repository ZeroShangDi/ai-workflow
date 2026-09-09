import { createTaskList } from './task-list.js';
import { CYAN, DIM, GREEN, RESET, YELLOW, RED } from './colors.js';

/**
 * run-follow.js — 宿主 run 的终端跟随展示（T1-060：attach/follow）
 *
 * 单 agent 经 server run host 驱动后，观察方（awf run / --attach / --resume 挂接）需要一个
 * 跟随视图：任务行按生命周期原地更新（active=spinner / done=✓ / blocked=⚠），run 头部与
 * 进度行浮在动态列表上方安全输出。复用 createTaskList 的 TTY 重绘语义：
 *   - TTY：任务行原地重绘（跟随）；
 *   - 非 TTY / 重定向：降级为完整状态事件行（不重绘），与既有静态日志等价。
 *
 * 仅作展示层：状态/进度数据由宿主事件 + 快照驱动，本模块不读盘、不判定。
 */

/**
 * @param {{ output?: NodeJS.WriteStream, print?: (s: string) => void }} opts
 *   output  默认 process.stdout（TTY 判定 + 任务行写入）
 *   print   头部/进度/汇总行的落点（默认 console.log；测试可注入收集）
 */
export function createRunFollow({ output = process.stdout, print = console.log } = {}) {
  const taskList = createTaskList({ output });
  let headerShown = false;
  let countsKey = '';

  /** 在动态列表上方安全输出一行（列表已绘时先清再绘） */
  function above(text) {
    taskList.log(() => print(text));
  }

  return {
    /** 是否启用交互重绘（跟随真实发生在 TTY） */
    get interactive() { return Boolean(output.isTTY || process.env.AWF_TASK_LIST_INTERACTIVE === '1'); },

    /** attach/续接开始：打印 run 头部（一次性） */
    attach({ runId, mode, note } = {}) {
      if (headerShown) return;
      headerShown = true;
      const tag = `${CYAN}── run ${runId}（${mode || ''}）${RESET}`;
      above(tag + (note ? ` ${DIM}${note}${RESET}` : ''));
    },

    /** 进度变化时打一行（counts 快照去重；currentTaskId 提示当前活动任务） */
    status(c = {}) {
      const key = `${c.done}/${c.total}/${c.blocked || 0}`;
      if (!key || key === countsKey) return;
      countsKey = key;
      const tail = c.currentTaskId ? ` · ${DIM}正在: ${c.currentTaskId}${RESET}` : '';
      above(`     ${DIM}进度${RESET} ${GREEN}${c.done}/${c.total}${RESET} done${c.blocked ? `${YELLOW}（${c.blocked} blocked）${RESET}` : ''}${tail}`);
    },

    /** 宿主事件 → 任务行 / 日志（run.*、gate.* 浮在列表上方） */
    event(e) {
      const p = e.payload || {};
      switch (e.type) {
        case 'task.started':
          taskList.update(p.taskId, p.title || '', 'active');
          break;
        case 'task.done':
          taskList.update(p.taskId, null, 'done');
          break;
        case 'task.blocked':
          taskList.update(p.taskId, null, 'blocked');
          break;
        case 'run.started':
          above(`     ${DIM}宿主开始驱动（mode=${p.mode || ''}）${RESET}`);
          break;
        case 'run.phase':
          above(`     ${DIM}阶段 → ${p.phase || ''}${RESET}`);
          break;
        case 'gate.fix':
          above(`     门禁 ${p.taskId} 非 pass → 已派生修复任务`);
          break;
        case 'run.error':
          above(`     ${RED}run 异常：${p.error || ''}${RESET}`);
          break;
        case 'run.stopped':
          above(`     ${DIM}已停止（${p.status || 'stopped'}）${RESET}`);
          break;
        default:
          break;
      }
    },

    /** 结束：停表并打收尾摘要 */
    finish({ status, counts } = {}) {
      const c = counts || {};
      if (status === 'done') {
        above(`\n${GREEN}  ✔ run 完成：${c.done}/${c.total} done，${c.blocked || 0} blocked${RESET}`);
      } else {
        above(`\n${RED}  ✗ run ${status || 'stopped'}${RESET}`);
      }
      taskList.stop();
    },
  };
}
