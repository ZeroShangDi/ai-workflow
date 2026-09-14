import './styles.css';
import { useRunPage } from './hooks/useRunPage.js';
import RunOutput from './components/Output/index.jsx';
import RunComposer from './components/Composer/index.jsx';
import RunOverview from './components/Overview/index.jsx';
export default function RunPage(props) {
  const page = useRunPage(props);
  return (<div className="split-view run-view">
    <section className="primary-pane">
      <RunOutput {...page} />
      <RunComposer {...page} />
    </section>
    <RunOverview {...page} />
  </div>);
}
