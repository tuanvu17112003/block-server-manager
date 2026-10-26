import { useCallback, useEffect, useState } from 'react';
import { initialBackups } from '../mocks/data';
import type { Backup } from '../types';
import { useStore } from '../store';
import { Badge, Button, Card, Confirm, Field, Modal, ProgressBar, inputCls } from '../components/ui';
import { hasBackend, onJobProgress, tauriBackups } from '../tauri';
import type { BackupDto, BackupScheduleDto } from '../tauri';

function errorText(error: unknown, fallback: string): string {
  return error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : fallback;
}

function mbLabel(bytes: number): string {
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function fromDto(dto: BackupDto): Backup {
  return {
    id: dto.id,
    name: dto.name,
    created: dto.createdAt.slice(0, 16).replace('T', ' '),
    sizeMb: Math.round(dto.bytes / 1024 ** 2),
    kind: dto.kind,
    note: dto.note,
  };
}

export default function Backups() {
  const { active, pushToast, reloadServers } = useStore();
  const backend = hasBackend();
  const [rows, setRows] = useState<Backup[]>(backend ? [] : initialBackups);
  const [records, setRecords] = useState<BackupDto[]>([]);
  const [schedule, setSchedule] = useState<BackupScheduleDto>({ auto: false, interval: 'Daily', maxKept: 7, lastRunAt: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [nowOpen, setNowOpen] = useState(false);
  const [bkName, setBkName] = useState(`manual-${new Date().toISOString().slice(0, 10)}`);
  const [progress, setProgress] = useState<number | null>(null);
  const [progressStage, setProgressStage] = useState('');
  const [restore, setRestore] = useState<Backup | null>(null);
  const [restoreMode, setRestoreMode] = useState<'in-place' | 'reset'>('in-place');
  const [del, setDel] = useState<Backup | null>(null);

  const load = useCallback(async () => {
    if (!backend || !active.id) return;
    setLoading(true);
    setError('');
    try {
      const [list, config] = await Promise.all([
        tauriBackups.list(active.id),
        tauriBackups.scheduleGet(active.id),
      ]);
      setRecords(list);
      setRows(list.map(fromDto));
      setSchedule(config);
    } catch (err) {
      const message = errorText(err, 'Could not read the backup index.');
      setError(message);
      pushToast(message, 'err');
    } finally {
      setLoading(false);
    }
  }, [active.id, backend, pushToast]);

  useEffect(() => { void load(); }, [load]);

  const updateSchedule = (patch: Partial<BackupScheduleDto>) => {
    const next = { ...schedule, ...patch };
    setSchedule(next);
    if (!backend) return;
    void tauriBackups.scheduleSet(active.id, patch)
      .then(setSchedule)
      .catch((err: unknown) => pushToast(errorText(err, 'Could not save the backup schedule.'), 'err'));
  };

  const backupNow = async () => {
    if (!bkName.trim()) {
      pushToast('Name the backup first.', 'err');
      return;
    }
    setNowOpen(false);
    setProgress(0);
    setProgressStage('starting');
    if (!backend) {
      let value = 0;
      const timer = window.setInterval(() => {
        value = Math.min(100, value + 12);
        setProgress(value);
        if (value >= 100) {
          window.clearInterval(timer);
          setRows((r) => [{ id: `b-${Date.now()}`, name: bkName, created: new Date().toISOString().slice(0, 16).replace('T', ' '), sizeMb: 820, kind: 'Manual' as const, note: 'One-off' }, ...r].slice(0, Math.max(schedule.maxKept, 1)));
          setProgress(null);
          pushToast(`Backup "${bkName}" complete (mock).`, 'ok');
        }
      }, 250);
      return;
    }
    const jobId = `backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const off = await onJobProgress(jobId, (payload) => {
      setProgress(payload.progress);
      setProgressStage(payload.stage ?? 'working');
    });
    try {
      await tauriBackups.create(active.id, bkName, jobId);
      await load();
      pushToast(`Backup "${bkName}" complete.`, 'ok');
    } catch (err) {
      pushToast(errorText(err, 'Backup failed.'), 'err');
    } finally {
      off();
      setProgress(null);
      setProgressStage('');
    }
  };

  const restoreBackup = async () => {
    if (!restore) return;
    if (!backend) {
      pushToast(`Restored "${restore.name}" (${restoreMode}) (mock).`, 'ok');
      setRestore(null);
      return;
    }
    const jobId = `restore-${Date.now()}`;
    setProgress(0);
    setProgressStage('restore queued');
    const off = await onJobProgress(jobId, (payload) => {
      setProgress(payload.progress);
      setProgressStage(payload.stage ?? 'restoring');
    });
    try {
      await tauriBackups.restore(active.id, restore.id, restoreMode, jobId);
      pushToast(`Restored "${restore.name}".`, 'ok');
      setRestore(null);
      void load();
      void reloadServers();
    } catch (err) {
      pushToast(errorText(err, 'Restore failed.'), 'err');
    } finally {
      off();
      setProgress(null);
      setProgressStage('');
    }
  };

  const removeBackup = (b: Backup) => {
    if (!backend) {
      setRows((r) => r.filter((x) => x.id !== b.id));
      return;
    }
    void tauriBackups.remove(b.id)
      .then(() => { pushToast(`Backup "${b.name}" deleted.`, 'ok'); void load(); })
      .catch((err: unknown) => pushToast(errorText(err, 'Could not delete the backup.'), 'err'));
  };

  const exportBackup = (b: Backup) => {
    if (!backend) {
      pushToast(`"${b.name}" download (mock zip).`, 'info');
      return;
    }
    void tauriBackups.exportBackup(b.id)
      .then((result) => {
        if ('cancelled' in result) return;
        pushToast(`Saved to ${result.path}`, 'ok');
      })
      .catch((err: unknown) => pushToast(errorText(err, 'Could not export the backup.'), 'err'));
  };

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Button onClick={() => setNowOpen(true)} disabled={progress !== null}>Backup Now</Button>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input type="checkbox" checked={schedule.auto} onChange={(e) => updateSchedule({ auto: e.target.checked })} /> Auto backups
          </label>
          <select value={schedule.interval} onChange={(e) => updateSchedule({ interval: e.target.value as BackupScheduleDto['interval'] })} disabled={!schedule.auto} className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs disabled:opacity-40">
            {['Hourly', 'Daily', 'Weekly'].map((i) => <option key={i}>{i}</option>)}
          </select>
          <label className="flex items-center gap-1 text-xs text-zinc-300">
            Max kept <input type="number" min={1} max={50} value={schedule.maxKept} onChange={(e) => updateSchedule({ maxKept: Number(e.target.value) })} disabled={!schedule.auto} className="w-16 rounded-md border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-xs disabled:opacity-40" />
          </label>
          <span className="text-xs text-zinc-500">Excludes: cache/, logs/</span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void load()} disabled={loading}>↻ Refresh</Button>
        </div>
        {progress !== null && (
          <div className="mt-2"><ProgressBar value={progress} /><p className="mt-1 text-xs text-zinc-500">{progressStage}… {progress}%</p></div>
        )}
      </Card>

      {error && <p role="alert" className="rounded border border-red-800 bg-red-950/60 px-3 py-2 text-xs text-red-200">{error}</p>}

      <div className="mc-table overflow-x-auto">
        <table>
          <thead className="bg-zinc-900 text-xs uppercase text-zinc-500">
            <tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Created</th><th className="px-3 py-2">Size</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Note</th><th className="px-3 py-2">Actions</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-xs text-zinc-500">No backups yet. Create one before installing or deleting a world.</td></tr>
            )}
            {rows.map((b) => (
              <tr key={b.id} className="border-t border-zinc-800 hover:bg-zinc-900/60">
                <td className="px-3 py-2 font-medium">{b.name}</td>
                <td className="px-3 py-2 text-xs text-zinc-400">{b.created}</td>
                <td className="px-3 py-2 text-xs text-zinc-400">{backend ? mbLabel((records.find((r) => r.id === b.id)?.bytes ?? 0)) : `${b.sizeMb} MB`}</td>
                <td className="px-3 py-2"><Badge tone={b.kind === 'Auto' ? 'blue' : b.kind === 'Pre-install' ? 'amber' : 'zinc'}>{b.kind}</Badge></td>
                <td className="px-3 py-2 text-xs text-zinc-400">{b.note}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" onClick={() => { setRestore(b); setRestoreMode('in-place'); }}>Restore…</Button>
                    <Button size="sm" variant="outline" onClick={() => exportBackup(b)}>Download</Button>
                    <Button size="sm" variant="outline" onClick={() => setDel(b)}>Delete</Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={nowOpen} title="Backup now" onClose={() => setNowOpen(false)}>
        <Field label="Backup name"><input value={bkName} onChange={(e) => setBkName(e.target.value)} className={inputCls} /></Field>
        <p className="mt-2 text-xs text-zinc-500">
          A running server is paused with <code>save-off</code>/<code>save-all flush</code> first, then resumed.
          Stop the server for a fully consistent snapshot.
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setNowOpen(false)}>Cancel</Button>
          <Button onClick={() => void backupNow()}>Start backup</Button>
        </div>
      </Modal>

      <Modal open={!!restore} title={`Restore "${restore?.name}"`} onClose={() => setRestore(null)}>
        <p className="text-xs text-zinc-400">Overwrites current world/server files. This cannot be undone — a pre-restore backup is taken automatically.</p>
        <div className="mt-2 space-y-1 text-sm">
          <label className="flex gap-2"><input type="radio" checked={restoreMode === 'in-place'} onChange={() => setRestoreMode('in-place')} /> In-place restore (overwrite current files)</label>
          <label className="flex gap-2"><input type="radio" checked={restoreMode === 'reset'} onChange={() => setRestoreMode('reset')} /> Reset then restore (wipe world dirs first)</label>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRestore(null)}>Cancel</Button>
          <Button variant="destructive" onClick={() => { void restoreBackup(); }} disabled={active.status === 'running' || active.status === 'starting'}>Restore (confirm)</Button>
        </div>
        {(active.status === 'running' || active.status === 'starting') && <p className="mt-2 text-xs text-amber-300">Stop the server before restoring.</p>}
      </Modal>

      <Confirm open={!!del} title={`Delete backup "${del?.name}"?`} message={<p>The snapshot zip is removed permanently.</p>}
        confirmLabel="Delete" onConfirm={() => { if (del) removeBackup(del); }} onClose={() => setDel(null)} />
    </div>
  );
}
