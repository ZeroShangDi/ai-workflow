import { Button, Input, Textarea } from '../../../../shared/components/ui/index.js';
export default function DynamicReviewActions({
  approvable,
  busy,
  reviewer,
  setReviewer,
  instruction,
  setInstruction,
  approve
}) {
  return (<> {approvable ? <div className="review-actions">
      {approvable && <Input aria-label="复审人" placeholder="复审人姓名（必填）" value={reviewer} onChange={e => setReviewer(e.target.value)} />}
      <Textarea aria-label="复审说明" placeholder={'复审说明（选填）'} value={instruction} onChange={e => setInstruction(e.target.value)} />
      {approvable && <Button className="primary" disabled={busy || !reviewer.trim()} onClick={approve}>批准并应用</Button>}
    </div> : null}</>);
}
