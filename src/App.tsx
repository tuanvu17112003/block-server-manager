import { Component, useEffect, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import type { TabId } from './types';
import { StoreProvider, useStore } from './store';
import { backendUnavailableReason, hasBackend } from './tauri';
import { CreateHeader, Header, Sidebar, TabBar, ToastHost } from './components/layout';
import Overview from './tabs/Overview';
import Create from './tabs/Create';
import ConsoleTab from './tabs/ConsoleTab';
import ContentTab from './tabs/Content';
import Players from './tabs/Players';
import Worlds from './tabs/Worlds';
import Backups from './tabs/Backups';
import Metrics from './tabs/Metrics';
import Settings from './tabs/Settings';

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Last line of defence: a renderer exception anywhere below this point (including a malformed
 * IPC payload) must show a recovery screen instead of unmounting the whole window silently.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the full stack in DevTools/logs for diagnosis; the user only sees the message.
    // eslint-disable-next-line no-console
    console.error('[renderer] unexpected render error', error, info.componentStack);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mc-app-shell flex h-screen min-h-0 min-w-0 w-full overflow-hidden">
        <div className="mc-app-main flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="mc-header flex flex-wrap items-center gap-2 px-4 py-2.5">
            <h1 className="mc-header-title">Unexpected interface error</h1>
          </header>
          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-zinc-950 p-4 thin-scroll">
            <div className="mc-empty" role="alert">
              <p className="text-sm font-medium text-red-300">This screen could not be rendered.</p>
              <p className="mt-1 max-w-lg text-xs text-zinc-500">
                Your servers and files were not changed by this error. Copy the details below if you need to report
                it, then reload the window to continue.
              </p>
              <pre className="mc-console log-scroll mt-3 max-h-60 w-full max-w-3xl overflow-auto p-2 text-left text-xs">
                {this.state.error.message || String(this.state.error)}
              </pre>
              <button type="button" onClick={this.handleReload} className="mc-btn mc-btn-default mt-4">
                Reload
              </button>
            </div>
          </main>
        </div>
      </div>
    );
  }
}

/**
 * Fail-closed screen for a desktop host without its preload bridge (F-11). Showing browser mock
 * servers here would make real actions look successful, so the shell refuses to mount instead.
 */
function BackendBridgeUnavailable({ reason }: { reason: string }) {
  const reload = (): void => window.location.reload();
  return (
    <div className="mc-app-shell flex h-screen min-h-0 min-w-0 w-full overflow-hidden">
      <div className="mc-app-main flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="mc-header flex flex-wrap items-center gap-2 px-4 py-2.5">
          <h1 className="mc-header-title">Backend bridge unavailable</h1>
        </header>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-zinc-950 p-4 thin-scroll">
          <div className="mc-empty" role="alert">
            <p className="text-sm font-medium text-red-300">This window cannot reach the server backend.</p>
            <p className="mt-2 max-w-2xl text-xs text-zinc-400">{reason}</p>
            <p className="mt-2 max-w-2xl text-xs text-zinc-500">
              Mock data is intentionally disabled in the desktop app: no servers, logs, or settings were loaded or changed.
            </p>
            <button type="button" onClick={reload} className="mc-btn mc-btn-default mt-4">
              Reload window
            </button>
          </div>
        </main>
        <footer className="mc-footer">
          NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.
        </footer>
      </div>
    </div>
  );
}

function Shell() {
  const [tab, setTab] = useState<TabId>('overview');
  const [creating, setCreating] = useState(false);
  const [createSession, setCreateSession] = useState(0);
  const [firstRunCreate, setFirstRunCreate] = useState(false);
  const [returnTab, setReturnTab] = useState<TabId>('overview');
  const { servers, serversHydrated, serversLoadError, retryServers, select } = useStore();
  const bridgeUnavailable = backendUnavailableReason();
  const backendReady = bridgeUnavailable === null;
  const freshEmptyBackend = backendReady && hasBackend() && serversHydrated && servers.length === 0;
  const serverListFailed = backendReady && hasBackend() && !serversHydrated && serversLoadError !== null;
  const loadingServers = backendReady && hasBackend() && !serversHydrated && !serverListFailed;
  const showCreate = !loadingServers && !serverListFailed && (creating || firstRunCreate || freshEmptyBackend);

  useEffect(() => {
    if (freshEmptyBackend) setFirstRunCreate(true);
  }, [freshEmptyBackend]);

  if (bridgeUnavailable !== null) {
    return <BackendBridgeUnavailable reason={bridgeUnavailable} />;
  }


  const openCreate = () => {
    if (showCreate) return;
    setReturnTab(tab);
    setCreateSession((session) => session + 1);
    setCreating(true);
  };
  const exitCreate = (next: TabId) => {
    setCreating(false);
    setFirstRunCreate(false);
    setTab(next);
  };
  const cancelCreate = () => {
    if (freshEmptyBackend) return;
    setCreating(false);
    setFirstRunCreate(false);
    setTab(returnTab);
  };
  const selectServerAndExit = (serverId: string) => {
    select(serverId);
    if (!showCreate) return;
    setCreating(false);
    setFirstRunCreate(false);
    setTab(returnTab);
  };

  return (
    <div className="mc-app-shell flex h-screen min-h-0 min-w-0 w-full overflow-hidden">
      <Sidebar goCreate={openCreate} createActive={showCreate} onSelectServer={selectServerAndExit} />
      <div className="mc-app-main flex min-h-0 min-w-0 flex-1 flex-col">
        {showCreate ? (
          <>
            <CreateHeader onCancel={cancelCreate} />
            <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-zinc-950 p-4 thin-scroll">
              <Create key={createSession} onExit={exitCreate} />
            </main>
          </>
        ) : loadingServers ? (
          <>
            <header className="mc-header flex flex-wrap items-center gap-2 px-4 py-2.5">
              <h1 className="mc-header-title">Loading servers</h1>
            </header>
            <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-zinc-950 p-4 thin-scroll">
              <p className="text-sm text-zinc-500">Loading saved servers…</p>
            </main>
          </>
        ) : serverListFailed ? (
          <>
            <header className="mc-header flex flex-wrap items-center gap-2 px-4 py-2.5">
              <h1 className="mc-header-title">Saved servers unavailable</h1>
            </header>
            <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-zinc-950 p-4 thin-scroll">
              <div className="mc-empty">
                <p role="alert" className="text-sm text-red-300">
                  Could not load saved servers: {serversLoadError ?? 'The server list is unavailable.'}
                </p>
                <button type="button" onClick={() => { void retryServers(); }} className="mc-btn mc-btn-default mt-4">
                  Retry
                </button>
              </div>
            </main>
          </>
        ) : (
          <>
            <Header goConsole={() => setTab('console')} />
            <TabBar tab={tab} setTab={setTab} />
            <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-zinc-950 p-4 thin-scroll">
              {tab === 'overview' && <Overview go={setTab} onCreate={openCreate} />}
              {tab === 'console' && <ConsoleTab />}
              {tab === 'content' && <ContentTab go={setTab} />}
              {tab === 'players' && <Players />}
              {tab === 'worlds' && <Worlds />}
              {tab === 'backups' && <Backups />}
              {tab === 'metrics' && <Metrics />}
              {tab === 'settings' && <Settings />}
            </main>
          </>
        )}
        <footer className="mc-footer">
          NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.
        </footer>
      </div>
      <ToastHost />
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <StoreProvider>
        <Shell />
      </StoreProvider>
    </ErrorBoundary>
  );
}
