import { useState } from 'react';
import { initialPlayers } from '../mocks/data';
import type { Player } from '../types';
import { useStore } from '../store';
import { Badge, Button, Confirm, Empty } from '../components/ui';

export default function Players() {
  const { active, pushToast } = useStore();
  const [players, setPlayers] = useState<Player[]>(initialPlayers);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('All');
  const [confirm, setConfirm] = useState<{ title: string; msg: string; fn: () => void } | null>(null);

  const running = active.status === 'running';
  const rows = players.filter((p) => {
    if (q && !p.name.toLowerCase().includes(q.toLowerCase())) return false;
    if (filter === 'Online') return p.online;
    if (filter === 'OP') return p.op;
    if (filter === 'Whitelisted') return p.whitelisted;
    if (filter === 'Banned') return p.banned;
    return true;
  });

  const ask = (title: string, msg: string, fn: () => void) => setConfirm({ title, msg, fn });
  const patch = (uuid: string, p: Partial<Player>, toast: string) => {
    setPlayers((ps) => ps.map((x) => (x.uuid === uuid ? { ...x, ...p } : x)));
    pushToast(toast, 'ok');
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search players…" className="w-52 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm outline-none focus:border-emerald-500" />
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm">
          {['All', 'Online', 'OP', 'Whitelisted', 'Banned'].map((f) => <option key={f}>{f}</option>)}
        </select>
        <Button size="sm" variant="outline" onClick={() => pushToast('Player list refreshed (mock).', 'info')}>↻ Refresh</Button>
        <div className="ml-auto">
          <Button size="sm" variant="secondary" disabled={!running} title={running ? 'Add an offline player from usercache' : 'Disabled: server is stopped'}
            onClick={() => pushToast('Add-offline via usercache (mock).', 'info')}>+ Add offline</Button>
        </div>
      </div>

      {!running && (
        <p className="rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-500">
          Server is {active.status} — row actions are disabled until it is running.
        </p>
      )}

      {rows.length === 0 ? (
        <Empty title="No one has joined yet." body="Share your address with a friend, or check back after first join." />
      ) : (
        <div className="mc-table overflow-x-auto">
          <table>
            <thead className="bg-zinc-900 text-xs uppercase text-zinc-500">
              <tr><th className="px-3 py-2">Player</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Flags</th><th className="px-3 py-2">Last seen</th><th className="px-3 py-2">Playtime</th><th className="px-3 py-2">Actions</th></tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.uuid} className="border-t border-zinc-800 hover:bg-zinc-900/60">
                  <td className="px-3 py-2">
                    <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded bg-zinc-700 text-xs font-bold">{p.name[0]}</span>
                    <span className="font-medium">{p.name}</span>
                    <span className="block font-mono text-[10px] text-zinc-600">{p.uuid}</span>
                  </td>
                  <td className="px-3 py-2">{p.online ? <Badge tone="green">online</Badge> : <Badge>offline</Badge>}</td>
                  <td className="px-3 py-2">
                    <span className="flex gap-1">{p.op && <Badge tone="blue">OP</Badge>}{p.whitelisted && <Badge>whitelist</Badge>}{p.banned && <Badge tone="red">banned</Badge>}</span>
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-400">{p.lastSeen}</td>
                  <td className="px-3 py-2 text-xs text-zinc-400">{p.playtimeHrs}h · {p.gamemode}</td>
                  <td className="px-3 py-2">
                    <div className={`flex flex-wrap gap-1 ${running ? '' : 'pointer-events-none opacity-40'}`} title={running ? '' : 'Needs running server'}>
                      <Button size="sm" variant="outline" disabled={!running} onClick={() => ask(`Kick ${p.name}?`, 'The player is disconnected with an optional reason.', () => patch(p.uuid, { online: false, lastSeen: 'just now' }, `${p.name} kicked (mock).`))}>Kick</Button>
                      {p.banned
                        ? <Button size="sm" variant="outline" disabled={!running} onClick={() => ask(`Unban ${p.name}?`, 'They will be allowed to join again.', () => patch(p.uuid, { banned: false }, `${p.name} unbanned (mock).`))}>Unban</Button>
                        : <Button size="sm" variant="outline" disabled={!running} onClick={() => ask(`Ban ${p.name}?`, 'They will be blocked from joining.', () => patch(p.uuid, { banned: true, online: false }, `${p.name} banned (mock).`))}>Ban</Button>}
                      <Button size="sm" variant="outline" disabled={!running} onClick={() => patch(p.uuid, { op: !p.op }, `${p.name} ${p.op ? 'de-opped' : 'opped'} (mock).`)}>{p.op ? 'De-OP' : 'OP'}</Button>
                      <Button size="sm" variant="outline" disabled={!running} onClick={() => patch(p.uuid, { whitelisted: !p.whitelisted }, `${p.name} whitelist ${p.whitelisted ? 'removed' : 'added'} (mock).`)}>Whitelist</Button>
                      <Button size="sm" variant="ghost" disabled={!running} onClick={() => pushToast(`Teleport/Heal/Gamemode for ${p.name} (mock).`, 'info')}>⋯</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Confirm open={!!confirm} title={confirm?.title ?? ''} message={<p>{confirm?.msg}</p>}
        onConfirm={() => confirm?.fn()} onClose={() => setConfirm(null)} />
    </div>
  );
}
