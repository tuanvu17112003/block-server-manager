import { useState } from 'react';
import type { TabId } from '../types';
import { formatUptime, useStore } from '../store';
import { Button, Confirm, StatusDot } from './ui';

export const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'console', label: 'Console' },
  { id: 'content', label: 'Content' },
  { id: 'players', label: 'Players' },
  { id: 'worlds', label: 'Worlds' },
  { id: 'backups', label: 'Backups' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'settings', label: 'Settings' },
];

export function Sidebar({
  goCreate,
  createActive,
  onSelectServer,
  onOpenAppSettings,
  appSettingsActive,
}: {
  goCreate: () => void;
  createActive: boolean;
  onSelectServer: (serverId: string) => void;
  onOpenAppSettings: () => void;
  appSettingsActive: boolean;
}) {
  const { servers, activeId } = useStore();
  const [q, setQ] = useState('');
  const filtered = servers.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <aside className="mc-sidebar flex min-h-0 flex-col">
      <div className="p-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search servers…"
          className="mc-input w-full px-2.5 py-1.5 text-sm placeholder:text-zinc-600"
        />
        <button
          onClick={goCreate}
          disabled={createActive}
          className="mc-btn mc-btn-default mt-2 w-full justify-center"
        >
          + New Server
        </button>
      </div>
      <div className="thin-scroll flex-1 overflow-y-auto px-2 pb-2">
        {filtered.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelectServer(s.id)}
            className={`mc-server-row ${s.id === activeId ? 'mc-server-row-active' : ''}`}
          >
            <StatusDot status={s.status} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{s.name}</span>
              <span className="mc-server-sub block text-xs">
                {s.playersOnline}/{s.maxPlayers} · {s.version}
              </span>
            </span>
          </button>
        ))}
        {filtered.length === 0 && <p className="px-2 py-4 text-xs text-zinc-500">No servers match “{q}”.</p>}
      </div>
      <div className="border-t border-zinc-800 p-2">
        <button
          type="button"
          onClick={onOpenAppSettings}
          disabled={createActive}
          title="Global app settings (API key, download folder, diagnostics)"
          className={`mc-btn w-full justify-start text-left ${appSettingsActive ? 'mc-btn-default' : ''}`}
        >
          ⚙ App settings
        </button>
      </div>
    </aside>
  );
}

const READINESS_LABEL: Record<string, string> = {
  preparing: 'Preparing…',
  spawning: 'Spawning…',
  spawned: 'Starting…',
  retrying: 'Retrying boot…',
  ready: 'Ready',
  stopped: 'Stopped',
  failed: 'Start failed',
};

export function Header({ goConsole }: { goConsole: () => void }) {
  const { active, start, stop, restart, kill, pushToast, isBusy, startingPhase } = useStore();
  const [killOpen, setKillOpen] = useState(false);
  const [startingPulse, setStartingPulse] = useState(false);

  const doStart = () => {
    const ok = start(active.id);
    if (ok && active.status !== 'running') {
      // Attention pulse: on for 2s after Start so the user sees where to go next.
      setStartingPulse(true);
      window.setTimeout(() => setStartingPulse(false), 2000);
      goConsole();
    }
  };

  const copyIp = async () => {
    const text = `${active.address}:${active.port}`;
    try {
      await navigator.clipboard.writeText(text);
      pushToast(`Copied ${text}`, 'ok');
    } catch {
      pushToast(text, 'info');
    }
  };

  const running = active.status === 'running';
  const starting = active.status === 'starting';
  const busy = isBusy(active.id) || active.status === 'starting' || active.status === 'stopping';
  const phase = startingPhase && startingPhase.phase !== 'ready' && startingPhase.phase !== 'stopped'
    ? READINESS_LABEL[startingPhase.phase] ?? startingPhase.phase
    : null;

  return (
    <header className="mc-header flex flex-wrap items-center gap-2 px-4 py-2.5">
      <StatusDot status={active.status} size="h-2 w-2" />
      <h1 className="mc-header-title">{active.name}</h1>
      <span className="text-xs text-zinc-500">
        {active.version} · {active.playersOnline}/{active.maxPlayers} players · up {formatUptime(active.uptimeSec)}
      </span>
      {phase && (
        <span role="status" className="text-xs text-amber-300" title={startingPhase?.message ?? ''}>
          {phase}{startingPhase?.attempt && startingPhase.phase === 'retrying' ? ` #${startingPhase.attempt}` : ''}
          {startingPhase?.message && startingPhase.phase === 'failed' ? ` — ${startingPhase.message}` : ''}
        </span>
      )}
      {!active.eulaAccepted && <span className="mc-eula">EULA not accepted — Start blocked</span>}
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {!running ? (
          <Button
            size="sm"
            onClick={doStart}
            disabled={busy}
            pulse={startingPulse}
            title={active.eulaAccepted ? 'Start server' : 'Blocked: accept the Minecraft EULA first'}
          >
            {starting ? 'Starting…' : '▶ Start'}
          </Button>
        ) : (
          <>
            <Button size="sm" variant="secondary" onClick={() => stop(active.id)} disabled={busy}>⏹ Stop</Button>
            <Button size="sm" variant="secondary" onClick={() => restart(active.id)} disabled={busy}>↻ Restart</Button>
            <Button size="sm" variant="outline" onClick={() => setKillOpen(true)} title="Force-kill the process (asks for confirmation)">
              Kill
            </Button>
          </>
        )}
        {starting && (
          <Button size="sm" variant="secondary" onClick={() => stop(active.id)} title="Cancel the boot and stop the server">
            ⏹ Stop
          </Button>
        )}
        <button
          onClick={copyIp}
          title="Copy server address"
          className="mc-copy"
        >
          {active.address}:{active.port} ⧉
        </button>
      </div>
      <Confirm
        open={killOpen}
        title="Force-kill server process?"
        message={<p>Unsaved world data may be lost. Prefer Stop; use Kill only when the server is frozen.</p>}
        confirmLabel="Kill process"
        onConfirm={() => kill(active.id)}
        onClose={() => setKillOpen(false)}
      />
    </header>
  );
}

export function CreateHeader({ onCancel }: { onCancel: () => void }) {
  return (
    <header className="mc-header flex flex-wrap items-center gap-2 px-4 py-2.5">
      <h1 className="mc-header-title">Create Server</h1>
      <span className="text-xs text-zinc-500">New server setup — not tied to any existing server</span>
      <div className="ml-auto flex items-center gap-1.5">
        <Button size="sm" variant="ghost" onClick={onCancel} title="Back to previous server view">
          ← Back
        </Button>
      </div>
    </header>
  );
}

export function TabBar({ tab, setTab }: { tab: TabId; setTab: (t: TabId) => void }) {
  return (
    <nav className="mc-tabbar">
      {TABS.map((t) => (
        <button
          key={t.id}
          onClick={() => setTab(t.id)}
          className={`mc-tab ${tab === t.id ? 'mc-tab-active' : ''}`}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}

export function ToastHost() {
  const { toasts } = useStore();
  const color = { ok: 'mc-toast-ok', err: 'mc-toast-err', info: 'mc-toast-info' };
  return (
    <div role="status" aria-live="polite" aria-atomic="false" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} role={t.kind === 'err' ? 'alert' : 'status'} className={`mc-toast ${color[t.kind]}`}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}
