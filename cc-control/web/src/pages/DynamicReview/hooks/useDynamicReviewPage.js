import { reviewResultMessage } from '../../../shared/components/business/ReviewRecord/model.js';
import { useRecordSelection } from '../../../shared/hooks/useRecordSelection.js';
import { useAction } from '../../../shared/hooks/useAction.js';
import { API } from '../../../shared/api/index.js';
export function useDynamicReviewPage({
  data,
  client,
  refresh
}) {
  const selection = useRecordSelection(data.proposals?.proposals || [], e => e.proposalId);
  const operation = useAction(client, refresh, reviewResultMessage);
  const {
    item,
    reviewer,
    instruction
  } = selection;
  const id = item?.proposalId;
  const approvable = item?.status === 'awaiting_approval' || item?.status === 'decision_required' && item.decision?.decisionId;
  return {
    ...selection,
    ...operation,
    id,
    approvable,
    title: '动态任务复审',
    emptyLabel: '动态任务提案',
    idOf: e => e.proposalId,
    titleOf: e => e.reason || e.proposalId,
    approve: () => {
      const viaDecision = item.status === 'decision_required';
      return operation.action(viaDecision ? API.resolveDecision(item.decision.decisionId) : API.approveProposal(id), {
        reviewer: reviewer.trim(),
        note: instruction.trim(),
        ...(viaDecision ? {
          outcome: 'approve'
        } : {})
      });
    }
  };
}
