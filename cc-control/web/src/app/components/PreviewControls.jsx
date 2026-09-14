import { useState } from 'react';
import './preview.css';
import { THEMES, applyTheme, readTheme } from '../../shared/theme/index.js';
export default function PreviewControls({ mock }) {
  const [expanded, setExpanded] = useState(window.innerWidth >= 1024);
  return <aside className="preview-controls" aria-label="模拟预览控制">
    <button aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>MOCK · {expanded ? '收起' : '预览控制'}</button>
    {expanded && <><strong>数据仅保存在内存</strong>
    <select aria-label="模拟场景" defaultValue={mock.scenario} onChange={event => { const url = new URL(window.location.href); url.searchParams.set('scenario', event.target.value); window.location.assign(url); }}>
      {Object.entries({ demo: '正常运行', idle: '待启动', empty: '空数据', waiting: '等待输入', conflict: '审批冲突', error: '接口异常' }).map(([value, title]) => <option key={value} value={value}>{title}</option>)}
    </select>
    <select aria-label="预览主题" defaultValue={readTheme()} onChange={event => applyTheme(event.target.value)}>{Object.entries(THEMES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
    <button onClick={mock.advance}>推进状态</button><button onClick={() => window.location.reload()}>重置</button>
  </>}</aside>;
}
