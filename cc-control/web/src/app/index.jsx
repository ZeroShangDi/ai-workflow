import '../shared/styles/index.css';
import { useAppShell } from './hooks/useAppShell.js';
import WorkspaceLayout from '../layouts/WorkspaceLayout/index.jsx';
import Workspace from './Workspace.jsx';
export default function App() {
  const shell = useAppShell();
  return (
    <WorkspaceLayout {...shell}>
      <Workspace
        key={shell.project || 'connecting'}
        project={shell.project}
        view={shell.view}
        runId={shell.runId}
        setRunId={shell.setRunId}
        setView={shell.setView}
        connectionError={shell.error}
      />
    </WorkspaceLayout>
  );
}
