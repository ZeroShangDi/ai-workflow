import { reviewResultMessage } from '../../../shared/components/business/ReviewRecord/model.js';
import { aggregateDecisions } from '../model.js';
import { useRecordSelection } from '../../../shared/hooks/useRecordSelection.js';
import { useAction } from '../../../shared/hooks/useAction.js';
import { API } from '../../../shared/api/index.js';
export function useDecisionsPage({ data, client, refresh }) {
  const entries = aggregateDecisions(data.decisions?.decisions || []);
  const selection = useRecordSelection(entries, e => e.key);
  const operation = useAction(client, refresh, reviewResultMessage);
  const { item, reviewer, instruction } = selection;
  const id = item?.id;
  const approvable =
    item?.subject?.capability === 'dynamic_planning' && item.status === 'awaiting_human';
  const ambiguousId = entries.filter(e => e.id === id).length > 1;
  const overrideable = !ambiguousId && item?.completed && item.status !== 'overridden';
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
    adoptable: item?.status === 'pending_review',
    adopt: () => operation.action(API.adoptDecision(id), {}),
    title: '决策记录',
    emptyLabel: '决策记录',
    idOf: e => e.id,
    titleOf: e => e.reason || e.real_question || e.answer || e.id,
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
