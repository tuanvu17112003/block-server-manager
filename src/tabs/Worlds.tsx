import { useState } from 'react';
import { initialWorlds } from '../mocks/data';
import type { WorldEntry } from '../types';
import { useStore } from '../store';
import { Badge, Button, Card, CardTitle, Confirm, Empty, Field, Modal, inputCls } from '../components/ui';

export default function Worlds() {
  const { active, pushToast } = useStore();
  const [worlds, setWorlds] = useState<WorldEntry[]>(initialWorlds);
  const [q, setQ] = useState('');
  const [confirm, setConfirm] = useState<{ title: string; msg: React.ReactNode; label: string; fn: () => void } | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('world2');
  const [newSeed, setNewSeed] = useState('');
  const [levelType, setLevelType] = useState('Default');

  const stopped = active.status === 'stopped';
  const current = worlds.find((w) => w.active) ?? worlds[0];
  const lib = worlds.filter((w) => w.name.toLowerCase().includes(q.toLowerCase()));

  const activate = (w: WorldEntry) => {
    if (!stopped) {
      pushToast('Stop the server first — activating a world replaces level-name.', 'err');
      return;
    }
    setConfirm({
      title: `Activate "${w.name}"?`,
      msg: <p>This replaces the current <code>level-name</code>. An automatic backup runs first (mock). Seed: <code>{w.seed}</code>.</p>,
      label: 'Backup + Activate',
      fn: () => {
        setWorlds((ws) => ws.map((x) => ({ ...x, active: x.id === w.id })));
        pushToast(`Auto-backup taken, "${w.name}" activated (mock).`, 'ok');
      },
    });
  };

  return (
    <div className="space-y-3">
      <Card>
        <CardTitle>Current world</CardTitle>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-2xl">🌍</span>
          <div>
            <p className="font-semibold">{current.name} <Badge tone="green">active</Badge> {current.shared && <Badge tone="blue">shared</Badge>}</p>
            <p className="text-xs text-zinc-500">{current.sizeMb} MB · last played {current.lastPlayed} · seed {current.seed}</p>
          </div>
          <div className="ml-auto flex gap-1.5">
            <Button size="sm" variant="outline" onClick={() => pushToast('World download started (mock zip).', 'info')}>Download</Button>
            <Button size="sm" variant="outline" onClick={() => setNewOpen(true)}>+ New empty</Button>
          </div>
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search library…" className="w-52 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm outline-none focus:border-emerald-500" />
        <span className="text-xs text-zinc-500">Local + Shared library</span>
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => pushToast('Upload .zip flow (mock — picker deferred).', 'info')}>Upload .zip</Button>
        </div>
      </div>

      {lib.length === 0 ? (
        <Empty title="No worlds in the library yet." />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {lib.map((w) => (
            <Card key={w.id} className={`mc-inv ${w.active ? 'mc-inv-active' : ''}`}>
              <div className="flex items-center gap-2">
                <strong className="text-sm">{w.name}</strong>
                {w.active && <Badge tone="green">active</Badge>}
                {w.shared ? <Badge tone="blue">shared</Badge> : <Badge>local</Badge>}
              </div>
              <p className="mt-1 text-xs text-zinc-500">{w.sizeMb} MB · {w.lastPlayed} · seed {w.seed}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {!w.active && (
                  <Button size="sm" disabled={!stopped} title={stopped ? 'Activate (auto-backup first)' : 'Stop the server to activate a world'}
                    onClick={() => activate(w)}>Activate</Button>
                )}
                <Button size="sm" variant="outline" onClick={() => pushToast(`"${w.name}" download (mock).`, 'info')}>Download</Button>
                <Button size="sm" variant="outline" onClick={() => { setWorlds((ws) => [...ws, { ...w, id: `w-${Date.now()}`, name: `${w.name}-copy`, active: false }]); pushToast(`Duplicated "${w.name}" (mock).`, 'ok'); }}>Duplicate</Button>
                <Button size="sm" variant="outline" onClick={() => setConfirm({ title: `Delete "${w.name}"?`, msg: <p>This permanently deletes the world folder. This cannot be undone.</p>, label: 'Delete', fn: () => { setWorlds((ws) => ws.filter((x) => x.id !== w.id)); pushToast(`"${w.name}" deleted (mock).`, 'info'); } })}>Delete</Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      {!stopped && <p className="text-xs text-zinc-500">⚠ Activate requires a stopped server and warns that it replaces <code>level-name</code>.</p>}

      <Modal open={newOpen} title="New empty world" onClose={() => setNewOpen(false)}>
        <div className="space-y-3">
          <Field label="Name"><input value={newName} onChange={(e) => setNewName(e.target.value)} className={inputCls} /></Field>
          <Field label="Seed (blank = random)"><input value={newSeed} onChange={(e) => setNewSeed(e.target.value)} placeholder="e.g. 8675309" className={inputCls} /></Field>
          <Field label="Level type">
            <select value={levelType} onChange={(e) => setLevelType(e.target.value)} className={inputCls}>
              {['Default', 'Flat', 'Large Biomes', 'Amplified'].map((t) => <option key={t}>{t}</option>)}
            </select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setNewOpen(false)}>Cancel</Button>
            <Button onClick={() => { setWorlds((ws) => [...ws, { id: `w-${Date.now()}`, name: newName || 'world-new', sizeMb: 0, lastPlayed: '—', seed: newSeed || String(Math.floor(Math.random() * 1e9)), shared: false, active: false }]); setNewOpen(false); pushToast('Empty world created (mock).', 'ok'); }}>Create world</Button>
          </div>
        </div>
      </Modal>

      <Confirm open={!!confirm} title={confirm?.title ?? ''} message={confirm?.msg} confirmLabel={confirm?.label}
        onConfirm={() => confirm?.fn()} onClose={() => setConfirm(null)} />
    </div>
  );
}
