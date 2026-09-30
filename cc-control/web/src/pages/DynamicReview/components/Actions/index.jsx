import { Button, Input, Textarea } from '@/shared/components/ui/index.js';
/**
 * 动态任务复审的动作区 —— 与决策同一套逻辑：两个动作，不是一个状态一个按钮。
 *
 *   批准和应用 —— 认可这个方案，让它落到任务图（非自动模式）；自动模式下早已应用，这里是事后签收。
 *   提交其他方案 —— 方案本身要改，填内容后按新内容执行。
 *
 * 「重新校验提案 / 完成复审」并掉了：前者是执行侧的事（提案应用撞上变动属任务状态逻辑），
 * 后者就是「批准和应用」在自动模式下的说法，不该是第三个按钮。
 */
export default function DynamicReviewActions({
  actionable,
  busy,
  reviewer,
  setReviewer,
  instruction,
  setInstruction,
  approve,
  alternative,
}) {
  if (!actionable) return null;
  return (
    <div className="review-actions">
      {/* 复审人必填：服务端 approve / resolve 会校验非空（assertReviewer） */}
      <Input
        aria-label="复审人"
        placeholder="复审人姓名（必填）"
        value={reviewer}
        onChange={e => setReviewer(e.target.value)}
      />
      <Button className="primary" disabled={busy || !reviewer.trim()} onClick={approve}>
        批准和应用
      </Button>
      <Textarea
        aria-label="其他方案"
        placeholder="填写其他方案；提交时必填"
        value={instruction}
        onChange={e => setInstruction(e.target.value)}
      />
      <Button disabled={busy || !reviewer.trim() || !instruction.trim()} onClick={alternative}>
        提交其他方案
      </Button>
    </div>
  );
}
