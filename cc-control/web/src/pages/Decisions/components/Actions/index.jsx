import { Button, Input, Textarea } from '../../../../shared/components/ui/index.js';
export default function DecisionsActions({
  approvable,
  busy,
  reviewer,
  setReviewer,
  instruction,
  setInstruction,
  approve,
  overrideable,
  override
}) {
  return (<> {approvable || overrideable ? <div className="review-actions">
      {approvable && <Input aria-label="复审人" placeholder="复审人姓名（必填）" value={reviewer} onChange={e => setReviewer(e.target.value)} />}
      <Textarea aria-label="复审说明" placeholder={overrideable ? '填写其他决策，将追加纠偏任务…' : '复审说明（选填）'} value={instruction} onChange={e => setInstruction(e.target.value)} />
      {approvable && <Button className="primary" disabled={busy || !reviewer.trim()} onClick={approve}>批准并应用</Button>}
      {overrideable && <Button disabled={busy || !instruction.trim()} onClick={override}>提交其他决策</Button>}
    </div> : null}</>);
}
