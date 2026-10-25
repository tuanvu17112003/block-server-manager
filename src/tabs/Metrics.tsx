import { useState } from 'react';
import { metricsMock } from '../mocks/data';
import { useStore, formatUptime } from '../store';
import { Badge, Button, Card, CardTitle, Empty } from '../components/ui';

function Spark({ data, stroke, unit }: { data: number[]; stroke: string; unit: string }) {
  const w = 560;
  const h = 110;
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - 6 - (v / max) * (h - 16)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label={`graph ${unit}`}>
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="2" />
      <line x1="0" y1={h - 6} x2={w} y2={h - 6} stroke="#3f3f46" strokeWidth="1" />
    </svg>
  );
}

const RANGES = [{ k: '1h', n: 12 }, { k: '6h', n: 24 }, { k: '24h', n: 48 }, { k: '72h', n: 72 }] as const;

export default function Metrics() {
  const { active } = useStore();
  const [range, setRange] = useState<(typeof RANGES)[number]>(RANGES[2]);
  const running = active.status === 'running';

  if (!running) {
    return <Empty title="Metrics are empty while the server is stopped." body="Start the server to collect live CPU / RAM / player / TPS series. Shift-zoom and 72h retention land with the backend." />;
  }

  const slice = (a: number[]) => a.slice(-range.n);
  const needsRcon = active.tps === null;

  return (
    <div className="space-y-3">
      <div className="mc-header-strip" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          { l: 'CPU', v: `${Math.round(active.cpuPct)}%` },
          { l: 'RAM', v: `${Math.round(active.ramPct)}% of ${active.ramMb} MB` },
          { l: 'Players', v: `${active.playersOnline}/${active.maxPlayers}` },
          { l: 'Uptime', v: formatUptime(active.uptimeSec) },
          { l: 'TPS / MSPT', v: needsRcon ? '—' : `${active.tps?.toFixed(1)} / ${active.mspt?.toFixed(1)}` },
        ].map((s) => (
          <Card key={s.l}><p className="text-xs uppercase text-zinc-500">{s.l}</p><p className="text-lg font-semibold">{s.v}</p></Card>
        ))}
      </div>

      {needsRcon && (
        <p className="rounded border border-amber-800 bg-amber-950/50 px-3 py-2 text-xs text-amber-200">
          TPS/MSPT need RCON (127.0.0.1 only) — showing “—” until the backend connects. <span className="text-amber-200/70">Disk: 12.4 GB free (mock).</span>
        </p>
      )}

      <div className="flex gap-1.5">
        {RANGES.map((r) => (
          <button key={r.k} onClick={() => setRange(r)} className={`rounded px-2.5 py-1 text-xs ${range.k === r.k ? 'bg-emerald-700 text-white' : 'bg-zinc-800 text-zinc-300'}`}>{r.k}</button>
        ))}
        <span className="ml-2 self-center text-xs text-zinc-500">Shift-zoom on graphs arrives with the backend (mock note).</span>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Card><CardTitle>CPU % — {range.k}</CardTitle><Spark data={slice(metricsMock.cpu)} stroke="#f59e0b" unit="cpu" /></Card>
        <Card><CardTitle>RAM % of limit — {range.k}</CardTitle><Spark data={slice(metricsMock.ram)} stroke="#10b981" unit="ram" /></Card>
        <Card><CardTitle>Players online — {range.k}</CardTitle><Spark data={slice(metricsMock.players)} stroke="#60a5fa" unit="players" /></Card>
        <Card><CardTitle>TPS — {range.k}</CardTitle><Spark data={slice(metricsMock.tps)} stroke="#a78bfa" unit="tps" /></Card>
      </div>

      <Card>
        <div className="flex items-center gap-2">
          <CardTitle>Alert opt-in (deferred)</CardTitle><Badge>later</Badge>
        </div>
        <p className="text-xs text-zinc-500">Crash / offline / high-RAM alerts are deferred to the backend milestone. <Button size="sm" variant="ghost" onClick={() => undefined}>Notify me (mock)</Button></p>
      </Card>
    </div>
  );
}
