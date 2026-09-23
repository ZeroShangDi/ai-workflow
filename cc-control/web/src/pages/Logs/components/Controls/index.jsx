import { Button, Input } from '@/shared/components/ui/index.js';
export default function LogControls({ source, search, setSearch, setSource, filtered }) {
  return (
    <>
      <h1>日志控制</h1>
      {
        <Input
          aria-label="搜索日志"
          placeholder="搜索事件、任务…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      }
      <h3>输出源</h3>
      <Button
        className={`stream-option ${source === 'run' ? 'selected' : ''}`}
        onClick={() => setSource('run')}>
        Run 编排事件
        <small>{filtered.length}</small>
      </Button>
      <Button
        className={`stream-option ${source === 'session' ? 'selected' : ''}`}
        onClick={() => setSource('session')}>
        当前会话输出
      </Button>
      <p className="muted">随执行更新</p>
    </>
  );
}
