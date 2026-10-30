import { useState } from 'react';
import './preview.css';
import { THEMES, applyTheme, readTheme } from '@/shared/theme/index.js';
export default function PreviewControls({ mock }) {
  const [clockRunning, setClockRunning] = useState(true);
  const [expanded, setExpanded] = useState(window.innerWidth >= 1024);
  return (
    <aside className="preview-controls" aria-label="模拟预览控制">
      <button aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        MOCK · {expanded ? '收起' : '预览控制'}
      </button>
      {expanded && (
        <>
          <strong>数据仅保存在内存</strong>
          <select
            aria-label="模拟场景"
            defaultValue={mock.scenario}
            onChange={event => {
              const url = new URL(window.location.href);
              url.searchParams.set('scenario', event.target.value);
              url.searchParams.delete('p');
              url.searchParams.delete('runId');
              url.searchParams.set(
                'view',
                ['empty', 'directory', 'environment', 'requirement'].includes(event.target.value)
                  ? 'project'
                  : event.target.value.startsWith('plan')
                    ? 'plan'
                    : 'run',
              );
              window.location.assign(url);
            }}>
            {Object.entries({
              empty: '01 空工作空间',
              directory: '02 读取目录',
              environment: '03 环境就绪',
              requirement: '04 已新增需求',
              planning: '05 Plan 生成中',
              'plan-ready': '06 Plan 待确认',
              'plan-error': 'Plan 生成失败',
              idle: '07 待启动',
              queued: '排队中',
              demo: '08 正常运行',
              waiting: '09 等待选择',
              'waiting-text': '等待文本输入',
              blocked: '任务阻塞',
              failed: '运行失败',
              completed: '运行完成',
              cancelled: '运行取消',
              conflict: '审批冲突',
              error: '接口异常',
            }).map(([value, title]) => (
              <option key={value} value={value}>
                {title}
              </option>
            ))}
          </select>
          <select
            aria-label="预览主题"
            defaultValue={readTheme()}
            onChange={event => applyTheme(event.target.value)}>
            {Object.entries(THEMES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {mock.scenario === 'error' && <button onClick={mock.recover}>恢复接口</button>}
          <button onClick={mock.advance}>推进状态</button>
          <button onClick={() => setClockRunning(mock.toggleClock())}>
            {clockRunning ? '暂停自动推进' : '恢复自动推进'}
          </button>
          <button onClick={() => window.location.reload()}>重置</button>
        </>
      )}
    </aside>
  );
}
