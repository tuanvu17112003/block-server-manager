import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/press-start-2p';
import App from './App';
import './index.css';
import { initializeBackendConfig } from './backend/config';

/**
 * In Electron the preload bridge is the only backend. If it is missing we must NOT silently fall
 * back to browser mocks (F-11) — show a hard diagnostic instead so users never edit fake data.
 */
function detectBridgeFailure(): string | null {
  const electronShell = typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron');
  if (electronShell && window.electronAPI === undefined) {
    return 'The Electron preload bridge (window.electronAPI) is unavailable. The backend cannot be reached, so the app will not start in mock mode.';
  }
  return null;
}

function renderFatal(message: string): void {
  const root = document.getElementById('root');
  if (!root) return;
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-6">
        <div className="w-full max-w-xl rounded-lg border border-red-900 bg-red-950/40 p-6 text-zinc-100">
          <h1 className="text-lg font-semibold text-red-200">Backend bridge unavailable</h1>
          <p role="alert" className="mt-3 text-sm text-red-100">{message}</p>
          <p className="mt-3 text-xs text-zinc-400">
            This usually means the preload script failed to load. Reinstalling/restarting the app is the
            first step; report this message with the app version if it persists.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mc-btn mc-btn-default mt-4"
          >
            Reload
          </button>
        </div>
      </div>
    </React.StrictMode>,
  );
}

async function bootstrap() {
  const bridgeFailure = detectBridgeFailure();
  if (bridgeFailure !== null) {
    renderFatal(bridgeFailure);
    return;
  }
  await initializeBackendConfig();
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
