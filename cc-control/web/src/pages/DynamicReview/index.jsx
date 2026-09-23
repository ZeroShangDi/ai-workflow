import { SplitPane } from '@/shared/components/ui/index.js';
import { useDynamicReviewPage } from './hooks/useDynamicReviewPage.js';
import ReviewRecordList from '@/shared/components/business/ReviewRecord/List.jsx';
import ReviewRecordDetail from '@/shared/components/business/ReviewRecord/Detail.jsx';
import Actions from './components/Actions/index.jsx';
export default function DynamicReviewPage(props) {
  const page = useDynamicReviewPage(props);
  return (
    <SplitPane
      primary={<ReviewRecordList {...page} />}
      detail={
        <ReviewRecordDetail {...page}>
          <Actions {...page} />
        </ReviewRecordDetail>
      }
    />
  );
}
