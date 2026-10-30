import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { applyTheme, readTheme } from './shared/theme/index.js';
import ErrorBoundary from './shared/components/ui/ErrorBoundary.jsx';
const SHOW_MOCK_CONTROLS = false; // Toggle only the bar; mock data remains available.
applyTheme(readTheme());
async function bootstrap() {
  let mock, PreviewControls;
  if (
    import.meta.env.DEV &&
    (import.meta.env.VITE_MOCK === 'true' ||
      new URLSearchParams(window.location.search).get('mock') === '1')
  ) {
    mock = (await import('../mock/browser.js')).startMock();
    PreviewControls = (await import('../mock/PreviewControls.jsx')).default;
    document.documentElement.dataset.preview = 'mock';
  }
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
        {SHOW_MOCK_CONTROLS && mock && <PreviewControls mock={mock} />}
      </ErrorBoundary>
    </StrictMode>,
  );
}
bootstrap();
