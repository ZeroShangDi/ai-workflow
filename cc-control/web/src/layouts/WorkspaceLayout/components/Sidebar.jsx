import { useEffect, useRef } from 'react';
import { projectName as name } from '../../../shared/lib/project.js';
import { Button } from '../../../shared/components/ui/index.js';
export default function Sidebar({
  open,
  setOpen,
  projects,
  project,
  setProject,
  error
}) {
  const sidebar = useRef(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const focusable = () => [...sidebar.current.querySelectorAll('button:not(:disabled), a[href], input')].filter(node => node.getClientRects().length);
    focusable()[0]?.focus();
    const trap = event => {
      if (event.key !== 'Tab') return;
      const nodes = focusable(), first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && (document.activeElement === first || !sidebar.current.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !sidebar.current.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); previous?.focus(); };
  }, [open]);
  return (<aside ref={sidebar} role={open ? 'dialog' : undefined} aria-modal={open || undefined} aria-label="项目列表" className={`sidebar ${open ? 'is-open' : ''}`}>
    <header className="brand">
      <span className="brand-logo">c</span>
      <span>cc-work</span>
      <Button className="mobile" onClick={() => setOpen(false)}>关闭</Button>
    </header>
    <div className="sidebar-content">{projects.map(p => <Button className={`project-item ${p.projectRoot === project ? 'selected' : ''}`} key={p.projectRoot} title={p.projectRoot} onClick={() => {
        setProject(p.projectRoot);
        setOpen(false);
      }}>
        <span className="project-mark">⌄</span>
        <span>{name(p.projectRoot)}</span>
      </Button>)}{!projects.length && <p className="muted">{error ? '等待连接 server' : '正在读取项目…'}</p>}</div>
    <footer className="sidebar-footer">本地工作空间</footer>
  </aside>);
}
