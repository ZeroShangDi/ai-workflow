import './styles.css';
import { useLogsPage } from './hooks/useLogsPage.js';
import LogOutput from './components/Output/index.jsx';
import LogControls from './components/Controls/index.jsx';
export default function LogsPage(props) {
  const page = useLogsPage(props);
  return (<div className="split-view">
    <section className="primary-pane">
      <LogOutput {...page} />
    </section>
    <aside className="detail-pane">
      <LogControls {...page} />
    </aside>
  </div>);
}
