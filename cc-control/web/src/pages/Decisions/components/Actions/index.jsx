import { Button, Input, Textarea } from '@/shared/components/ui/index.js';
export default function DecisionsActions({
  approvable,
  busy,
  reviewer,
  setReviewer,
  instruction,
  setInstruction,
  approve,
  alternative,
  reviewable,
  approveRecord,
  overrideable,
  override,
}) {
  return (
    <>
      {' '}
      {/* 决策复审（AI 自决 + 人工事后复审）：两个动作，要求不同 ——
          「采纳决策」认可 AI 的结论，一键、不填东西（动作叫采纳决策，状态落为「已采纳」）；
          「提交其他决策」是不同意，要填，那句会变成一个纠偏任务的执行说明。 */}
      {reviewable ? (
        <div className="review-actions">
          <Input
            aria-label="复审人"
            placeholder="复审人姓名（选填）"
            value={reviewer}
            onChange={e => setReviewer(e.target.value)}
          />
          <Button className="primary" disabled={busy} onClick={approveRecord}>
            采纳决策
          </Button>
        </div>
      ) : null}
      {overrideable ? (
        <div className="review-actions">
          <Textarea
            aria-label="复审说明"
            placeholder="填写其他决策，将追加纠偏任务…"
            value={instruction}
            onChange={e => setInstruction(e.target.value)}
          />
          <Button disabled={busy || !instruction.trim()} onClick={override}>
            提交其他决策
          </Button>
        </div>
      ) : null}
      {/* 动态规划提案的审批（同一页面壳里的另一条业务线） */}
      {approvable ? (
        <div className="review-actions">
          <Input
            aria-label="复审人"
            placeholder="复审人姓名（必填）"
            value={reviewer}
            onChange={e => setReviewer(e.target.value)}
          />
          <Textarea
            aria-label="复审说明"
            placeholder="复审说明（选填）"
            value={instruction}
            onChange={e => setInstruction(e.target.value)}
          />
          <Button className="primary" disabled={busy || !reviewer.trim()} onClick={approve}>
            批准并应用
          </Button>
          <Button disabled={busy || !reviewer.trim() || !instruction.trim()} onClick={alternative}>
            提交其他决策
          </Button>
        </div>
      ) : null}
    </>
  );
}
