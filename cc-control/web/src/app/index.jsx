import '@/shared/styles/index.css';
import { useAppShell } from './hooks/useAppShell.js';
import WorkspaceLayout from '@/layouts/WorkspaceLayout/index.jsx';
import Workspace from './Workspace.jsx';
export default function App() {
  const shell = useAppShell();
  return (
    <WorkspaceLayout {...shell}>
      <Workspace
        key={shell.project || 'connecting'}
        project={shell.project}
        workspace={shell.workspace}
        workspaceError={shell.workspaceError}
        refreshWorkspace={shell.refreshWorkspace}
        view={shell.view}
        runId={shell.runId}
        task={shell.task}
        requirementId={shell.requirementId}
        sessionId={shell.sessionId}
        setRunId={shell.setRunId}
        setView={shell.setView}
        setProject={shell.setProject}
        connectionError={shell.error}
      />
    </WorkspaceLayout>
  );
}
