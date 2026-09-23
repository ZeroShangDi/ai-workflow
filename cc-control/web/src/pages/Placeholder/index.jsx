/**
 * 三个 CLI 入口页的占位实现（U4）。
 *
 * 为什么是占位而不是完整业务 UI：`awf open dashboard|tree|ui` 是对外承诺的三个页面入口，
 * 之前它们落到 `/dashboard` `/tree` `/ui` 后**静默回退到第一页（项目）** —— 用户以为打开了
 * 新页面，其实看到的是别处的界面。这个页面把「入口已接通 / 内容待逐页指导」如实说明，
 * 并保留必要入口（项目切换在左侧栏、真实业务页在导航里），**不冒充完整业务 UI**。
 */
const LINKS = [
  ['run', 'Run · 运行'],
  ['tasks', '任务'],
  ['decisions', '决策'],
  ['logs', '日志'],
];

export default function PlaceholderPage({ project, route, setView }) {
  return (
    <div className="workflow-page">
      <header>
        <small>{project || '未选择项目'}</small>
        <h1>{route?.label || '占位页'} · 空页面</h1>
        <p className="muted">
          这个页面是接入要求里先建的<strong>空页面</strong>：入口已接通、数据与动作仍由 AWF 的 API
          提供， 完整业务 UI 待逐页指导后实现。
        </p>
      </header>
      <section>
        <h3>当前状态</h3>
        <p role="status">
          {project
            ? `已选择项目：${project}`
            : '还没有选择项目 —— 用左侧栏底部的「添加项目」选择工作目录后再看本项目的数据。'}
        </p>
        <p className="muted">后台业务能力已在位，可直接在下列页面查看。</p>
      </section>
      <section>
        <h3>去别处</h3>
        <div className="actions">
          {LINKS.map(([key, label]) => (
            <button key={key} type="button" onClick={() => setView?.(key)}>
              {label}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
