import './styles.css';
import { useRunPage } from './hooks/useRunPage.js';
import RunOutput from './components/Output/index.jsx';
import RunComposer from './components/Composer/index.jsx';
import RunOverview from '@/shared/components/business/Overview/index.jsx';
import { Button } from '@/shared/components/ui/index.js';
export default function RunPage(props) {
  const page = useRunPage(props);
  return (
    <div className="split-view run-view">
      <section className="primary-pane">
        <RunOutput {...page} />
        <RunComposer {...page} />
      </section>
      <aside className="detail-pane">
        {/* 决策的展示与复审都在决策页；这里只给计数与跳转 */}
        {page.decisionTotal > 0 && (
          <Button onClick={page.goDecisions}>
            本次 run 产生 {page.decisionTotal} 条决策，{page.pendingReview} 条待复审 ›
          </Button>
        )}
        <RunOverview {...page} />
      </aside>
    </div>
  );
}
