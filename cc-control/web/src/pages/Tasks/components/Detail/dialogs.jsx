import { useState } from 'react';
import JsonView from 'react18-json-view';
import 'react18-json-view/src/style.css';
import Modal from '@/shared/components/ui/Modal/index.jsx';
import { formatDateTime, label } from '@/shared/lib/format.js';
import { archRows, execTime } from './model.js';

/** 「复制全文」「折叠全部」「复制 JSON」在 server 侧都没有对应能力，本次只做视图 —— 按设计示意渲染成文字。 */
const DESIGN_ONLY = '设计示意，本次未接行为';

const Tool = ({ children }) => (
  <span className="modal-tool" title={DESIGN_ONLY}>
    {children}
  </span>
);

/** 弹窗一 · 执行详情：执行结果全文 + 阻塞原因 + 架构判断。头部的「查看完整原因」落到这里。 */
function ExecDetail({ task, onOpenJson, onClose }) {
  const exec = task.exec || {};
  const rows = archRows(exec.architecture);
  const time = execTime(task);
  const recheck = exec.recheck || 0;
  return (
    <Modal
      title="执行详情"
      width="800px"
      onClose={onClose}
      subtitle={`${task.id}  ·  ${task.title || task.name || ''}`}>
      <p className={`modal-status status-${task.status}`}>
        <span>{label(task.status)}</span>
        {time && (
          <>
            <span className="task-meta-sep">·</span>
            <span>最近执行 {formatDateTime(time)}</span>
          </>
        )}
        {recheck > 0 && (
          <>
            <span className="task-meta-sep">·</span>
            <span>复检 {recheck} 次</span>
          </>
        )}
      </p>
      <section className="modal-section">
        <h3 className="modal-section-title">
          <span>执行结果</span>
          <Tool>复制全文</Tool>
        </h3>
        {exec.result ? (
          <p className="modal-text">{exec.result}</p>
        ) : (
          <p className="muted">暂无执行结果</p>
        )}
      </section>
      {task.blockedReason && (
        <section className="modal-section">
          <h3 className="modal-section-title">
            <span>阻塞原因</span>
          </h3>
          <p className="modal-text">{task.blockedReason}</p>
        </section>
      )}
      {rows.length > 0 && (
        <section className="modal-section">
          <h3 className="modal-section-title">
            <span>架构判断</span>
          </h3>
          <dl className="modal-arch">
            {rows.map(row => (
              <div className="modal-arch-row" key={row.key}>
                <dt>{row.title}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <button type="button" className="link-button task-link" onClick={onOpenJson}>
        查看原始 JSON <span aria-hidden="true">↗</span>
      </button>
    </Modal>
  );
}

/**
 * 弹窗二 · exec JSON。
 *
 * 用现成的 JSON 组件（`react18-json-view`）而不是自己渲染行号和着色：
 * 它理解 JSON 结构 —— 逐节点折叠、类型着色、数组下标、悬停复制，自己写一遍不值当。
 *
 * 颜色没有跟着它的主题走：它把每个色位暴露成 CSS 变量，我在 styles.css 里直接映射到
 * cc-work 的设计 token，深浅色自动跟随。
 *
 * 要留意的取舍：它是**树形**视图（缩进 + 折叠三角 + 下标），不是设计稿画的
 * 「行号 + 原文缩进」那种代码视图 —— 这一屏的形态随这次替换变了。
 */
function ExecJson({ task, onClose }) {
  const exec = task.exec || {};
  const [collapsed, setCollapsed] = useState(false);
  return (
    <Modal
      title="执行数据 · exec"
      width="880px"
      onClose={onClose}
      subtitle={`${task.id}   /   Object · ${Object.keys(exec).length} 个字段`}
      toolbar={
        <>
          <button
            type="button"
            className="link-button modal-tool"
            onClick={() => setCollapsed(current => !current)}>
            {collapsed ? '展开全部' : '折叠全部'}
          </button>
          <Tool>复制 JSON</Tool>
        </>
      }
      note="只读数据  ·  长内容在弹窗内滚动，复制保留完整 JSON">
      <div className="json-viewer">
        {/* `collapsed` 只在挂载时生效，换 key 让它按新值重新挂一次 */}
        <JsonView
          key={collapsed ? 'collapsed' : 'expanded'}
          src={exec}
          collapsed={collapsed}
          matchesURL={false}
        />
      </div>
    </Modal>
  );
}

/** 两个弹窗都是「长内容的阅读面」，只是读的东西不同；切换靠 view，关闭统一走 onClose。 */
export default function TaskDialog({ task, view, onChange, onClose }) {
  return view === 'json' ? (
    <ExecJson task={task} onClose={onClose} />
  ) : (
    <ExecDetail task={task} onClose={onClose} onOpenJson={() => onChange('json')} />
  );
}
