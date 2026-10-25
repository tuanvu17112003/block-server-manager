import type { TabId } from '../types';
import { formatUptime, useStore } from '../store';
import { Badge, Button, Card, CardTitle, ProgressBar } from '../components/ui';

export default function Overview({ go, onCreate }: { go: (t: TabId) => void; onCreate: () => void }) {
  const { active, logs, start, stop, restart } = useStore();
  const tail = (logs[active.id] ?? []).slice(-3);
  const ramGb = (active.ramMb / 1024).toFixed(active.ramMb % 1024 ? 1 : 0);

  if (active.status === 'crashed') {
    // crash banner stays visible until user acts
  }

  return (
    <div className="space-y-3">
      <div className="mc-header-strip" />
      {active.status === 'crashed' && (
        <div className="rounded-md border border-red-800 bg-red-950/60 px-3 py-2 text-sm">
          <span className="font-semibold text-red-300">Server crashed. </span>
          <span className="text-red-200/80">Check the Console tail below, then Start again. Consider raising RAM if OutOfMemoryError repeats.</span>
        </div>
      )}
      {!active.eulaAccepted && (
        <div className="rounded-md border border-amber-800 bg-amber-950/60 px-3 py-2 text-sm text-amber-200">
          Start is blocked until you accept the Minecraft EULA.{' '}
          <button className="underline" onClick={() => go('settings')}>Go to Settings →</button>
        </div>
      )}

      <div className="mc-overview-summary-grid grid gap-3">
        <Card className="min-w-0">
          <CardTitle>Status</CardTitle>
          <p className="text-lg font-semibold capitalize">{active.status}</p>
          <p className="text-xs text-zinc-500">Uptime {formatUptime(active.uptimeSec)} · TPS {active.tps ?? '— (needs RCON)'}</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {active.status !== 'running' ? (
              <Button size="sm" onClick={() => start(active.id)} title={active.eulaAccepted ? 'Start' : 'Blocked: accept EULA first'}>▶ Start</Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => go('console')}>Open Console</Button>
            )}
            <Button size="sm" variant="secondary" disabled={active.status !== 'running'} onClick={() => stop(active.id)} title="Stop server">⏹ Stop</Button>
            <Button size="sm" variant="secondary" disabled={active.status !== 'running'} onClick={() => restart(active.id)} title="Restart server">↻ Restart</Button>
            <Button size="sm" variant="outline" onClick={onCreate}>+ New</Button>
          </div>
        </Card>
        <Card className="min-w-0">
          <CardTitle>Players {active.playersOnline}/{active.maxPlayers}</CardTitle>
          <div className="mb-1 flex justify-between text-xs text-zinc-500"><span>slots used</span><span>{Math.round((active.playersOnline / active.maxPlayers) * 100)}%</span></div>
          <ProgressBar value={(active.playersOnline / active.maxPlayers) * 100} tone="bg-blue-500" />
          <div className="mt-3">
            <Button size="sm" variant="secondary" onClick={() => go('players')}>Manage players</Button>
          </div>
        </Card>
        <Card className="min-w-0">
          <CardTitle>
            CPU {Math.round(active.cpuPct)}% · RAM {Math.round(active.ramPct)}% <Badge tone="blue">{ramGb} GB</Badge>
          </CardTitle>
          <div className="mb-1 text-xs text-zinc-500">CPU</div>
          <ProgressBar value={active.cpuPct} tone="bg-amber-500" />
          <div className="mb-1 mt-2 text-xs text-zinc-500">RAM vs limit</div>
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
            <Button size="sm" variant="outline" onClick={() => go('worlds')}>Open Folder (mock)</Button>
            <Button size="sm" variant="outline" onClick={() => go('settings')}>Settings</Button>
          </div>
        </Card>
        <Card className="min-w-0">
          <CardTitle>Log tail</CardTitle>
          {tail.length === 0 ? (
            <p className="text-xs text-zinc-500">No log lines yet.</p>
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
