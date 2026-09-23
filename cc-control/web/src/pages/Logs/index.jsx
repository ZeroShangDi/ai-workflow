import './styles.css';
import { SplitPane } from '@/shared/components/ui/index.js';
import { useLogsPage } from './hooks/useLogsPage.js';
import LogOutput from './components/Output/index.jsx';
import LogControls from './components/Controls/index.jsx';
export default function LogsPage(props) {
  const page = useLogsPage(props);
  return <SplitPane primary={<LogOutput {...page} />} detail={<LogControls {...page} />} />;
}
