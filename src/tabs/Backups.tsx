import { useState } from 'react';
import { initialBackups } from '../mocks/data';
import type { Backup } from '../types';
import { useStore } from '../store';
import { Badge, Button, Card, Confirm, Field, Modal, ProgressBar, inputCls } from '../components/ui';
import { tauriServer } from '../tauri';

export default function Backups() {
  const { active, pushToast } = useStore();
  const [rows, setRows] = useState<Backup[]>(initialBackups);
  const [nowOpen, setNowOpen] = useState(false);
  const [bkName, setBkName] = useState(`manual-${new Date().toISOString().slice(0, 10)}`);
  const [auto, setAuto] = useState(true);
  const [interval, setInterval] = useState('Daily');
  const [maxKept, setMaxKept] = useState(7);
  const [progress, setProgress] = useState<number | null>(null);
  const [restore, setRestore] = useState<Backup | null>(null);
  const [restoreMode, setRestoreMode] = useState<'in-place' | 'reset'>('in-place');
  const [del, setDel] = useState<Backup | null>(null);

  const backupNow = () => {
    if (!bkName.trim()) {
      pushToast('Name the backup first.', 'err');
      return;
    }
    setNowOpen(false);
    setProgress(0);
    void tauriServer.backupNow(active.id, bkName);
    const t = window.setInterval(() => {
      setProgress((p) => {
        if (p === null) return null;
        if (p >= 100) {
          window.clearInterval(t);
          return 100;
        }
        return p + 12;
      });
    }, 250);
    window.setTimeout(() => {
      window.clearInterval(t);
      setRows((r) => [{ id: `b-${Date.now()}`, name: bkName, created: new Date().toISOString().slice(0, 16).replace('T', ' '), sizeMb: 820, kind: 'Manual' as const, note: auto ? 'Auto-schedule on' : 'One-off' }, ...r].slice(0, Math.max(maxKept, 1)));
      setProgress(null);
      pushToast(`Backup "${bkName}" complete; retention keeps last ${maxKept} (mock).`, 'ok');
    }, 2200);
  };

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Button onClick={() => setNowOpen(true)}>Backup Now</Button>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto backups
          </label>
          <select value={interval} onChange={(e) => setInterval(e.target.value)} disabled={!auto} className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs disabled:opacity-40">
            {['Hourly', 'Daily', 'Weekly'].map((i) => <option key={i}>{i}</option>)}
          </select>
          <label className="flex items-center gap-1 text-xs text-zinc-300">
            Max kept <input type="number" min={1} max={50} value={maxKept} onChange={(e) => setMaxKept(Number(e.target.value))} disabled={!auto} className="w-16 rounded-md border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-xs disabled:opacity-40" />
          </label>
          <span className="text-xs text-zinc-500">Excludes: cache/, logs/, dynmap tiles (hint)</span>
        </div>
        {progress !== null && (
          <div className="mt-2"><ProgressBar value={progress} /><p className="mt-1 text-xs text-zinc-500">Backing up… {progress}%</p></div>
        )}
      </Card>

      <div className="mc-table overflow-x-auto">
        <table>
          <thead className="bg-zinc-900 text-xs uppercase text-zinc-500">
            <tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Created</th><th className="px-3 py-2">Size</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Note</th><th className="px-3 py-2">Actions</th></tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id} className="border-t border-zinc-800 hover:bg-zinc-900/60">
                <td className="px-3 py-2 font-medium">{b.name}</td>
                <td className="px-3 py-2 text-xs text-zinc-400">{b.created}</td>
                <td className="px-3 py-2 text-xs text-zinc-400">{b.sizeMb} MB</td>
                <td className="px-3 py-2"><Badge tone={b.kind === 'Auto' ? 'blue' : b.kind === 'Pre-install' ? 'amber' : 'zinc'}>{b.kind}</Badge></td>
                <td className="px-3 py-2 text-xs text-zinc-400">{b.note}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" onClick={() => { setRestore(b); setRestoreMode('in-place'); }}>Restore…</Button>
                    <Button size="sm" variant="outline" onClick={() => pushToast(`"${b.name}" download (mock zip).`, 'info')}>Download</Button>
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
        <p className="mt-2 text-xs text-zinc-500">Note: files may change during backup — for a fully consistent snapshot, stop the server first (shutdown-during warning).</p>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setNowOpen(false)}>Cancel</Button>
          <Button onClick={backupNow}>Start backup</Button>
        </div>
      </Modal>

      <Modal open={!!restore} title={`Restore "${restore?.name}"`} onClose={() => setRestore(null)}>
        <p className="text-xs text-zinc-400">Overwrites current world/server files. This cannot be undone — consider a fresh Backup Now first.</p>
        <div className="mt-2 space-y-1 text-sm">
          <label className="flex gap-2"><input type="radio" checked={restoreMode === 'in-place'} onChange={() => setRestoreMode('in-place')} /> In-place restore (overwrite current files)</label>
          <label className="flex gap-2"><input type="radio" checked={restoreMode === 'reset'} onChange={() => setRestoreMode('reset')} /> Reset then restore (wipe world dir first)</label>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRestore(null)}>Cancel</Button>
          <Button variant="destructive" onClick={() => { if (restore) void tauriServer.restoreBackup(active.id, restore.id); pushToast(`Restored "${restore?.name}" (${restoreMode}) (mock).`, 'ok'); setRestore(null); }}>Restore (confirm)</Button>
        </div>
      </Modal>

      <Confirm open={!!del} title={`Delete backup "${del?.name}"?`} message={<p>The snapshot zip is removed permanently.</p>}
        confirmLabel="Delete" onConfirm={() => { if (del) setRows((r) => r.filter((x) => x.id !== del.id)); }} onClose={() => setDel(null)} />
    </div>
  );
}
