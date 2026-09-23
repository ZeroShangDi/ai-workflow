import { projectName as name } from '../../../shared/lib/project.js';
import { Button } from '../../../shared/components/ui/index.js';
export default function Topbar({ open, setOpen, project, view, views }) {
  return (
    <header className="topbar">
      <Button className="mobile" aria-expanded={open} onClick={() => setOpen(!open)}>
        项目
      </Button>
      <span title={project}>{name(project)}</span>
      <span className="muted">/</span>
      <b>{views.find(v => v.key === view)?.label || view}</b>
    </header>
  );
}
