import { reviewResultMessage } from '@/shared/components/business/ReviewRecord/model.js';
import { useRecordSelection } from '@/shared/hooks/useRecordSelection.js';
import { useAction } from '@/shared/hooks/useAction.js';
import { API } from '@/shared/api/index.js';
import { isActionable } from '@/pages/DynamicReview/model.js';
export function useDynamicReviewPage({ data, client, refresh }) {
  const selection = useRecordSelection(data.proposals?.proposals || [], e => e.proposalId);
  const operation = useAction(client, refresh, reviewResultMessage);
  const { item, reviewer, instruction } = selection;
  const id = item?.proposalId;
  return {
    ...selection,
    ...operation,
    id,
    // 只有「等待人工 / 待复审」才出两个动作；已采纳是终态
    actionable: isActionable(item?.status),
    alternative: () =>
      operation.action(API.proposalAction(id, 'alternative'), { reviewer, instruction }),
    title: '动态任务复审',
    emptyLabel: '动态任务提案',
    idOf: e => e.proposalId,
    titleOf: e => e.reason || e.proposalId,
    // 批准：高风险提案走它自己那条决策（决策内核判过再执行），其余直接批准应用。
    // 自动模式下服务端只改审查状态（事后签收），不重放任务图。
    approve: () => {
      const viaDecision = !!item.decision?.decisionId;
      return operation.action(
        viaDecision ? API.resolveDecision(item.decision.decisionId) : API.approveProposal(id),
        {
          reviewer: reviewer.trim(),
          note: instruction.trim(),
          ...(viaDecision ? { outcome: 'approve' } : {}),
        },
      );
    },
  };
}
