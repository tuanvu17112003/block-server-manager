import { useCallback, useEffect, useMemo, useState } from 'react';
import { metricsMock } from '../mocks/data';
import { useStore, formatUptime } from '../store';
import { Badge, Button, Card, CardTitle, Empty } from '../components/ui';
import { hasBackend, tauriMetrics } from '../tauri';
import type { MetricsHistoryDto } from '../tauri';

function Spark({ data, stroke, unit }: { data: number[]; stroke: string; unit: string }) {
  const w = 560;
  const h = 110;
  const values = data.length > 0 ? data : [0];
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * w},${h - 6 - (v / max) * (h - 16)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label={`graph ${unit}`}>
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="2" />
      <line x1="0" y1={h - 6} x2={w} y2={h - 6} stroke="#3f3f46" strokeWidth="1" />
    </svg>
  );
}

const RANGES = [
  { k: '1h', n: 12, hours: 1 },
  { k: '6h', n: 24, hours: 6 },
  { k: '24h', n: 48, hours: 24 },
  { k: '72h', n: 72, hours: 72 },
] as const;

function gb(bytes: number): string {
  if (bytes <= 0) return '—';
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export default function Metrics() {
  const { active, pushToast } = useStore();
  const backend = hasBackend();
  const [range, setRange] = useState<(typeof RANGES)[number]>(RANGES[2]);
  const [history, setHistory] = useState<MetricsHistoryDto | null>(null);
  const [loading, setLoading] = useState(false);
  const running = active.status === 'running';

  const load = useCallback(async () => {
    if (!backend || !active.id) return;
    setLoading(true);
    try {
      setHistory(await tauriMetrics.get(active.id, range.hours));
    } catch (err) {
      const message = err && typeof err === 'object' && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'Could not read metrics history.';
      pushToast(message, 'err');
    } finally {
      setLoading(false);
    }
  }, [active.id, backend, pushToast, range.hours]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!backend || !running) return;
    const timer = window.setInterval(() => { void load(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [backend, load, running]);

  const series = useMemo(() => {
    if (!backend) {
      const slice = (a: number[]) => a.slice(-range.n);
      return {
        cpu: slice(metricsMock.cpu),
        ram: slice(metricsMock.ram),
        players: slice(metricsMock.players),
        tps: slice(metricsMock.tps),
      };
    }
    const samples = history?.samples ?? [];
    return {
      cpu: samples.map((s) => s.cpuPct ?? 0),
      ram: samples.map((s) => s.ramPct ?? 0),
      players: samples.map((s) => s.players ?? 0),
      tps: samples.map((s) => s.tps ?? 0),
    };
  }, [backend, history, range.n]);

  if (!running) {
    return <Empty title="Metrics are empty while the server is stopped." body="Start the server to collect live CPU / RAM / player / TPS series. History is kept for 7 days." />;
  }

  const needsRcon = active.tps === null;
  const disk = history?.disk;
  const memoryMb = active.memoryMb;

  return (
    <div className="space-y-3">
      <div className="mc-header-strip" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          { l: 'CPU', v: `${Math.round(active.cpuPct)}%` },
          { l: 'RAM', v: memoryMb ? `${memoryMb} MB · ${Math.round(active.ramPct)}% of ${active.ramMb} MB` : `${Math.round(active.ramPct)}% of ${active.ramMb} MB` },
          { l: 'Players', v: `${active.playersOnline}/${active.maxPlayers}` },
          { l: 'Uptime', v: formatUptime(active.uptimeSec) },
          { l: 'TPS / MSPT', v: needsRcon ? '—' : `${active.tps?.toFixed(1)} / ${active.mspt?.toFixed(1)}` },
        ].map((s) => (
          <Card key={s.l}><p className="text-xs uppercase text-zinc-500">{s.l}</p><p className="text-lg font-semibold">{s.v}</p></Card>
        ))}
      </div>

      {needsRcon && (
        <p className="rounded border border-amber-800 bg-amber-950/50 px-3 py-2 text-xs text-amber-200">
          TPS/MSPT need RCON (127.0.0.1 only) — showing “—” until the backend connects.
          <span className="ml-1 text-amber-200/70">Disk: {disk ? `${gb(disk.freeBytes)} free of ${gb(disk.totalBytes)}` : '—'}.</span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {RANGES.map((r) => (
          <button key={r.k} onClick={() => setRange(r)} className={`rounded px-2.5 py-1 text-xs ${range.k === r.k ? 'bg-emerald-700 text-white' : 'bg-zinc-800 text-zinc-300'}`}>{r.k}</button>
        ))}
        <span className="ml-2 self-center text-xs text-zinc-500">
          {loading ? 'Refreshing history…' : backend ? `1-minute samples · ${history?.samples.length ?? 0} points · 7-day retention` : 'Shift-zoom on graphs arrives with the backend (mock note).'}
        </span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void load()} disabled={loading}>↻ Refresh</Button>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Card><CardTitle>CPU % — {range.k}</CardTitle><Spark data={series.cpu} stroke="#f59e0b" unit="cpu" /></Card>
        <Card><CardTitle>RAM % of limit — {range.k}</CardTitle><Spark data={series.ram} stroke="#10b981" unit="ram" /></Card>
        <Card><CardTitle>Players online — {range.k}</CardTitle><Spark data={series.players} stroke="#60a5fa" unit="players" /></Card>
        <Card><CardTitle>TPS — {range.k}</CardTitle><Spark data={series.tps} stroke="#a78bfa" unit="tps" /></Card>
      </div>

      <Card>
        <div className="flex items-center gap-2">
          <CardTitle>Alert opt-in (deferred)</CardTitle><Badge>later</Badge>
        </div>
        <p className="text-xs text-zinc-500">Crash / offline / high-RAM alerts are deferred to the notification milestone. <Button size="sm" variant="ghost" onClick={() => undefined}>Notify me (mock)</Button></p>
      </Card>
    </div>
  );
}
