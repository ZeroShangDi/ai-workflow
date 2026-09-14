import RunSelect from '../../../../shared/components/business/RunSelect/index.jsx';
import { display } from '../../../../shared/lib/format.js';
export default function RunOutput({
  data,
  output,
  setFollow,
  events,
  runId,
  ...selection
}) {
  return (<>    <header className="pane-header">
      <div className="run-identity">
        <span className="status-dot" />
        <h1>Run 对话</h1>
        <small>· 当前项目输出</small>
      </div>
      <RunSelect {...selection} />
    </header>
    <div className="output-area" ref={output} onScroll={e => {
      const node = e.currentTarget;
      setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 48);
    }}>
      <pre className="terminal">{data.status?.snapshot || '暂无会话输出，等待执行更新。'}</pre>
      <div className="event-tail">{events.filter(e => !runId || e.runId === runId).slice(-12).map(e => <div key={e.seq}>
          <span className="muted">{e.type}</span>{' '}
          {display(e.payload)}
        </div>)}</div>
    </div>
  </>);
}
