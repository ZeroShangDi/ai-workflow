import './styles.css';
import { useRunPage } from './hooks/useRunPage.js';
import RunOutput from './components/Output/index.jsx';
import RunComposer from './components/Composer/index.jsx';
import RunOverview from '@/shared/components/business/Overview/index.jsx';
import { Button } from '@/shared/components/ui/index.js';
export default function RunPage(props) {
  const page = useRunPage(props);
  const isRunSession = page.workflowSession?.kind === 'run';
  return (
    <div className={`split-view run-view${isRunSession ? '' : ' conversation-only'}`}>
      <section className="primary-pane">
        <RunOutput {...page} />
        <RunComposer {...page} />
      </section>
      {isRunSession && <aside className="detail-pane">
        <RunOverview {...page} />
        {page.decisionTotal > 0 && (
          <Button className="run-decision-summary" onClick={page.goDecisions}>
            <span>决策</span><strong>{page.decisionTotal}</strong>
            <span>待复审</span><strong>{page.pendingReview}</strong>
            <span className="run-decision-link">查看 ›</span>
          </Button>
        )}
      </aside>}
    </div>
  );
}
