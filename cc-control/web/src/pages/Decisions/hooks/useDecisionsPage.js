import { reviewResultMessage } from '@/shared/components/business/ReviewRecord/model.js';
import { aggregateDecisions } from '@/pages/Decisions/model.js';
import { useRecordSelection } from '@/shared/hooks/useRecordSelection.js';
import { useAction } from '@/shared/hooks/useAction.js';
import { API } from '@/shared/api/index.js';
import { taskDisplayId } from '@/shared/lib/task.js';
export function useDecisionsPage({ data, client, refresh, task = '' }) {
  // 只滤掉 `deciding`（只有问题侧、结论还没产出，几十秒的过渡态；真出异常时闸门会落一条
  // deferred fallback 结论，不会永久停在半截）。「等待人工」（子 Agent 举牌上抛）**要显示** ——
  // 它确实在等人，藏起来等于把上抛吞掉。
  const all = aggregateDecisions(data.decisions?.decisions || []).filter(
    e => e.status !== 'deciding',
  ).map((entry, index) => ({ ...entry, displayId: `D${index + 1}` }));
  // task 来自 URL 参数（任务列表的 badge 点过来），筛出该任务相关的决策
  const entries = task ? all.filter(e => e.task_id === task) : all;
  const taskLabel = taskDisplayId((data.workspace?.tasks || []).find(row => row.id === task)) || task;
  const selection = useRecordSelection(entries, e => e.key);
  const operation = useAction(client, refresh, reviewResultMessage);
  const { item, reviewer, instruction } = selection;
  const id = item?.id;
  const approvable =
    item?.subject?.capability === 'dynamic_planning' && item.status === 'awaiting_human';
  const ambiguousId = entries.filter(e => e.id === id).length > 1;
  // 复审区只在「待复审」时出现：已采纳 / 已改写都是终态，不再重复处理。
  // 上抛来的「等待人工」不在这里 —— 它的动作不是复审，而是把对应任务解阻塞（任务页）。
  const overrideable = !ambiguousId && item?.status === 'pending_review';

  // 决策复审（AI 自决 + 人工事后复审）：有结论、还没被复审也没被改写。
  // 与 approvable（动态规划提案的批准）是两条业务线，只是共用这个页面的壳。
  const reviewable =
    !ambiguousId &&
    item?.subject?.capability !== 'dynamic_planning' &&
    item?.completed &&
    item.status === 'pending_review';
  return {
    ...selection,
    ...operation,
    id,
    approvable,
    alternative: () =>
      operation.action(API.proposalAction(item.subject.proposal_id, 'alternative'), {
        reviewer,
        instruction,
      }),
    overrideable,
    title: '决策记录',
    emptyLabel: '决策记录',
    // 从任务列表 badge 跳进来时，列表头要说明「现在是按任务筛的」，否则会以为记录丢了
    note: task ? `已筛：任务 ${taskLabel}` : '',
    idOf: e => e.displayId,
    // 问题优先：这条决策当初在纠结什么，比结论更像标题
    titleOf: e => e.question || e.reason || e.real_question || e.answer || e.displayId,
    reviewable,
    approveRecord: () =>
      operation.action(API.approveDecision(id), {
        reviewer: reviewer.trim(),
        note: instruction.trim(),
      }),
    approve: () =>
      operation.action(API.resolveDecision(id), {
        reviewer: reviewer.trim(),
        note: instruction.trim(),
        outcome: 'approve',
      }),
    override: () =>
      operation.action(API.overrideDecision(id), {
        instruction: instruction.trim(),
        original_answer: typeof item.answer === 'string' ? item.answer : undefined,
      }),
  };
}
