import './styles.css';
import { useRunPage } from './hooks/useRunPage.js';
import RunOutput from './components/Output/index.jsx';
import RunComposer from './components/Composer/index.jsx';
import RunOverview from '@/shared/components/business/Overview/index.jsx';
import { Button } from '@/shared/components/ui/index.js';
import { useEffect, useMemo, useState } from 'react';
import { createApiClient } from '@/shared/lib/http.js';
import { API } from '@/shared/api/index.js';

function RunBugSummary({ project, requirementId, setView }) {
  const client = useMemo(() => createApiClient({ project }), [project]);
  const [bugs, setBugs] = useState([]);
  useEffect(() => {
    if (!project || !requirementId) return;
    let active = true;
    const refresh = async () => {
      try {
        const result = await client.get(`${API.bugs}?requirementId=${encodeURIComponent(requirementId)}`);
        if (active && result.ok) setBugs(result.data || []);
      } catch { /* session remains usable if Bug API is unavailable */ }
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [client, project, requirementId]);
  return <Button className="run-decision-summary" onClick={() => setView('bugs', { requirementId })}>
    <span>当前需求 Bug</span><strong>{bugs.length}</strong>
    <span>待验收</span><strong>{bugs.filter(bug => bug.lifecycleStatus === 'pending_acceptance').length}</strong>
    <span className="run-decision-link">查看 ›</span>
  </Button>;
}
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
        <RunBugSummary project={props.project} requirementId={props.requirementId || props.data.workspace?.activeRequirement?.id} setView={props.setView} />
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
