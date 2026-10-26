import { useEffect, useState } from 'react';
import type { TabId } from './types';
import { StoreProvider, useStore } from './store';
import { hasBackend } from './tauri';
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

function Shell() {
  const [tab, setTab] = useState<TabId>('overview');
  const [creating, setCreating] = useState(false);
  const [createSession, setCreateSession] = useState(0);
  const [firstRunCreate, setFirstRunCreate] = useState(false);
  const [returnTab, setReturnTab] = useState<TabId>('overview');
  const { servers, serversHydrated, serversLoadError, reloadServers, select } = useStore();
  const freshEmptyBackend = hasBackend() && serversHydrated && servers.length === 0;
  const serverListFailed = hasBackend() && !serversHydrated && serversLoadError !== null;
  const loadingServers = hasBackend() && !serversHydrated && !serverListFailed;
  const showCreate = !loadingServers && !serverListFailed && (creating || firstRunCreate || freshEmptyBackend);

  useEffect(() => {
    if (freshEmptyBackend) setFirstRunCreate(true);
  }, [freshEmptyBackend]);

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
                <button type="button" onClick={reloadServers} className="mc-btn mc-btn-default mt-4">
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
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
