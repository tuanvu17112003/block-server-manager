import { useCallback, useEffect, useMemo, useState } from 'react';
import { initialWorlds } from '../mocks/data';
import type { WorldEntry } from '../types';
import { useStore } from '../store';
import { Badge, Button, Card, CardTitle, Confirm, Empty, Field, Modal, inputCls } from '../components/ui';
import { hasBackend, tauriWorlds } from '../tauri';
import type { WorldDto } from '../tauri';

function errorText(error: unknown, fallback: string): string {
  return error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : fallback;
}

function mb(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  if (bytes < 1024 ** 3) return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function fromDto(dto: WorldDto): WorldEntry {
  return {
    id: dto.name,
    name: dto.name,
    sizeMb: Math.round(dto.sizeBytes / 1024 ** 2),
    lastPlayed: dto.lastModified.slice(0, 16).replace('T', ' '),
    seed: '—',
    shared: false,
    active: dto.active,
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
  const [worlds, setWorlds] = useState<WorldEntry[]>(backend ? [] : initialWorlds);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [confirm, setConfirm] = useState<{ title: string; msg: React.ReactNode; label: string; fn: () => void } | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('world2');
  const [newSeed, setNewSeed] = useState('');
  const [levelType, setLevelType] = useState(LEVEL_TYPES[0].value);

  const stopped = active.status === 'stopped' || active.status === 'crashed';

  const load = useCallback(async () => {
    if (!backend || !active.id) {
      setWorlds(initialWorlds);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const rows = await tauriWorlds.list(active.id);
      setWorlds(rows.map(fromDto));
      setPending(new Set(rows.filter((row) => row.pending).map((row) => row.name)));
    } catch (err) {
      const message = errorText(err, 'Could not scan the server folder for worlds.');
      setError(message);
      pushToast(message, 'err');
    } finally {
      setLoading(false);
    }
  }, [active.id, backend, pushToast]);

  useEffect(() => { void load(); }, [load]);

  const current = useMemo(() => worlds.find((w) => w.active) ?? worlds[0], [worlds]);
  const lib = useMemo(
    () => worlds.filter((w) => w.name.toLowerCase().includes(q.toLowerCase())),
    [q, worlds],
  );

  const activate = (w: WorldEntry) => {
    if (!stopped) {
      pushToast('Stop the server first — activating a world replaces level-name.', 'err');
      return;
    }
    setConfirm({
      title: `Activate "${w.name}"?`,
      msg: <p>This replaces the current <code>level-name</code>. An automatic backup runs first.</p>,
      label: 'Backup + Activate',
      fn: () => {
        if (!backend) {
          setWorlds((ws) => ws.map((x) => ({ ...x, active: x.id === w.id })));
          pushToast(`Auto-backup taken, "${w.name}" activated (mock).`, 'ok');
          return;
        }
        void tauriWorlds.activate(active.id, w.name)
          .then(() => { pushToast(`Backup taken, "${w.name}" activated.`, 'ok'); void load(); void reloadServers(); })
          .catch((err: unknown) => pushToast(errorText(err, 'Could not activate the world.'), 'err'));
      },
    });
  };

  const createWorld = () => {
    const name = newName.trim();
    if (!name) return;
    if (!backend) {
      setWorlds((ws) => [...ws, { id: `w-${Date.now()}`, name, sizeMb: 0, lastPlayed: '—', seed: newSeed || String(Math.floor(Math.random() * 1e9)), shared: false, active: false }]);
      setNewOpen(false);
      pushToast('Empty world created (mock).', 'ok');
      return;
    }
    void tauriWorlds.create(active.id, name, newSeed, levelType)
      .then(() => {
        setNewOpen(false);
        pushToast(`"${name}" will be generated on the next start.`, 'ok');
        void load();
        void reloadServers();
      })
      .catch((err: unknown) => pushToast(errorText(err, 'Could not create the world.'), 'err'));
  };

  const duplicate = (w: WorldEntry) => {
    if (!backend) {
      setWorlds((ws) => [...ws, { ...w, id: `w-${Date.now()}`, name: `${w.name}-copy`, active: false }]);
      pushToast(`Duplicated "${w.name}" (mock).`, 'ok');
      return;
    }
    void tauriWorlds.duplicate(active.id, w.name)
      .then((copy) => { pushToast(`Duplicated as "${copy.name}".`, 'ok'); void load(); void reloadServers(); })
      .catch((err: unknown) => pushToast(errorText(err, 'Could not duplicate the world.'), 'err'));
  };

  const removeWorld = (w: WorldEntry) => {
    if (!backend) {
      setWorlds((ws) => ws.filter((x) => x.id !== w.id));
      pushToast(`"${w.name}" deleted (mock).`, 'info');
      return;
    }
    void tauriWorlds.remove(active.id, w.name)
      .then(() => { pushToast(`"${w.name}" deleted after a safety backup.`, 'ok'); void load(); void reloadServers(); })
      .catch((err: unknown) => pushToast(errorText(err, 'Could not delete the world.'), 'err'));
  };

  const exportWorld = (w: WorldEntry) => {
    if (!backend) {
      pushToast(`"${w.name}" download (mock).`, 'info');
      return;
    }
    void tauriWorlds.exportWorld(active.id, w.name)
      .then((result) => {
        if ('cancelled' in result) return;
        pushToast(`Exported to ${result.path}`, 'ok');
      })
      .catch((err: unknown) => pushToast(errorText(err, 'Could not export the world.'), 'err'));
  };

  const importWorld = () => {
    if (!backend) {
      pushToast('Upload .zip flow (mock — picker deferred).', 'info');
      return;
    }
    void tauriWorlds.importWorld(active.id)
      .then((result) => {
        if ('cancelled' in result) return;
        pushToast(`Imported world "${result.name}".`, 'ok');
        void load();
      })
      .catch((err: unknown) => pushToast(errorText(err, 'Could not import the world.'), 'err'));
  };

  return (
    <div className="space-y-3">
      <Card>
        <CardTitle>Current world</CardTitle>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-2xl">🌍</span>
          <div>
            <p className="font-semibold">{current?.name ?? active.worldName ?? 'world'} <Badge tone="green">active</Badge>{current && pending.has(current.name) && <Badge tone="amber">next start</Badge>}</p>
            <p className="text-xs text-zinc-500">
              {current ? `${mb((current.sizeMb ?? 0) * 1024 ** 2)} · last modified ${current.lastPlayed}` : 'No level.dat yet — the world is generated on the first start.'}
            </p>
          </div>
          <div className="ml-auto flex gap-1.5">
            <Button size="sm" variant="outline" disabled={!current || loading} onClick={() => current && exportWorld(current)}>Download</Button>
            <Button size="sm" variant="outline" disabled={!stopped} title={stopped ? 'Create a world for the next start' : 'Stop the server first'} onClick={() => setNewOpen(true)}>+ New empty</Button>
          </div>
        </div>
      </Card>

      {error && <p role="alert" className="rounded border border-red-800 bg-red-950/60 px-3 py-2 text-xs text-red-200">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search library…" className="w-52 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm outline-none focus:border-emerald-500" />
        <span className="text-xs text-zinc-500">{loading ? 'Scanning…' : `Local library · ${worlds.length} world${worlds.length === 1 ? '' : 's'}`}</span>
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>↻ Refresh</Button>
          <Button size="sm" variant="secondary" disabled={!stopped} title={stopped ? 'Import a world ZIP' : 'Stop the server first'} onClick={importWorld}>Upload .zip</Button>
        </div>
      </div>

      {lib.length === 0 && !loading ? (
        <Empty title="No worlds in the library yet." body="Start the server once to generate the first world, or import a world ZIP." />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {lib.map((w) => (
            <Card key={w.id} className={`mc-inv ${w.active ? 'mc-inv-active' : ''}`}>
              <div className="flex items-center gap-2">
                <strong className="text-sm">{w.name}</strong>
                {w.active && <Badge tone="green">active</Badge>}
                {pending.has(w.name) && <Badge tone="amber">next start</Badge>}
                <Badge>local</Badge>
              </div>
              <p className="mt-1 text-xs text-zinc-500">{w.sizeMb} MB · {w.lastPlayed}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {!w.active && !pending.has(w.name) && (
                  <Button size="sm" disabled={!stopped} title={stopped ? 'Activate (auto-backup first)' : 'Stop the server to activate a world'}
                    onClick={() => activate(w)}>Activate</Button>
                )}
                <Button size="sm" variant="outline" disabled={loading} onClick={() => exportWorld(w)}>Download</Button>
                <Button size="sm" variant="outline" disabled={!stopped || loading} onClick={() => duplicate(w)}>Duplicate</Button>
                <Button size="sm" variant="outline" disabled={!stopped || w.active || loading} onClick={() => setConfirm({ title: `Delete "${w.name}"?`, msg: <p>This deletes the world folder after a safety backup. This cannot be undone.</p>, label: 'Delete', fn: () => removeWorld(w) })}>Delete</Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      {!stopped && <p className="text-xs text-zinc-500">⚠ World changes require a stopped server.</p>}

      <Modal open={newOpen} title="New empty world" onClose={() => setNewOpen(false)}>
        <div className="space-y-3">
          <Field label="Name"><input value={newName} onChange={(e) => setNewName(e.target.value)} className={inputCls} /></Field>
          <Field label="Seed (blank = random)"><input value={newSeed} onChange={(e) => setNewSeed(e.target.value)} placeholder="e.g. 8675309" className={inputCls} /></Field>
          <Field label="Level type">
            <select value={levelType} onChange={(e) => setLevelType(e.target.value)} className={inputCls}>
              {LEVEL_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
          <p className="text-xs text-zinc-500">The world is generated by Minecraft on the next start with these settings.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setNewOpen(false)}>Cancel</Button>
            <Button onClick={createWorld} disabled={!stopped || !newName.trim()}>Create world</Button>
          </div>
        </div>
      </Modal>

      <Confirm open={!!confirm} title={confirm?.title ?? ''} message={confirm?.msg} confirmLabel={confirm?.label}
        onConfirm={() => confirm?.fn()} onClose={() => setConfirm(null)} />
    </div>
  );
}
