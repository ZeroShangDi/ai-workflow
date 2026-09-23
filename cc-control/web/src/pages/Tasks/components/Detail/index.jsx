import { useLayoutEffect, useRef, useState } from 'react';
import { API } from '@/shared/api/index.js';
import { EmptyState as Empty } from '@/shared/components/ui/index.js';
import { formatShortDateTime, label } from '@/shared/lib/format.js';
import { kindText, sourceOf, sourceShort } from '@/pages/Tasks/model.js';
import { execTime, resolveDeps, resolveWbs } from './model.js';
import ExecDialog from './dialogs.jsx';
import './styles.css';

const TABS = [
  { key: 'requirements', label: '任务要求' },
  { key: 'scope', label: '范围与依赖' },
  { key: 'output', label: '执行与产出' },
];

/** 截断后缀：既是显示内容，也是量尺要预留的宽度 */
const MORE = '… 更多';

/** 状态圆点 + 文案（无底色）。行内元信息的一部分，与列表里的 StatusBadge 形状不同、语义相同。 */
function StatusDot({ value }) {
  return (
    <span className={`task-meta-status status-${value}`}>
      <i className="task-meta-status-dot" aria-hidden="true" />
      {label(value)}
    </span>
  );
}

/**
 * 固定头部：标题 → 元信息 → 阻塞块。三个页签共用，切页签时不动。
 *
 * 阻塞块里的 `查看完整原因` 打开执行详情弹窗（头部只给两行预览）；
 * `解除阻塞 / 重试任务` 仍接既有的 taskAction —— 该端点在 server 上不存在
 * （`.awf/issues/018`），本次只做视图，行为保持原样。
 */
function Header({ task, action, busy, onOpenExec }) {
  const blocked = task.status === 'blocked';
  const reason = task.blockedReason || '';
  return (
    <header className="task-head">
      <h1 className="task-head-title">{task.title || task.name || task.id}</h1>
      <p className="task-meta">
        <span>{task.id}</span>
        <span className="task-meta-sep">/</span>
        <span>{kindText(task.kind)}</span>
        <span className="task-meta-sep">·</span>
        <StatusDot value={task.status} />
        <span className="task-meta-sep">·</span>
        {/* 用短标签（门禁派生 / 动态规划）：长标签会让这一行在 320px 面板下折成两行。
            原计划两者一致，设计稿那行不受影响。 */}
        <span>{sourceShort(sourceOf(task))}</span>
      </p>
      {(blocked || task.status === 'error') && (
        <div className="task-blocked">
          {reason && (
            // 标签与原因在同一个 <p> 里：设计稿里这两行紧挨着（行距 19），拆成两个块会被 gap 撑开
            <p className="task-blocked-text">
              <span className="task-blocked-label">
                <span aria-hidden="true">!</span> 阻塞原因
              </span>
              {reason}
            </p>
          )}
          <div className="task-blocked-actions">
            <button type="button" className="link-button task-link" onClick={onOpenExec}>
              查看完整原因 <span aria-hidden="true">↗</span>
            </button>
            <button
              type="button"
              className="link-button task-link"
              disabled={busy}
              onClick={() => action(API.taskAction(task.id, blocked ? 'unblock' : 'retry'), {})}>
              {blocked ? '解除阻塞' : '重试任务'} <span aria-hidden="true">→</span>
            </button>
          </div>
        </div>
      )}
    </header>
  );
}

/** 标题 + 可选计数 + 内容。三个页签里的每一块都用它，保证标题层级与间距一致。 */
function Section({ title, count, children }) {
  return (
    <section className="task-section">
      <h2 className="task-section-title">
        {title}
        {count != null && <span>{count}</span>}
      </h2>
      {children}
    </section>
  );
}

/**
 * 二分出「前 n 个字 + 后缀」刚好塞进 `lines` 行时的 n。
 * 拿一个同宽同字体的隐藏块当尺子，逐次改它的文本量高度 —— 不猜字数。
 */
function fitLength(probe, text, lines, lineHeight, suffix) {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    probe.textContent = text.slice(0, mid) + suffix;
    if (probe.scrollHeight <= lines * lineHeight + 1) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * 长文本预览：截断到 `lines` 行，末尾**行内**接一个「… 更多」。
 *
 * 为什么不用 CSS 的 `-webkit-line-clamp`：它只会把省略号画在文本被切断的地方，
 * 我那边再放一个「更多」，屏幕上就成了「两个省略号 + 一道空档」，很难看。
 * 自己截断则「… 更多」紧跟在最后一个字后面，跟设计稿一样。
 *
 * 截断点要**连同后缀一起**量：只按正文算「塞得进两行」，再接上「… 更多」就会溢出到第三行。
 *
 * 右侧面板可拖拽，同一个字符串在 320px 和 800px 下能塞下的字数不同，所以挂 ResizeObserver 重算。
 * 传 `\n` 就能换行 —— 文本走 `white-space: pre-line`。
 */
function Clamp({ text, lines = 2, onMore }) {
  const wrap = useRef(null);
  const probe = useRef(null);
  const [limit, setLimit] = useState(text.length);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const host = wrap.current;
    const ruler = probe.current;
    if (!host || !ruler) return undefined;
    const lineHeight = Number.parseFloat(window.getComputedStyle(ruler).lineHeight) || 19;
    const measure = () => {
      const width = host.clientWidth;
      if (!width) return;
      ruler.style.width = `${width}px`;
      setLimit(fitLength(ruler, text, lines, lineHeight, MORE));
    };
    measure();
    // 跟 SplitPane 同一个写法：带 window. 前缀，就不必为这一处去动 eslint 的全局白名单
    const observer = new window.ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [text, lines]);

  if (!text) return null;
  const truncated = limit < text.length;
  const collapsed = truncated && !expanded;
  return (
    <div className="task-clamp-wrap" ref={wrap}>
      <p className="task-clamp">
        {collapsed ? text.slice(0, limit) : text}
        {collapsed && (
          <>
            …{' '}
            <button
              type="button"
              className="link-button task-more"
              onClick={onMore || (() => setExpanded(true))}>
              更多
            </button>
          </>
        )}
        {expanded && onMore === undefined && (
          <>
            {' '}
            <button
              type="button"
              className="link-button task-more"
              onClick={() => setExpanded(false)}>
              收起
            </button>
          </>
        )}
      </p>
      {/* 量尺：同宽同字体，不参与渲染 */}
      <p className="task-clamp task-clamp-ruler" ref={probe} aria-hidden="true" />
    </div>
  );
}

/** 文件列表预览：显示前 `visible` 条，其余折成末尾一行「… 更多（N 个）」，按条数截断即可。 */
function FileList({ files = [], visible = 3, empty = '暂无文件' }) {
  const [expanded, setExpanded] = useState(false);
  if (!files.length) return <p className="muted">{empty}</p>;
  const shown = expanded ? files : files.slice(0, visible);
  const rest = files.length - shown.length;
  return (
    <div className="task-file-list">
      {shown.map((file, index) => (
        <p className="task-file" key={`${index}-${file}`}>
          {file}
        </p>
      ))}
      {rest > 0 && (
        <button
          type="button"
          className="link-button task-more is-block"
          onClick={() => setExpanded(true)}>
          … 更多（{rest} 个）
        </button>
      )}
    </div>
  );
}

/** 页签一 · 任务要求。提示词是这一页的主内容，**默认整段展开**、不截断；
 *  约束把序号折进正文（`01`/`02` 与正文同色），与完成条件一样按行截断。 */
function Requirements({ task }) {
  const constraints = task.constraints || [];
  return (
    <>
      <Section title="提示词">
        {task.prompt ? (
          <p className="task-clamp">{task.prompt}</p>
        ) : (
          <p className="muted">暂无提示词</p>
        )}
      </Section>
      <Section title="任务约束">
        {constraints.length ? (
          <Clamp
            text={constraints
              .map((item, i) => `${String(i + 1).padStart(2, '0')} ${item}`)
              .join('\n')}
          />
        ) : (
          <p className="muted">暂无约束</p>
        )}
      </Section>
      <Section title="完成条件">
        {task.acceptance ? <Clamp text={task.acceptance} /> : <p className="muted">暂无完成条件</p>}
      </Section>
    </>
  );
}

/**
 * 页签二 · 范围与依赖。
 *
 * 依赖行的颜色跟着**依赖任务自己的状态**走（复用既有 `.status-*`）：设计稿画的是一个已完成
 * 依赖所以呈现为成功色；未完成的依赖不能也涂绿。标记同理 —— `✓` 只给已完成，其余用 `·`。
 */
function Scope({ task, tasks, wbs }) {
  const deps = resolveDeps(task, tasks);
  const plan = resolveWbs(task, wbs);
  const files = task.plannedFiles || [];
  return (
    <>
      <Section title="计划产物" count={files.length}>
        <FileList files={files} empty="未声明计划产物" />
      </Section>
      {deps.length > 0 && (
        <Section title="关联依赖" count={deps.length}>
          {deps.map(dep => (
            <p className={`task-dep status-${dep.status}`} key={dep.id}>
              <span aria-hidden="true">{dep.status === 'done' ? '✓' : '·'}</span>
              <span className="task-dep-id">{dep.id}</span>
              {dep.title && <span className="task-dep-title">{dep.title}</span>}
              <span aria-hidden="true">→</span>
            </p>
          ))}
        </Section>
      )}
      {plan && (
        <Section title="关联规划">
          <p className="task-wbs">
            <span>{plan.id}</span>
            {plan.name && <span className="task-wbs-title">{plan.name}</span>}
            <span aria-hidden="true">↗</span>
          </p>
        </Section>
      )}
    </>
  );
}

/**
 * 页签三 · 执行与产出。执行结果的「更多」走**弹窗**而不是就地展开：
 * 全文与架构判断在一起，弹窗就是它完整的阅读面，就地展开反而看不到架构判断。
 */
function Output({ task, onOpenExec, onOpenJson }) {
  const exec = task.exec || {};
  const commits = task.commits || [];
  const files = exec.files || [];
  const time = execTime(task);
  const recheck = exec.recheck || 0;
  return (
    <>
      <Section title="执行结果">
        {exec.result ? (
          <Clamp text={exec.result} onMore={onOpenExec} />
        ) : (
          <p className="muted">暂无执行结果</p>
        )}
        {(time || recheck > 0) && (
          <p className="task-exec-meta">
            {time && <span>最近执行 {formatShortDateTime(time)}</span>}
            {time && recheck > 0 && <span className="task-meta-sep">·</span>}
            {recheck > 0 && <span>复检 {recheck} 次</span>}
          </p>
        )}
        <button type="button" className="link-button task-link" onClick={onOpenJson}>
          <span aria-hidden="true">{'{ }'}</span> exec <span className="task-meta-sep">·</span> 查看
          JSON
        </button>
      </Section>
      <Section title="实际产物" count={files.length}>
        <FileList files={files} empty="暂无产出文件" />
      </Section>
      <Section title="提交记录" count={commits.length}>
        {commits.length ? (
          <div className="task-commits">
            {commits.map((commit, index) => (
              <p className="task-commit" key={`${index}-${commit.hash}`}>
                <span className="task-commit-hash">{commit.hash}</span>
                <span className="task-commit-message">{commit.message}</span>
              </p>
            ))}
          </div>
        ) : (
          <p className="muted">暂无提交记录</p>
        )}
      </Section>
    </>
  );
}

/**
 * 任务详情：固定头部 + 三页签 + 阅读弹窗。
 *
 * 页签与弹窗状态住在这里。调用方按 task.id 给 key，换任务时整个组件重挂，
 * 页签自然回到「任务要求」、弹窗自动关闭 —— 不留上一条任务的阅读现场。
 */
export default function TaskDetail({ task, tasks, wbs, action, busy }) {
  const [tab, setTab] = useState('requirements');
  const [dialog, setDialog] = useState(null);
  if (!task) return <Empty>选择任务查看详情</Empty>;
  return (
    <div className="task-detail">
      <Header task={task} action={action} busy={busy} onOpenExec={() => setDialog('exec')} />
      <div className="task-tabs" role="tablist">
        {TABS.map(item => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={`link-button task-tab${tab === item.key ? ' is-active' : ''}`}
            onClick={() => setTab(item.key)}>
            {item.label}
          </button>
        ))}
      </div>
      {tab === 'requirements' && <Requirements task={task} />}
      {tab === 'scope' && <Scope task={task} tasks={tasks} wbs={wbs} />}
      {tab === 'output' && (
        <Output
          task={task}
          onOpenExec={() => setDialog('exec')}
          onOpenJson={() => setDialog('json')}
        />
      )}
      {dialog && (
        <ExecDialog
          task={task}
          view={dialog}
          onChange={setDialog}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
