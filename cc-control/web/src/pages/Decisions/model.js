import { optionDescription, optionLabel } from '@/shared/components/business/ReviewRecord/model.js';

/**
 * 决策记录的聚合与展示口径（纯函数）。
 *
 * 一次决策在存储里是**多条 append-only 事件**（requested / completed / reviewed / overridden），
 * 这里按 decision_id 聚合成页面上的一条：问题侧字段来自 requested，结论侧来自 completed。
 */
export function aggregateDecisions(entries = []) {
  const groups = new Map();
  for (const [index, entry] of entries.entries()) {
    const id = entry.decision_id || entry.decisionId;
    const key = `${entry.runStamp || ''}:${id || index}`;
    const previous = groups.get(key) || {
      key,
      id,
      records: [],
    };
    const result = entry.result || entry;
    // 问题侧（问题 / 作答形态 / 选项）只在 decision_requested 上，摊平到顶层，
    // 详情与列表才不用按事件分支。
    const request = entry.request || previous.request || null;
    groups.set(key, {
      ...previous,
      ...entry,
      ...result,
      key,
      id,
      request,
      question: request?.question ?? previous.question ?? null,
      options: request?.options ?? previous.options ?? [],
      questions: request?.questions ?? previous.questions ?? [],
      form: request?.form ?? previous.form ?? null,
      // 任务级归因（任务列表据此标出「有决策的任务」）。可以为空 ——
      // 多 agent 下主会话的派发/收尾决策不属于任何单任务。
      task_id: entry.task_id ?? previous.task_id ?? null,
      records: [...previous.records, entry],
      selectedValue: entry.event === 'decision_answered'
        ? entry.value ?? entry.answer ?? previous.selectedValue
        : previous.selectedValue,
      status:
        entry.event === 'decision_overridden' ? 'overridden' : entry.status || previous.status,
      completed:
        previous.completed ||
        entry.event === 'decision_completed' ||
        (!entry.event && entry.answer !== undefined),
    });
  }
  return [...groups.values()].map(entry => {
    const answer = entry.answer ?? entry.value ?? null;
    const options = Array.isArray(entry.options) ? entry.options : [];
    const selectedValue = entry.selectedValue ?? answer;
    const answerText = typeof selectedValue === 'string' ? selectedValue.trim() : '';
    const number = /^\d+$/.test(answerText) ? Number(answerText) : null;
    const selectedOption = number !== null && number > 0 && number <= options.length
      ? options[number - 1]
      : options.find(option => optionLabel(option).trim().toLowerCase() === answerText.toLowerCase()) || null;
    return { ...entry, answer, selectedOption };
  });
}

export { optionDescription, optionLabel };

/** 待复审条数：有结论、且既没复审也没改写（Run 页那一行计数用） */
export function countPendingReview(entries = []) {
  return aggregateDecisions(entries).filter(e => e.completed && e.status === 'pending_review')
    .length;
}
