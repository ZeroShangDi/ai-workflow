import { SplitPane } from '../../shared/components/ui/index.js';
import { useDecisionsPage } from './hooks/useDecisionsPage.js';
import ReviewRecordList from '../../shared/components/business/ReviewRecord/List.jsx';
import ReviewRecordDetail from '../../shared/components/business/ReviewRecord/Detail.jsx';
import Actions from './components/Actions/index.jsx';
export default function DecisionsPage(props) {
  const page = useDecisionsPage(props);
  return <SplitPane
    primary={<ReviewRecordList {...page} />}
    detail={<ReviewRecordDetail {...page}>
      <Actions {...page} />
    </ReviewRecordDetail>}
  />;
}
