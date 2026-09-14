import { useDynamicReviewPage } from './hooks/useDynamicReviewPage.js';
import ReviewRecordList from '../../shared/components/business/ReviewRecord/List.jsx';
import ReviewRecordDetail from '../../shared/components/business/ReviewRecord/Detail.jsx';
import Actions from './components/Actions/index.jsx';
export default function DynamicReviewPage(props) {
  const page = useDynamicReviewPage(props);
  return (<div className="split-view">
    <section className="primary-pane">
      <ReviewRecordList {...page} />
    </section>
    <aside className="detail-pane">
      <ReviewRecordDetail {...page}>
        <Actions {...page} />
      </ReviewRecordDetail>
    </aside>
  </div>);
}
