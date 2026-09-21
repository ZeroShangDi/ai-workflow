import './styles.css';
import { Button } from '../../shared/components/ui/index.js';
import Sidebar from './components/Sidebar.jsx';
import Topbar from './components/Topbar.jsx';
import ViewRail from './components/ViewRail.jsx';
export default function WorkspaceLayout({
  children,
  ...shell
}) {
  const showChrome = shell.context?.mode !== 'dsh';
  return (<div className="app-shell" style={showChrome ? undefined : { '--cc-layout-sidebar-width': '0px', '--cc-layout-topbar-height': '0px' }}>
    {showChrome && shell.open && <Button className="sidebar-backdrop" aria-label="关闭项目列表" onClick={() => shell.setOpen(false)} />}
    {showChrome && <Sidebar {...shell} />}
    {showChrome && <Topbar {...shell} />}
    <ViewRail {...shell} />
    {children}
  </div>);
}
