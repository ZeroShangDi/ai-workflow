import { Button } from '@/shared/components/ui/index.js';
import RunSelect from '@/shared/components/business/RunSelect/index.jsx';
export default function LogOutput({
  source,
  follow,
  setFollow,
  setCleared,
  runId,
  events,
  output,
  text,
  ...selection
}) {
  return (
    <>
      <header className="pane-header">
        {/* 标题 + 灰色描述同行（与任务页 .pane-title 一致），不再上下排布 */}
        <h1 className="pane-title">
          {source === 'run' ? 'Run 日志' : '当前会话输出'}
          <span className="pane-summary">
            · {source === 'run' ? 'Run 编排事件' : '当前项目 · 会话抓屏'}
          </span>
        </h1>
        <RunSelect {...selection} />
      </header>
      <div className="toolbar">
        <Button aria-pressed={follow} onClick={() => setFollow(!follow)}>
          {follow ? '自动跟随：开' : '自动跟随：关'}
        </Button>
        {source === 'run' && (
          <Button
            onClick={() =>
              setCleared(old => ({
                ...old,
                [runId]: events.at(-1)?.seq || 0,
              }))
            }>
            清屏
          </Button>
        )}
      </div>
      <pre ref={output} className="terminal log-output">
        {text || '暂无输出'}
      </pre>
    </>
  );
}
