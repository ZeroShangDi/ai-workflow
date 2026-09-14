import './styles.css';
import { Button } from '../../shared/components/ui/index.js';
import Sidebar from './components/Sidebar.jsx';
import Topbar from './components/Topbar.jsx';
import ViewRail from './components/ViewRail.jsx';
export default function WorkspaceLayout({
  children,
  ...shell
}) {
  return (<div className="app-shell">
    {shell.open && <Button className="sidebar-backdrop" aria-label="关闭项目列表" onClick={() => shell.setOpen(false)} />}
    <Sidebar {...shell} />
    <Topbar {...shell} />
    <ViewRail {...shell} />
    {children}
  </div>);
}
