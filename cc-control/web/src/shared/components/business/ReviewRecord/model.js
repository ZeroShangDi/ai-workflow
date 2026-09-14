export const reviewResultMessage = result => result.proposal?.status === 'conflicted' ? '审批已记录，但变更冲突，未应用。' : '操作已提交';
