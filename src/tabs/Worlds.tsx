import { useCallback, useEffect, useMemo, useState } from 'react';
import { initialWorlds } from '../mocks/data';
import type { WorldEntry } from '../types';
import { useStore } from '../store';
import { Badge, Button, Card, CardTitle, Confirm, Empty, Field, Modal, ProgressBar, inputCls } from '../components/ui';
import { hasBackend, isElectron, onJobProgress, tauriWorlds } from '../tauri';
import type { WorldDto } from '../tauri';

function errorText(error: unknown, fallback: string): string {
  return error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : fallback;
}

/** Additive Phase-5 DTO fields not yet reflected in the shared tauri.ts types. */
type WorldRowDto = WorldDto & { seed?: string | null; warning?: string | null };
interface WorldRow extends WorldEntry {
  pending: boolean;
  seedText: string;
  warning?: string | null;
}

function localDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso || '—';
  return date.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function mb(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  if (bytes < 1024 ** 3) return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function fromDto(dto: WorldRowDto): WorldRow {
  return {
    id: dto.name,
    name: dto.name,
    sizeMb: Math.round(dto.sizeBytes / 1024 ** 2),
    lastPlayed: localDate(dto.lastModified),
    seed: dto.seed ?? '—',
    seedText: dto.seed ?? '—',
    shared: false,
    active: dto.active,
    pending: dto.pending === true,
    warning: dto.warning ?? null,
  };
}

const LEVEL_TYPES = [
  { label: 'Default', value: 'minecraft:normal' },
  { label: 'Flat', value: 'minecraft:flat' },
  { label: 'Large Biomes', value: 'minecraft:large_biomes' },
  { label: 'Amplified', value: 'minecraft:amplified' },
];

export default function Worlds() {
  const { active, pushToast, reloadServers } = useStore();
  const backend = hasBackend();
  const [worlds, setWorlds] = useState<WorldRow[]>(backend ? [] : initialWorlds.map((world) => ({
    ...world, pending: false, seedText: world.seed,
  })));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [confirm, setConfirm] = useState<{ title: string; msg: React.ReactNode; label: string; fn: () => void } | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('world2');
  const [newSeed, setNewSeed] = useState('');
  const [levelType, setLevelType] = useState(LEVEL_TYPES[0].value);
  const [progress, setProgress] = useState<{ label: string; pct: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const stopped = active.status === 'stopped' || active.status === 'crashed';

  const load = useCallback(async () => {
    if (!backend || !active.id) {
      setWorlds(initialWorlds.map((world) => ({ ...world, pending: false, seedText: world.seed })));
      return;
    }
    setLoading(true);
    setError('');
    try {
      const rows = (await tauriWorlds.list(active.id)) as WorldRowDto[];
      setWorlds(rows.map(fromDto));
    } catch (err) {
      const message = errorText(err, 'Could not scan the server folder for worlds.');
      setError(message);
      pushToast(message, 'err');
    } finally {
      setLoading(false);
    }
  }, [active.id, backend, pushToast]);

  useEffect(() => { void load(); }, [load]);

  /** Run a worlds command with job progress when the Electron backend can pass a jobId. */
  const withProgress = async <T,>(label: string, command: string, args: Record<string, unknown>, fallback: () => Promise<T>): Promise<T> => {
    if (!isElectron()) return fallback();
    const jobId = `world-${command}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setProgress({ label, pct: 0 });
    const off = await onJobProgress(jobId, (payload) => {
      setProgress({ label, pct: Number.isFinite(payload.progress) ? payload.progress : 0 });
    });
    try {
      return (await window.electronAPI!.invoke(command, { ...args, jobId })) as T;
    } finally {
      off();
      setProgress(null);
    }
  };

  const current = useMemo(() => worlds.find((world) => world.active) ?? null, [worlds]);
  const warnings = useMemo(() => worlds.filter((world) => world.warning), [worlds]);
  const lib = useMemo(
    () => worlds.filter((w) => w.name.toLowerCase().includes(q.toLowerCase())),
    [q, worlds],
  );

  const activate = (world: WorldRow) => {
    if (!stopped) {
      pushToast('Stop the server first — activating a world replaces level-name.', 'err');
      return;
    }
    if (world.pending) {
      pushToast('This world is created on the next start; start the server first.', 'err');
      return;
    }
    setConfirm({
      title: `Activate “${world.name}”?`,
      msg: <p>This replaces <code>level-name</code> in server.properties. An automatic backup runs first, so the previous world can be restored from Backups.</p>,
      label: 'Backup + Activate',
      fn: () => {
        if (!backend) {
          setWorlds((ws) => ws.map((x) => ({ ...x, active: x.id === world.id })));
          pushToast(`Auto-backup taken, "${world.name}" activated (mock).`, 'ok');
          return;
        }
        setBusy(true);
        void tauriWorlds.activate(active.id, world.name)
          .then(() => { pushToast(`Auto-backup taken; "${world.name}" is now level-name.`, 'ok'); void load(); void reloadServers(); })
          .catch((err: unknown) => pushToast(errorText(err, 'Could not activate the world.'), 'err'))
          .finally(() => setBusy(false));
      },
    });
  };

  const createWorld = () => {
    const name = newName.trim();
    if (!name) return;
    if (!backend) {
      setWorlds((ws) => [...ws, { id: `w-${Date.now()}`, name, sizeMb: 0, lastPlayed: '—', seed: newSeed || String(Math.floor(Math.random() * 1e9)), seedText: newSeed || '—', shared: false, active: false, pending: true }]);
      setNewOpen(false);
      pushToast('Empty world created (mock).', 'ok');
      return;
    }
    void tauriWorlds.create(active.id, name, newSeed, levelType)
      .then(() => {
        setNewOpen(false);
        pushToast(`"${name}" will be generated on the next start; level-name was replaced.`, 'ok');
        void load();
        void reloadServers();
      })
      .catch((err: unknown) => pushToast(errorText(err, 'Could not create the world.'), 'err'));
  };

  const duplicate = (world: WorldRow) => {
    if (!stopped || world.pending) {
      pushToast(world.pending ? 'A pending world has no folder to duplicate yet.' : 'Stop the server before duplicating a world.', 'err');
      return;
    }
    if (!backend) {
      setWorlds((ws) => [...ws, { ...world, id: `w-${Date.now()}`, name: `${world.name}-copy`, active: false }]);
      pushToast(`Duplicated "${world.name}" (mock).`, 'ok');
      return;
    }
    setBusy(true);
    void withProgress<WorldDto>('Duplicating world', 'world_duplicate', { id: active.id, name: world.name }, () => tauriWorlds.duplicate(active.id, world.name))
      .then((copy) => { pushToast(`Duplicated as "${copy.name}" (dimensions included).`, 'ok'); void load(); void reloadServers(); })
      .catch((err: unknown) => pushToast(errorText(err, 'Could not duplicate the world.'), 'err'))
      .finally(() => setBusy(false));
  };

  const removeWorld = (world: WorldRow) => {
    if (!stopped || world.active || world.pending) return;
    setBusy(true);
    const done = () => { pushToast(`"${world.name}" deleted after a safety backup.`, 'ok'); void load(); void reloadServers(); };
    if (!backend) { setWorlds((ws) => ws.filter((x) => x.id !== world.id)); setBusy(false); pushToast(`"${world.name}" deleted (mock).`, 'info'); return; }
    void tauriWorlds.remove(active.id, world.name).then(done)
      .catch((err: unknown) => pushToast(errorText(err, 'Could not delete the world.'), 'err'))
      .finally(() => setBusy(false));
  };

  const exportWorld = (world: WorldRow) => {
    if (!stopped || world.pending) {
      pushToast(world.pending ? 'A pending world has no folder to export yet.' : 'Stop the server before exporting a world.', 'err');
      return;
    }
    if (!backend) { pushToast(`"${world.name}" download (mock).`, 'info'); return; }
    setBusy(true);
    void withProgress<{ path: string } | { cancelled: true }>('Exporting world ZIP', 'world_export', { id: active.id, name: world.name }, () => tauriWorlds.exportWorld(active.id, world.name))
      .then((result) => { if (!('cancelled' in result)) pushToast(`Exported to ${result.path}`, 'ok'); })
      .catch((err: unknown) => pushToast(errorText(err, 'Could not export the world.'), 'err'))
      .finally(() => setBusy(false));
  };

  const importWorld = () => {
    if (!stopped) { pushToast('Stop the server before importing a world ZIP.', 'err'); return; }
    if (!backend) { pushToast('Import ZIP flow (mock — picker deferred).', 'info'); return; }
    setBusy(true);
    void withProgress<{ name: string } | { cancelled: true }>('Importing world ZIP', 'world_import', { id: active.id }, () => tauriWorlds.importWorld(active.id))
      .then((result) => { if (!('cancelled' in result)) { pushToast(`Imported world "${result.name}".`, 'ok'); void load(); } })
      .catch((err: unknown) => pushToast(errorText(err, 'Could not import the world.'), 'err'))
      .finally(() => setBusy(false));
  };

  const actionLocked = busy || !stopped;

  return (
    <div className="space-y-3">
      <Card>
        <CardTitle>Current world</CardTitle>
        {current ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span aria-hidden="true" className="text-2xl">🌍</span>
            <div>
              <p className="font-semibold">
                {current.name} <Badge tone="green">active</Badge>
                {current.pending && <Badge tone="amber">next start</Badge>}
              </p>
              <p className="text-xs text-zinc-500">{mb((current.sizeMb ?? 0) * 1024 ** 2)} · last saved {current.lastPlayed} · seed <code>{current.seedText}</code></p>
            </div>
            <div className="ml-auto flex gap-1.5">
              <Button size="sm" variant="outline" disabled={!stopped || current.pending || busy} title={stopped ? 'Save a ZIP copy (opens a save dialog)' : 'Stop the server before exporting'} onClick={() => exportWorld(current)}>Export ZIP…</Button>
              <Button size="sm" variant="outline" disabled={!stopped} title={stopped ? 'Create a world for the next start' : 'Stop the server first'} onClick={() => setNewOpen(true)}>+ New empty</Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-zinc-400">
            No active world found. {stopped ? 'Create one below; it is generated on the next start.' : 'The server may still be starting — the world appears after Done().'}
          </p>
        )}
        {warnings.length > 0 && (
          <div role="alert" className="mt-2 rounded border border-amber-800 bg-amber-950/50 px-3 py-2 text-xs text-amber-200">
            {warnings.map((world) => <p key={world.id}>“{world.name}”: {world.warning}</p>)}
          </div>
        )}
      </Card>

      {progress && (
        <Card>
          <p className="text-xs text-zinc-400">{progress.label} · {progress.pct}%</p>
          <div className="mt-1"><ProgressBar value={progress.pct} /></div>
        </Card>
      )}

      {error && <p role="alert" className="rounded border border-red-800 bg-red-950/60 px-3 py-2 text-xs text-red-200">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="Search worlds" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search library…" className="w-52 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm outline-none focus:border-emerald-500" />
        <span className="text-xs text-zinc-500">{loading ? 'Scanning…' : `Local library · ${worlds.length} world${worlds.length === 1 ? '' : 's'} · shared library deferred`}</span>
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading || busy}>↻ Refresh</Button>
          <Button size="sm" variant="secondary" disabled={!stopped || busy} title={stopped ? 'Import a world ZIP (validated level.dat)' : 'Stop the server first'} onClick={importWorld}>Import ZIP…</Button>
        </div>
      </div>

      {lib.length === 0 && !loading ? (
        <Empty title="No worlds in the library yet." body="Start the server once to generate the first world, or import a world ZIP while the server is stopped." />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {lib.map((w) => (
            <Card key={w.id} className={`mc-inv ${w.active ? 'mc-inv-active' : ''}`}>
              <div className="flex items-center gap-2">
                <strong className="text-sm">{w.name}</strong>
                {w.active && <Badge tone="green">active</Badge>}
                {w.pending && <Badge tone="amber">next start</Badge>}
                {w.warning && <Badge tone="amber">level.dat unreadable</Badge>}
                <Badge>local</Badge>
              </div>
              <p className="mt-1 text-xs text-zinc-500">{w.sizeMb} MB · {w.lastPlayed} · seed {w.seedText}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {!w.active && !w.pending && (
                  <Button size="sm" disabled={!stopped || busy} title={stopped ? 'Activate (auto-backup first)' : 'Stop the server to activate a world'} onClick={() => activate(w)}>Activate</Button>
                )}
                <Button size="sm" variant="outline" disabled={!stopped || w.pending || busy} title={stopped ? 'Save a ZIP copy' : 'Stop the server before exporting'} onClick={() => exportWorld(w)}>Export ZIP…</Button>
                <Button size="sm" variant="outline" disabled={!stopped || w.pending || busy} title={stopped ? 'Duplicate world + dimensions' : 'Stop the server first'} onClick={() => duplicate(w)}>Duplicate</Button>
                <Button size="sm" variant="outline" disabled={!stopped || w.active || w.pending || busy} title={w.active ? 'The active world cannot be deleted' : w.pending ? 'Pending worlds have no folder yet' : 'Delete after a safety backup'} onClick={() => setConfirm({ title: `Delete “${w.name}”?`, msg: <p>The world folder and its dimensions are archived to a safety backup first, then deleted. This cannot be undone from this tab.</p>, label: 'Delete', fn: () => removeWorld(w) })}>Delete</Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      {!stopped && <p className="text-xs text-zinc-500">⚠ World changes (activate/duplicate/delete/import/export) require a stopped server.</p>}
      {actionLocked && !stopped && <span className="sr-only">world actions locked</span>}

      <Modal open={newOpen} title="New empty world" onClose={() => setNewOpen(false)}>
        <div className="space-y-3">
          <Field label="Name"><input value={newName} onChange={(e) => setNewName(e.target.value)} className={inputCls} /></Field>
          <Field label="Seed (blank = random)"><input value={newSeed} onChange={(e) => setNewSeed(e.target.value)} placeholder="e.g. 8675309" className={inputCls} /></Field>
          <Field label="Level type">
            <select value={levelType} onChange={(e) => setLevelType(e.target.value)} className={inputCls}>
              {LEVEL_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
          <p className="text-xs text-amber-300">This replaces <code>level-name</code> immediately; the world is generated on the next start and appears with a “next start” badge.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setNewOpen(false)}>Cancel</Button>
            <Button onClick={createWorld} disabled={!stopped || !newName.trim()}>Create for next start</Button>
          </div>
        </div>
      </Modal>

      <Confirm open={!!confirm} title={confirm?.title ?? ''} message={confirm?.msg} confirmLabel={confirm?.label}
        onConfirm={() => confirm?.fn()} onClose={() => setConfirm(null)} />
    </div>
  );
}
