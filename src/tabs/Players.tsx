import { useCallback, useEffect, useState } from 'react';
import { initialPlayers } from '../mocks/data';
import type { Player } from '../types';
import { useStore } from '../store';
import { Badge, Button, Confirm, Empty, Field, Modal, inputCls } from '../components/ui';
import { hasBackend, tauriPlayers } from '../tauri';

function errorText(error: unknown, fallback: string): string {
  return error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : fallback;
}

export default function Players() {
  const { active, pushToast } = useStore();
  const backend = hasBackend();
  const [players, setPlayers] = useState<Player[]>(backend ? [] : initialPlayers);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('All');
  const [confirm, setConfirm] = useState<{ title: string; msg: string; fn: () => void } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [tp, setTp] = useState<Player | null>(null);
  const [tpTarget, setTpTarget] = useState('');

  const running = active.status === 'running';

  const load = useCallback(async () => {
    if (!backend || !active.id) {
      setPlayers(initialPlayers);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await tauriPlayers.list(active.id);
      setPlayers(result.players as Player[]);
    } catch (err) {
      const message = errorText(err, 'Could not read the player roster.');
      setError(message);
      pushToast(message, 'err');
    } finally {
      setLoading(false);
    }
  }, [active.id, backend, pushToast]);

  useEffect(() => { void load(); }, [load]);

  const rows = players.filter((p) => {
    if (q && !p.name.toLowerCase().includes(q.toLowerCase())) return false;
    if (filter === 'Online') return p.online;
    if (filter === 'OP') return p.op;
    if (filter === 'Whitelisted') return p.whitelisted;
    if (filter === 'Banned') return p.banned;
    return true;
  });

  const mockAct = (uuid: string, patch: Partial<Player>, toast: string) => {
    setPlayers((ps) => ps.map((x) => (x.uuid === uuid ? { ...x, ...patch } : x)));
    pushToast(toast, 'ok');
  };

  const act = (action: string, p: Player, value?: string, toast?: string) => {
    if (!running) return;
    if (!backend) {
      if (action === 'kick') mockAct(p.uuid, { online: false, lastSeen: 'just now' }, `${p.name} kicked (mock).`);
      else if (action === 'ban') mockAct(p.uuid, { banned: true, online: false }, `${p.name} banned (mock).`);
      else if (action === 'unban') mockAct(p.uuid, { banned: false }, `${p.name} unbanned (mock).`);
      else if (action === 'op') mockAct(p.uuid, { op: true }, `${p.name} opped (mock).`);
      else if (action === 'deop') mockAct(p.uuid, { op: false }, `${p.name} de-opped (mock).`);
      else if (action === 'whitelistAdd') mockAct(p.uuid, { whitelisted: true }, `${p.name} whitelisted (mock).`);
      else if (action === 'whitelistRemove') mockAct(p.uuid, { whitelisted: false }, `${p.name} removed from whitelist (mock).`);
      else if (action === 'gamemode') mockAct(p.uuid, { gamemode: value ?? 'Survival' }, `${p.name} gamemode → ${value} (mock).`);
      else pushToast(`${action} for ${p.name} (mock).`, 'info');
      return;
    }
    void tauriPlayers.action(active.id, action, p.name, value)
      .then(() => {
        pushToast(toast ?? `${p.name}: ${action}`, 'ok');
        void load();
      })
      .catch((err: unknown) => pushToast(errorText(err, 'Player action failed.'), 'err'));
  };

  const ask = (title: string, msg: string, fn: () => void) => setConfirm({ title, msg, fn });

  const addOffline = () => {
    const name = addName.trim();
    if (!name) return;
    if (!backend) {
      setPlayers((ps) => [...ps, {
        uuid: `mock-${name}`, name, online: false, op: false, whitelisted: true, banned: false,
        lastSeen: '—', playtimeHrs: 0, gamemode: 'Survival',
      }]);
      setAddOpen(false);
      setAddName('');
      pushToast(`${name} added to the whitelist (mock).`, 'ok');
      return;
    }
    void tauriPlayers.addOffline(active.id, name)
      .then(() => {
        setAddOpen(false);
        setAddName('');
        pushToast(`${name} added to the whitelist.`, 'ok');
        void load();
      })
      .catch((err: unknown) => pushToast(errorText(err, 'Could not add the player.'), 'err'));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search players…" className="w-52 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm outline-none focus:border-emerald-500" />
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm">
          {['All', 'Online', 'OP', 'Whitelisted', 'Banned'].map((f) => <option key={f}>{f}</option>)}
        </select>
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : '↻ Refresh'}</Button>
        <div className="ml-auto">
          <Button size="sm" variant="secondary" disabled={!running} title={running ? 'Add an offline player from usercache' : 'Disabled: server is stopped'}
            onClick={() => setAddOpen(true)}>+ Add offline</Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded border border-red-800 bg-red-950/60 px-3 py-2 text-xs text-red-200">{error}</p>
      )}

      {!running && (
        <p className="rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-500">
          Server is {active.status} — the roster is read from disk, and row actions are disabled until it is running.
        </p>
      )}

      {rows.length === 0 && !loading ? (
        <Empty title="No one has joined yet." body="Share your address with a friend, or add a whitelisted player once the server is running." />
      ) : (
        <div className="mc-table overflow-x-auto">
          <table>
            <thead className="bg-zinc-900 text-xs uppercase text-zinc-500">
              <tr><th className="px-3 py-2">Player</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Flags</th><th className="px-3 py-2">Last seen</th><th className="px-3 py-2">Playtime</th><th className="px-3 py-2">Actions</th></tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.uuid || p.name} className="border-t border-zinc-800 hover:bg-zinc-900/60">
                  <td className="px-3 py-2">
                    <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded bg-zinc-700 text-xs font-bold">{p.name[0]}</span>
                    <span className="font-medium">{p.name}</span>
                    <span className="block font-mono text-[10px] text-zinc-600">{p.uuid || 'offline uuid'}</span>
                  </td>
                  <td className="px-3 py-2">{p.online ? <Badge tone="green">online</Badge> : <Badge>offline</Badge>}</td>
                  <td className="px-3 py-2">
                    <span className="flex gap-1">{p.op && <Badge tone="blue">OP</Badge>}{p.whitelisted && <Badge>whitelist</Badge>}{p.banned && <Badge tone="red">banned</Badge>}</span>
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-400">{p.lastSeen}</td>
                  <td className="px-3 py-2 text-xs text-zinc-400">{p.playtimeHrs}h · {p.gamemode}</td>
                  <td className="px-3 py-2">
                    <div className={`flex flex-wrap items-center gap-1 ${running ? '' : 'pointer-events-none opacity-40'}`} title={running ? '' : 'Needs running server'}>
                      <Button size="sm" variant="outline" disabled={!running} onClick={() => ask(`Kick ${p.name}?`, 'The player is disconnected with an optional reason.', () => act('kick', p, 'Kicked by an operator', `${p.name} kicked.`))}>Kick</Button>
                      {p.banned
                        ? <Button size="sm" variant="outline" disabled={!running} onClick={() => ask(`Unban ${p.name}?`, 'They will be allowed to join again.', () => act('unban', p, undefined, `${p.name} unbanned.`))}>Unban</Button>
                        : <Button size="sm" variant="outline" disabled={!running} onClick={() => ask(`Ban ${p.name}?`, 'They will be blocked from joining.', () => act('ban', p, 'Banned by an operator', `${p.name} banned.`))}>Ban</Button>}
                      <Button size="sm" variant="outline" disabled={!running} onClick={() => act(p.op ? 'deop' : 'op', p, undefined, `${p.name} ${p.op ? 'de-opped' : 'opped'}.`)}>{p.op ? 'De-OP' : 'OP'}</Button>
                      <Button size="sm" variant="outline" disabled={!running} onClick={() => act(p.whitelisted ? 'whitelistRemove' : 'whitelistAdd', p, undefined, `${p.name} whitelist ${p.whitelisted ? 'removed' : 'added'}.`)}>Whitelist</Button>
                      <select
                        value={p.gamemode}
                        disabled={!running}
                        onChange={(e) => act('gamemode', p, e.target.value.toLowerCase(), `${p.name} gamemode → ${e.target.value}.`)}
                        className="rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 text-xs"
                        title="Change gamemode"
                      >
                        {p.gamemode === '—' && <option value="—" disabled>—</option>}
                        {['Survival', 'Creative', 'Adventure', 'Spectator'].map((g) => <option key={g}>{g}</option>)}
                      </select>
                      <Button size="sm" variant="ghost" disabled={!running} onClick={() => { setTp(p); setTpTarget(''); }}>TP</Button>
                      <Button size="sm" variant="ghost" disabled={!running} onClick={() => act('heal', p, undefined, `${p.name} healed.`)}>Heal</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={addOpen} title="Add offline player" onClose={() => setAddOpen(false)}>
        <Field label="Minecraft name">
          <input value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="e.g. Notch" className={inputCls} />
        </Field>
        <p className="mt-2 text-xs text-zinc-500">The name is resolved against Mojang, then added to the whitelist while the server is running.</p>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button>
          <Button onClick={addOffline} disabled={!running || !addName.trim()}>Add to whitelist</Button>
        </div>
      </Modal>

      <Modal open={!!tp} title={`Teleport ${tp?.name}`} onClose={() => setTp(null)}>
        <Field label="Target player">
          <input value={tpTarget} onChange={(e) => setTpTarget(e.target.value)} placeholder="Player name" className={inputCls} />
        </Field>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setTp(null)}>Cancel</Button>
          <Button onClick={() => { if (tp) act('teleport', tp, tpTarget.trim(), `${tp.name} teleported.`); setTp(null); }} disabled={!tpTarget.trim()}>Teleport</Button>
        </div>
      </Modal>

      <Confirm open={!!confirm} title={confirm?.title ?? ''} message={<p>{confirm?.msg}</p>}
        onConfirm={() => confirm?.fn()} onClose={() => setConfirm(null)} />
    </div>
  );
}
