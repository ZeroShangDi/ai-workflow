import { Button, Input, Textarea } from '@/shared/components/ui/index.js';
export default function DynamicReviewActions({
  approvable,
  recoverable,
  reviewable,
  busy,
  reviewer,
  setReviewer,
  instruction,
  setInstruction,
  approve,
  retry,
  review,
  alternative,
}) {
  if (!approvable && !recoverable && !reviewable) return null;
  return (
    <div className="review-actions">
      <Input
        aria-label="复审人"
        placeholder="复审人姓名（必填）"
        value={reviewer}
        onChange={e => setReviewer(e.target.value)}
      />
      <Textarea
        aria-label="复审说明"
        placeholder="复审说明；提交其他决策时必填"
        value={instruction}
        onChange={e => setInstruction(e.target.value)}
      />
      {approvable && (
        <>
          <Button className="primary" disabled={busy || !reviewer.trim()} onClick={approve}>
            批准并应用
          </Button>
          <Button disabled={busy || !reviewer.trim() || !instruction.trim()} onClick={alternative}>
            提交其他方案
          </Button>
        </>
      )}
      {recoverable && (
        <Button disabled={busy || !reviewer.trim()} onClick={retry}>
          重新校验提案
        </Button>
      )}
      {reviewable && (
        <Button disabled={busy || !reviewer.trim()} onClick={review}>
          完成复审
        </Button>
      )}
    </div>
  );
}
