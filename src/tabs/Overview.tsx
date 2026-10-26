import { useState } from 'react';
import type { TabId } from '../types';
import { formatUptime, useStore } from '../store';
import { Badge, Button, Card, CardTitle, Confirm, Empty, ProgressBar } from '../components/ui';
import { hasBackend, tauriServers } from '../tauri';

export default function Overview({ go, onCreate }: { go: (t: TabId) => void; onCreate: () => void }) {
  const { active, servers, logs, start, stop, restart, kill, pushToast, startingPhase } = useStore();
  const [killOpen, setKillOpen] = useState(false);
  const running = active.status === 'running';
  const busy = active.status === 'starting' || active.status === 'stopping';
  const phaseText = startingPhase?.message
    ?? (active.status === 'starting'
      ? (startingPhase ? `Starting (${startingPhase.phase})…` : 'Starting… waiting for the server to report Done().')
      : active.status === 'stopping'
        ? 'Stopping… waiting for the process to exit.'
        : '');
  const portClash = servers.find((server) => server.id !== active.id && server.port === active.port);
  const tail = (logs[active.id] ?? []).slice(-3);
  const ramGb = (active.ramMb / 1024).toFixed(active.ramMb % 1024 ? 1 : 0);
  const playersPct = active.maxPlayers > 0 ? Math.min(100, (active.playersOnline / active.maxPlayers) * 100) : 0;

  const openFolder = () => {
    if (!hasBackend()) {
      go('worlds');
      return;
    }
    void tauriServers.openFolder(active.id)
      .catch((err: unknown) => pushToast(err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : 'Could not open the server folder.', 'err'));
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

  if (servers.length === 0) {
    return (
      <Empty
        title="No servers yet."
        body="Create your first Minecraft server to see status, players, resource usage and the live log tail here."
        action={<Button onClick={onCreate}>+ Create server</Button>}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="mc-header-strip" />

      {(active.status === 'crashed' || !active.eulaAccepted || portClash !== undefined || busy) && (
        <div className="space-y-2" aria-live="polite">
          {active.status === 'crashed' && (
            <p role="alert" className="rounded-md border border-red-800 bg-red-950/60 px-3 py-2 text-sm">
              <span className="font-semibold text-red-300">Server crashed. </span>
              <span className="text-red-200/80">Check the Console tail below, then Start again. Consider raising RAM if OutOfMemoryError repeats.</span>
            </p>
          )}
          {!active.eulaAccepted && (
            <p role="alert" className="rounded-md border border-amber-800 bg-amber-950/60 px-3 py-2 text-sm text-amber-200">
              Start is blocked until the Minecraft EULA is accepted.{' '}
              <button className="underline" onClick={() => go('settings')}>Review EULA in Settings →</button>
            </p>
          )}
          {portClash && (
            <p role="alert" className="rounded-md border border-amber-800 bg-amber-950/60 px-3 py-2 text-sm text-amber-200">
              Port {active.port} is also assigned to “{portClash.name}”. Start fails closed on an occupied port — change one server’s port in Settings.
            </p>
          )}
          {busy && (
            <p role="status" className="rounded-md border border-amber-800 bg-amber-950/60 px-3 py-2 text-sm text-amber-200">
              {phaseText}
            </p>
          )}
        </div>
      )}

      <div className="mc-overview-summary-grid grid gap-3">
        <Card className="min-w-0">
          <CardTitle>Status</CardTitle>
          <p className="text-lg font-semibold capitalize">{active.status}</p>
          <p className="text-xs text-zinc-500">
            Uptime {formatUptime(active.uptimeSec)}
            {' · '}
            {running ? `TPS ${active.tps === null ? '—' : active.tps.toFixed(1)}` : 'TPS — start the server'}
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {!running && (
              <Button size="sm" disabled={busy} onClick={() => start(active.id)} title={active.eulaAccepted ? 'Start server' : 'Blocked: accept the Minecraft EULA first'}>▶ Start</Button>
            )}
            {running && <Button size="sm" variant="secondary" onClick={() => go('console')}>Open Console</Button>}
            <Button size="sm" variant="secondary" disabled={!running} onClick={() => stop(active.id)} title={running ? 'Graceful stop' : 'Stop needs a running server'}>⏹ Stop</Button>
            <Button size="sm" variant="secondary" disabled={!running} onClick={() => restart(active.id)} title={running ? 'Restart server' : 'Restart needs a running server'}>↻ Restart</Button>
            <Button size="sm" variant="outline" disabled={!running && !busy} onClick={() => setKillOpen(true)} title="Force-kill the process (asks for confirmation)">Kill</Button>
            <Button size="sm" variant="outline" onClick={copyIp} title="Copy server address">Copy IP</Button>
            <Button size="sm" variant="outline" onClick={onCreate}>+ New</Button>
          </div>
          <Confirm
            open={killOpen}
            title="Force-kill server process?"
            message={<p>Unsaved world data may be lost. Prefer Stop; use Kill only when the server is frozen.</p>}
            confirmLabel="Kill process"
            onConfirm={() => kill(active.id)}
            onClose={() => setKillOpen(false)}
          />
        </Card>

        <Card className="min-w-0">
          <CardTitle>Players {active.playersOnline}/{active.maxPlayers}</CardTitle>
          <div className="mb-1 flex justify-between text-xs text-zinc-500"><span>slots used</span><span>{Math.round(playersPct)}%</span></div>
          <ProgressBar value={playersPct} tone="bg-blue-500" />
          <p className="mt-2 text-xs text-zinc-500">{running ? 'Live count from the server list command.' : 'No live count while the server is stopped.'}</p>
          <div className="mt-3">
            <Button size="sm" variant="secondary" onClick={() => go('players')}>Manage players</Button>
          </div>
        </Card>

        <Card className="min-w-0">
          <CardTitle>
            CPU {Math.round(active.cpuPct)}% · RAM {Math.round(active.ramPct)}% <Badge tone="blue">{ramGb} GB</Badge>
          </CardTitle>
          <div className="mb-1 text-xs text-zinc-500" title="Percent of total CPU capacity, normalized by logical core count (Task Manager semantics)">CPU (total capacity)</div>
          <ProgressBar value={active.cpuPct} tone="bg-amber-500" />
          <div className="mb-1 mt-2 text-xs text-zinc-500">RAM vs -Xmx limit{active.memoryMb ? ` · ${active.memoryMb} MB working set` : ''}</div>
          <ProgressBar value={active.ramPct} />
          <div className="mt-3">
            <Button size="sm" variant="secondary" onClick={() => go('metrics')}>View metrics</Button>
          </div>
        </Card>
      </div>

      <div className="mc-overview-detail-grid grid gap-3">
        <Card className="min-w-0">
          <CardTitle>Server</CardTitle>
          <dl className="min-w-0 space-y-1 text-sm">
            <div className="flex min-w-0 flex-wrap justify-between gap-x-2"><dt className="text-zinc-500">Version / loader</dt><dd className="min-w-0 break-words text-right">{active.version}</dd></div>
            <div className="flex min-w-0 flex-wrap justify-between gap-x-2"><dt className="text-zinc-500">World</dt><dd className="min-w-0 break-words text-right">{active.worldName} ({active.worldSizeMb} MB)</dd></div>
            <div className="flex min-w-0 flex-wrap justify-between gap-x-2"><dt className="text-zinc-500">Address</dt><dd className="min-w-0 break-all text-right font-mono text-xs">{active.address}:{active.port}</dd></div>
            <div className="flex min-w-0 flex-wrap justify-between gap-x-2"><dt className="text-zinc-500">RAM</dt><dd className="min-w-0 text-right">{active.ramMb} MB {active.ramMb < active.ramRecommendedMb && <Badge tone="amber">below recommended</Badge>}</dd></div>
          </dl>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" onClick={openFolder}>Open Folder</Button>
            <Button size="sm" variant="outline" onClick={copyIp}>Copy IP</Button>
            <Button size="sm" variant="outline" onClick={() => go('settings')}>Settings</Button>
          </div>
        </Card>
        <Card className="min-w-0">
          <CardTitle>Log tail</CardTitle>
          {tail.length === 0 ? (
            <p className="text-xs text-zinc-500">{running ? 'Waiting for the first log lines…' : 'No log lines yet — start the server to stream output.'}</p>
          ) : (
            <pre className="mc-console overflow-x-auto p-2">
              {tail.map((l) => (
                <div key={l.id}><span className="text-zinc-600">{l.ts}</span> <span className={l.level === 'ERROR' ? 'text-red-400' : l.level === 'WARN' ? 'text-amber-400' : 'text-zinc-400'}>[{l.level}]</span> <span className="text-zinc-300">{l.msg}</span></div>
              ))}
            </pre>
          )}
          <div className="mt-2">
            <Button size="sm" variant="ghost" onClick={() => go('console')}>Full console →</Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
