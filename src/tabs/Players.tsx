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

/** Actions the backend applies by editing the JSON files while the server is stopped. */
const OFFLINE_ACTIONS = new Set(['whitelistAdd', 'whitelistRemove', 'op', 'deop', 'ban', 'unban']);

interface ConfirmState {
  title: string;
  message: React.ReactNode;
  label: string;
  fn: () => void;
}

interface ReasonState {
  action: 'kick' | 'ban';
  player: Player;
  reason: string;
}

export default function Players() {
  const { active, pushToast } = useStore();
  const backend = hasBackend();
  const [players, setPlayers] = useState<Player[]>(backend ? [] : initialPlayers);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('All');
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [reason, setReason] = useState<ReasonState | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [tp, setTp] = useState<Player | null>(null);
  const [tpTarget, setTpTarget] = useState('');
  const [busy, setBusy] = useState('');

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

  const applyMock = (uuid: string, patch: Partial<Player>, toast: string) => {
    setPlayers((ps) => ps.map((x) => (x.uuid === uuid ? { ...x, ...patch } : x)));
    pushToast(toast, 'ok');
  };

  const mockAct = (action: string, p: Player, value?: string) => {
    if (action === 'kick') applyMock(p.uuid, { online: false, lastSeen: 'just now' }, `${p.name} kicked (mock).`);
    else if (action === 'ban') applyMock(p.uuid, { banned: true, online: false }, `${p.name} banned (mock).`);
    else if (action === 'unban') applyMock(p.uuid, { banned: false }, `${p.name} unbanned (mock).`);
    else if (action === 'op') applyMock(p.uuid, { op: true }, `${p.name} opped (mock).`);
    else if (action === 'deop') applyMock(p.uuid, { op: false }, `${p.name} de-opped (mock).`);
    else if (action === 'whitelistAdd') applyMock(p.uuid, { whitelisted: true }, `${p.name} whitelisted (mock).`);
    else if (action === 'whitelistRemove') applyMock(p.uuid, { whitelisted: false }, `${p.name} removed from whitelist (mock).`);
    else if (action === 'gamemode') applyMock(p.uuid, { gamemode: value ?? 'Survival' }, `${p.name} gamemode → ${value} (mock).`);
    else pushToast(`${action} for ${p.name} (mock).`, 'info');
  };

  const act = async (action: string, p: Player, value?: string, toast?: string) => {
    if (!backend) {
      mockAct(action, p, value);
      return;
    }
    if (!OFFLINE_ACTIONS.has(action) && !running) {
      pushToast('This action needs a running server.', 'err');
      return;
    }
    setBusy(`${p.name}:${action}`);
    try {
      await tauriPlayers.action(active.id, action, p.name, value);
      pushToast(toast ?? `${p.name}: ${action}`, 'ok');
      await load();
    } catch (err) {
      pushToast(errorText(err, 'Player action failed.'), 'err');
    } finally {
      setBusy('');
    }
  };

  const ask = (title: string, message: React.ReactNode, label: string, fn: () => void) => setConfirm({ title, message, label, fn });

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

  const runningOnly = (label: string) => (running ? label : `${label} — needs a running server`);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="Search players" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search players…" className="w-52 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm outline-none focus:border-emerald-500" />
        <select aria-label="Player filter" value={filter} onChange={(e) => setFilter(e.target.value)} className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm">
          {['All', 'Online', 'OP', 'Whitelisted', 'Banned'].map((f) => <option key={f}>{f}</option>)}
        </select>
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : '↻ Refresh'}</Button>
        <div className="ml-auto">
          <Button size="sm" variant="secondary" title="Resolve the name from usercache/Mojang and add it to the whitelist (works stopped or running)"
            onClick={() => setAddOpen(true)}>+ Add offline</Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded border border-red-800 bg-red-950/60 px-3 py-2 text-xs text-red-200">{error}</p>
      )}

      {!running && (
        <p role="status" className="rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-400">
          Server is {active.status} — the roster is read from disk. Whitelist/OP/ban edits are written to the JSON files and apply on the next start;
          kick/gamemode/teleport/heal need a running server.
        </p>
      )}

      {rows.length === 0 && !loading ? (
        <Empty title="No one has joined yet." body="Share your address with a friend, or add a whitelisted player by name (works even while stopped)." />
      ) : (
        <div className="mc-table overflow-x-auto">
          <table aria-label="Players">
            <thead className="bg-zinc-900 text-xs uppercase text-zinc-500">
              <tr><th className="px-3 py-2">Player</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Flags</th><th className="px-3 py-2">Last seen</th><th className="px-3 py-2">Playtime</th><th className="px-3 py-2">Actions</th></tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.uuid || p.name} className="border-t border-zinc-800 hover:bg-zinc-900/60">
                  <td className="px-3 py-2">
                    <span aria-hidden="true" className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded bg-zinc-700 text-xs font-bold">{p.name[0]}</span>
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
                    <div className="flex flex-wrap items-center gap-1" aria-busy={busy.startsWith(`${p.name}:`)}>
                      <Button size="sm" variant="outline" disabled={!running || busy !== ''} title={runningOnly('Kick')}
                        onClick={() => setReason({ action: 'kick', player: p, reason: 'Kicked by an operator' })}>Kick</Button>
                      {p.banned
                        ? <Button size="sm" variant="outline" disabled={busy !== ''} title="Unban (works while stopped)"
                            onClick={() => ask(`Unban ${p.name}?`, <p>They will be allowed to join again. This edits banned-players.json immediately when the server is stopped.</p>, 'Unban', () => void act('unban', p, undefined, `${p.name} unbanned.`))}>Unban</Button>
                        : <Button size="sm" variant="outline" disabled={busy !== ''} title="Ban (works while stopped)"
                            onClick={() => setReason({ action: 'ban', player: p, reason: 'Banned by an operator' })}>Ban</Button>}
                      <Button size="sm" variant="outline" disabled={busy !== ''} title={`${p.op ? 'Remove OP' : 'Grant OP'} (works while stopped)`}
                        onClick={() => ask(`${p.op ? 'De-OP' : 'OP'} ${p.name}?`, <p>{p.op ? 'Removes operator level 4 from ops.json.' : 'Grants operator level 4 in ops.json.'} Applies on the next start when stopped.</p>, p.op ? 'De-OP' : 'OP', () => void act(p.op ? 'deop' : 'op', p, undefined, `${p.name} ${p.op ? 'de-opped' : 'opped'}.`))}>{p.op ? 'De-OP' : 'OP'}</Button>
                      <Button size="sm" variant="outline" disabled={busy !== ''} title={`Whitelist (works while stopped)`}
                        onClick={() => ask(`${p.whitelisted ? 'Remove' : 'Add'} ${p.name} ${p.whitelisted ? 'from' : 'to'} the whitelist?`, <p>Edits whitelist.json immediately when stopped; uses the console while running.</p>, p.whitelisted ? 'Remove' : 'Add', () => void act(p.whitelisted ? 'whitelistRemove' : 'whitelistAdd', p, undefined, `${p.name} whitelist ${p.whitelisted ? 'removed' : 'added'}.`))}>Whitelist</Button>
                      <select
                        value={p.gamemode}
                        disabled={!running || busy !== ''}
                        onChange={(e) => {
                          const next = e.target.value;
                          ask(`Set ${p.name} to ${next}?`, <p>Sends the gamemode command to the running server.</p>, 'Set gamemode', () => void act('gamemode', p, next.toLowerCase(), `${p.name} gamemode → ${next}.`));
                        }}
                        className="rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 text-xs disabled:opacity-40"
                        title={runningOnly('Change gamemode')}
                        aria-label={`Gamemode for ${p.name}`}
                      >
                        {p.gamemode === '—' && <option value="—" disabled>—</option>}
                        {['Survival', 'Creative', 'Adventure', 'Spectator'].map((g) => <option key={g}>{g}</option>)}
                      </select>
                      <Button size="sm" variant="ghost" disabled={!running || busy !== ''} title={runningOnly('Teleport')}
                        onClick={() => { setTp(p); setTpTarget(''); }}>TP</Button>
                      <Button size="sm" variant="ghost" disabled={!running || busy !== ''} title={runningOnly('Heal')}
                        onClick={() => ask(`Heal ${p.name}?`, <p>Grants instant health on the running server.</p>, 'Heal', () => void act('heal', p, undefined, `${p.name} healed.`))}>Heal</Button>
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
        <p className="mt-2 text-xs text-zinc-500">The name is resolved from usercache.json first, then Mojang. It is added to whitelist.json when the server is stopped, or via the console while running.</p>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button>
          <Button onClick={addOffline} disabled={!addName.trim()}>Add to whitelist</Button>
        </div>
      </Modal>

      <Modal open={!!reason} title={reason ? `${reason.action === 'kick' ? 'Kick' : 'Ban'} ${reason.player.name}` : ''} onClose={() => setReason(null)}>
        <Field label={reason?.action === 'kick' ? 'Kick reason' : 'Ban reason'}>
          <input value={reason?.reason ?? ''} onChange={(e) => setReason((current) => (current ? { ...current, reason: e.target.value } : current))} className={inputCls} />
        </Field>
        <p className="mt-2 text-xs text-zinc-500">{reason?.action === 'kick' ? 'The player is disconnected with this reason.' : 'The player is blocked with this reason; while stopped the ban is written to banned-players.json.'}</p>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setReason(null)}>Cancel</Button>
          <Button
            onClick={() => {
              if (!reason) return;
              const { action, player, reason: text } = reason;
              setReason(null);
              void act(action, player, text, `${player.name} ${action === 'kick' ? 'kicked' : 'banned'}.`);
            }}
          >{reason?.action === 'kick' ? 'Kick player' : 'Ban player'}</Button>
        </div>
      </Modal>

      <Modal open={!!tp} title={`Teleport ${tp?.name}`} onClose={() => setTp(null)}>
        <Field label="Target player">
          <input value={tpTarget} onChange={(e) => setTpTarget(e.target.value)} placeholder="Player name" className={inputCls} />
        </Field>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setTp(null)}>Cancel</Button>
          <Button onClick={() => { if (tp) void act('teleport', tp, tpTarget.trim(), `${tp.name} teleported.`); setTp(null); }} disabled={!tpTarget.trim()}>Teleport</Button>
        </div>
      </Modal>

      <Confirm
        open={!!confirm}
        title={confirm?.title ?? ''}
        message={confirm?.message}
        confirmLabel={confirm?.label ?? 'Confirm'}
        onConfirm={() => confirm?.fn()}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}
