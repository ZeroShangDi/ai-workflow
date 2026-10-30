import { useEffect, useRef, useState } from 'react';
import ProjectPicker from '@/shared/components/business/ProjectPicker.jsx';
import ProjectSessions from './ProjectSessions.jsx';
import { projectName as name } from '@/shared/lib/project.js';
import { Button } from '@/shared/components/ui/index.js';
export default function Sidebar({ open, setOpen, projects, project, workspace, workspaceError, refreshWorkspace, refreshProjects, setProject, setView, error, client }) {
  const sidebar = useRef(null);
  const [adding, setAdding] = useState(false);
  const [menuProject, setMenuProject] = useState(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const focusable = () =>
      [...sidebar.current.querySelectorAll('button:not(:disabled), a[href], input')].filter(
        node => node.getClientRects().length,
      );
    focusable()[0]?.focus();
    const trap = event => {
      if (event.key !== 'Tab') return;
      const nodes = focusable(),
        first = nodes[0],
        last = nodes.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first || !sidebar.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !sidebar.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => {
      document.removeEventListener('keydown', trap);
      previous?.focus();
    };
  }, [open]);
  return (
    <aside
      ref={sidebar}
      role={open ? 'dialog' : undefined}
      aria-modal={open || undefined}
      aria-label="项目列表"
      className={`sidebar ${open ? 'is-open' : ''}`}>
      <header className="brand">
        <span className="brand-logo">c</span>
        <span>cc-work</span>
        <button
          type="button"
          className="add-project-button"
          aria-label="添加项目"
          title="添加项目"
          onClick={() => {
            setOpen(false);
            setAdding(true);
          }}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3.5 6.5h6l2 2H20a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 20 18.5H4A1.5 1.5 0 0 1 2.5 17V8A1.5 1.5 0 0 1 4 6.5Z" />
            <path d="M15 11.5v5m-2.5-2.5h5" />
          </svg>
        </button>
        <Button className="mobile" onClick={() => setOpen(false)}>
          关闭
        </Button>
      </header>
      <div className="sidebar-content">
        <div className="project-directory-list" aria-label="项目目录">
        {projects.map(p => (
          <div className="project-directory-row" key={p.projectRoot}>
          <Button
            className={`project-item ${p.projectRoot === project ? 'selected' : ''}`}
            title={p.projectRoot}
            onClick={() => {
              setProject(p.projectRoot);
              setOpen(false);
            }}>
            <span>{name(p.projectRoot)}{p.projectRoot.includes('/.awf/worktrees/') && <small>独立工作区</small>}</span>
          </Button>
          <button type="button" className="project-more" aria-label={`${name(p.projectRoot)} 更多操作`} aria-expanded={menuProject === p.projectRoot} onClick={() => setMenuProject(menuProject === p.projectRoot ? null : p.projectRoot)}>⋯</button>
          {menuProject === p.projectRoot && <div className="project-menu" role="menu"><button type="button" role="menuitem" onClick={() => { setProject(p.projectRoot, 'requirements'); setMenuProject(null); setOpen(false); }}>项目管理</button></div>}
          </div>
        ))}
        {!projects.length && (
          <p className="muted">{error ? '等待连接 server' : '暂无项目，请添加工作目录'}</p>
        )}
        </div>
        <ProjectSessions project={project} workspace={workspace} workspaceError={workspaceError} refreshWorkspace={refreshWorkspace} setView={setView} />
      </div>
      <footer className="sidebar-footer">
        <p>本地工作空间</p>
      </footer>
      {adding && (
        <ProjectPicker
          client={client}
          onClose={() => setAdding(false)}
          onOpened={root => {
            refreshProjects?.();
            setProject(root, 'project');
            setAdding(false);
          }}
        />
      )}
    </aside>
  );
}
