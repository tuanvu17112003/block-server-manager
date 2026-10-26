// Service-level suite for WP-5.4 players/metrics (M-06/M-13/M-20/M-21).
// Runs inside Electron via `--servicestest` (registered by the Lead in service-runner.ts) against a
// throwaway data root: no real servers, no PowerShell sampling, no Mojang network calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TestRun } from '../harness';
import { withHarness } from '../service-harness';
import { Players, type PlayerDto } from '../../services/players';
import type { ServerProcesses } from '../../services/server-process';

const STEVE = { uuid: '11111111222233334444555555555555', name: 'Steve' };
const ALEX = { uuid: '66666666777788889999000000000000', name: 'Alex' };
const HEROBRINE = { uuid: 'aaaaaaaaaaaabbbbccccdddddddddddd', name: 'Herobrine' };
const NOTCH = { uuid: '0123456789abcdef0123456789abcdef', name: 'Notch' };

const FORGE = '[26Oct2026 13:02:43.381] [Server thread/INFO] [net.minecraft.server.dedicated.DedicatedServer/]: ';

function dashed(uuid: string): string {
  // Idempotent: JSON files already store dashed UUIDs; only expand the undashed 32-hex form.
  if (uuid.includes('-')) return uuid.toLowerCase();
  return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function isCode(code: string) {
  return (error: unknown): boolean => (error as { code?: string }).code === code;
}

/** Minimal `ServerProcesses` stand-in for the ring-saturation behaviors (no child process involved). */
function fakeProcesses(replies: { lineSeq: number; entries: { seq: number; text: string }[] }): ServerProcesses {
  return {
    status: () => 'running',
    lineSeq: () => replies.lineSeq,
    entriesSince: (_id: string, fromSeq: number) => replies.entries.filter((entry) => entry.seq > fromSeq),
    command: () => { /* console write no-op */ },
    history: () => [],
    pid: () => 4242,
    startedAt: () => Date.now(),
  } as unknown as ServerProcesses;
}

export async function runPlayersMetricsSuite(run: TestRun): Promise<void> {
  await withHarness(run, async (h) => {
    const created = await h.createServer({
      name: 'Players Metrics Suite', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 2048,
    } as never);
    const dir = h.scaffoldServer(created.id); // server.properties has max-players=10, store DTO has 20

    // Roster fixtures: usercache + one of each JSON file, plus one log containing every format.
    writeJson(path.join(dir, 'usercache.json'), [
      { name: STEVE.name, uuid: STEVE.uuid, expiresOn: '2027-01-01 00:00:00 +0000' },
      { name: ALEX.name, uuid: ALEX.uuid, expiresOn: '2027-01-01 00:00:00 +0000' },
      { name: HEROBRINE.name, uuid: HEROBRINE.uuid, expiresOn: '2027-01-01 00:00:00 +0000' },
      { name: NOTCH.name, uuid: NOTCH.uuid, expiresOn: '2027-01-01 00:00:00 +0000' },
    ]);
    writeJson(path.join(dir, 'whitelist.json'), [{ uuid: dashed(STEVE.uuid), name: STEVE.name }]);
    writeJson(path.join(dir, 'ops.json'), [
      { uuid: dashed(ALEX.uuid), name: ALEX.name, level: 3, bypassesPlayerLimit: false, customField: 'keep-me' },
    ]);
    writeJson(path.join(dir, 'banned-players.json'), [
      { uuid: dashed(HEROBRINE.uuid), name: HEROBRINE.name, created: '2026-01-01T00:00:00.000Z', source: 'Server', expires: 'forever', reason: 'test' },
    ]);
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'logs', 'latest.log'), [
      '[10:00:00] [Server thread/INFO]: Steve joined the game',
      '[11:30:00] [Server thread/INFO]: Steve left the game',
      `${FORGE}Alex joined the game`,
      `${FORGE.replace('13:02:43', '13:12:43')}Alex left the game`,
      '[13:02:43 INFO]: Herobrine joined the game',
      '[13:03:43 INFO]: Herobrine left the game',
      '[13:04:00] [Server thread/INFO]: Starting minecraft server version 1.21.1',
    ].join('\n'), 'utf8');

    const roster = (): Promise<{ players: PlayerDto[]; running: boolean; maxPlayers: number }> =>
      h.invoke('players_list', { id: created.id });
    const action = (actionName: string, name: string, value?: string): Promise<PlayerDto | true> =>
      h.invoke('player_action', { id: created.id, action: actionName, name, value });
    const byName = (players: PlayerDto[], name: string): PlayerDto | undefined =>
      players.find((player) => player.name.toLowerCase() === name.toLowerCase());

    await run.must('players_list: disk roster, log formats and server.properties maxPlayers (M-06/M-21)', async () => {
      const list = await roster();
      assert.equal(list.running, false);
      assert.equal(list.maxPlayers, 10, 'server.properties max-players=10 must win over the stale store default 20');
      const steve = byName(list.players, 'Steve');
      const alex = byName(list.players, 'Alex');
      const herobrine = byName(list.players, 'Herobrine');
      assert.ok(steve && alex && herobrine, 'all user/roster players must appear');
      assert.equal(steve?.whitelisted, true);
      assert.equal(steve?.online, false);
      assert.equal(steve?.playtimeHrs, 1.5); // vanilla start/end pair
      assert.equal(steve?.lastSeen, '11:30:00');
      assert.equal(alex?.op, true);
      assert.equal(alex?.playtimeHrs, 0.2); // Forge pair: 10 minutes, rounded to 0.1
      assert.equal(alex?.lastSeen, '13:12:43');
      assert.equal(herobrine?.banned, true);
      assert.equal(herobrine?.lastSeen, '13:03:43'); // Paper pair
      assert.equal(byName(list.players, 'Notch')?.uuid, dashed(NOTCH.uuid)); // usercache UUID formatting
    });

    await run.must('player_action whitelistAdd: works while stopped, atomic and idempotent', async () => {
      const added = await action('whitelistAdd', 'Notch');
      assert.ok(typeof added === 'object' && added !== null, 'offline action must return the updated PlayerDto');
      assert.equal(added.whitelisted, true);
      assert.equal(added.uuid, dashed(NOTCH.uuid));
      const file = path.join(dir, 'whitelist.json');
      let entries = readJson<{ uuid: string; name: string }[]>(file);
      assert.equal(entries.filter((entry) => entry.name === 'Notch').length, 1);
      // Idempotent: a second add must not duplicate the entry.
      await action('whitelistAdd', 'Notch');
      entries = readJson<{ uuid: string; name: string }[]>(file);
      assert.equal(entries.filter((entry) => entry.name === 'Notch').length, 1);
      assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0, 'no temp file may be left');
    });

    await run.must('player_action op/deop: stopped edits preserve existing fields', async () => {
      const opped = await action('op', 'Steve');
      assert.ok(typeof opped === 'object' && opped !== null);
      assert.equal(opped.op, true);
      assert.equal(opped.uuid, dashed(STEVE.uuid));
      let ops = readJson<Record<string, unknown>[]>(path.join(dir, 'ops.json'));
      const steveEntry = ops.find((entry) => entry.name === 'Steve');
      assert.equal(steveEntry?.level, 4);
      assert.equal(steveEntry?.bypassesPlayerLimit, false);
      const alexEntry = ops.find((entry) => entry.name === 'Alex');
      assert.equal(alexEntry?.level, 3, 'existing op level must be preserved');
      assert.equal(alexEntry?.customField, 'keep-me', 'unknown fields must be preserved');
      await action('deop', 'Steve');
      ops = readJson<Record<string, unknown>[]>(path.join(dir, 'ops.json'));
      assert.equal(ops.some((entry) => entry.name === 'Steve'), false);
    });

    await run.must('player_action ban/unban: stopped JSON edits keep the vanilla record shape', async () => {
      const banned = await action('ban', 'Notch', 'griefing');
      assert.ok(typeof banned === 'object' && banned !== null);
      assert.equal(banned.banned, true);
      let entries = readJson<Record<string, unknown>[]>(path.join(dir, 'banned-players.json'));
      const notchEntry = entries.find((entry) => entry.name === 'Notch');
      assert.ok(notchEntry, 'banned-players.json must contain the banned player');
      assert.equal(notchEntry.reason, 'griefing');
      assert.equal(notchEntry.expires, 'forever');
      assert.equal(notchEntry.source, 'Block Server Manager');
      assert.ok(!Number.isNaN(Date.parse(String(notchEntry.created))), 'created must be an ISO timestamp');
      assert.equal(dashed(String(notchEntry.uuid)), dashed(NOTCH.uuid));
      await action('unban', 'Notch');
      entries = readJson<Record<string, unknown>[]>(path.join(dir, 'banned-players.json'));
      assert.equal(entries.some((entry) => entry.name === 'Notch'), false);
    });

    await run.must('player_action whitelistRemove works while stopped (no Mojang lookup needed)', async () => {
      const removed = await action('whitelistRemove', 'Steve');
      assert.ok(typeof removed === 'object' && removed !== null);
      assert.equal(removed.whitelisted, false);
      const entries = readJson<{ name?: string }[]>(path.join(dir, 'whitelist.json'));
      assert.equal(entries.some((entry) => entry.name === 'Steve'), false);
    });

    await run.must('player_action: kick/gamemode/teleport/heal still require a running server', async () => {
      for (const [actionName, value] of [['kick', undefined], ['gamemode', 'creative'], ['teleport', 'Alex'], ['heal', undefined]] as const) {
        await assert.rejects(() => action(actionName, 'Steve', value), isCode('conflict'), `${actionName} must be conflict while stopped`);
      }
      await assert.rejects(() => action('does-not-exist', 'Steve'), isCode('validation'));
    });

    await run.must('players_add_offline: stopped add via usercache, canonical name + DTO', async () => {
      const added = await h.invoke<PlayerDto>('players_add_offline', { id: created.id, name: 'notch' });
      assert.equal(added.name, 'Notch', 'usercache casing must be used');
      assert.equal(added.uuid, dashed(NOTCH.uuid));
      assert.equal(added.whitelisted, true);
      const entries = readJson<{ name: string }[]>(path.join(dir, 'whitelist.json'));
      assert.equal(entries.filter((entry) => entry.name.toLowerCase() === 'notch').length, 1);
    });

    await run.must('players_list: unknown server id is not-found', async () => {
      await assert.rejects(() => h.invoke('players_list', { id: 'missing' }), isCode('not-found'));
    });

    await run.must('players.list: ring-saturated console (seq baseline) still finds the list reply fast (M-20)', async () => {
      const processes = fakeProcesses({
        lineSeq: 5_000,
        entries: [{ seq: 5_001, text: '[10:00:00] [Server thread/INFO]: There are 1 of a max of 20 players online: Steve' }],
      });
      const direct = new Players(h.ctx, processes);
      const started = Date.now();
      const list = await direct.list(created.id);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 1_000, `ring-safe list reply must resolve quickly (took ${elapsed}ms)`);
      assert.equal(list.players.find((player) => player.name === 'Steve')?.online, true);
      assert.equal(list.maxPlayers, 10);
    });

    await run.must('players.list: no reply still resolves within the ~2s budget (never hangs)', async () => {
      const direct = new Players(h.ctx, fakeProcesses({ lineSeq: 9_000, entries: [] }));
      const started = Date.now();
      const list = await direct.list(created.id);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 3_000, `list must fall back to the disk roster within the timeout (took ${elapsed}ms)`);
      assert.equal(list.running, true);
      assert.equal(list.players.some((player) => player.online), false);
    });

    await run.must('metrics_get: validates hours as an integer 1..168 (M-13)', async () => {
      for (const hours of [0, 1.5, 169, Number.NaN, -3, 1000]) {
        await assert.rejects(
          () => h.invoke('metrics_get', { id: created.id, hours }),
          isCode('validation'),
          `hours=${String(hours)} must be rejected`,
        );
      }
      const valid = await h.invoke<{ samples: unknown[]; disk: { freeBytes: number; totalBytes: number }; current: unknown }>(
        'metrics_get', { id: created.id, hours: 1 },
      );
      assert.deepEqual(valid.samples, []);
      assert.equal(valid.current, null);
      assert.equal(typeof valid.disk.freeBytes, 'number');
      assert.equal(typeof valid.disk.totalBytes, 'number');
    });

    await run.must('metrics_get: history is filtered by hours and 7-day retention, corrupt files tolerated', async () => {
      const historyServer = await h.createServer({ name: 'Metrics History Suite', loader: 'Paper', mcVersion: '1.21.1', ramMb: 4096 } as never);
      h.scaffoldServer(historyServer.id);
      const metricsDir = path.join(h.dataRoot, 'metrics');
      fs.mkdirSync(metricsDir, { recursive: true });
      const now = Date.now();
      const bucket = (minutesAgo: number, cpuPct: number): Record<string, unknown> => ({
        at: new Date(now - minutesAgo * 60_000).toISOString(),
        cpuPct, memoryMb: 512, ramPct: 12.5, players: 1, tps: 20, mspt: null,
      });
      writeJson(path.join(metricsDir, `${historyServer.id}.json`), [
        bucket(8 * 24 * 60, 1), bucket(120, 2), bucket(10, 3),
      ]);
      const oneHour = await h.invoke<{ samples: { cpuPct: number }[] }>('metrics_get', { id: historyServer.id, hours: 1 });
      assert.deepEqual(oneHour.samples.map((sample) => sample.cpuPct), [3]);
      const sixHours = await h.invoke<{ samples: { cpuPct: number }[] }>('metrics_get', { id: historyServer.id, hours: 6 });
      assert.deepEqual(sixHours.samples.map((sample) => sample.cpuPct), [2, 3]);
      const week = await h.invoke<{ samples: { cpuPct: number }[]; current: { cpuPct: number } | null }>(
        'metrics_get', { id: historyServer.id, hours: 168 },
      );
      assert.deepEqual(week.samples.map((sample) => sample.cpuPct), [2, 3], 'older-than-7d rows are pruned on load');
      assert.equal(week.current?.cpuPct, 3);

      const corruptServer = await h.createServer({ name: 'Metrics Corrupt Suite', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024 } as never);
      fs.writeFileSync(path.join(metricsDir, `${corruptServer.id}.json`), '{not json', 'utf8');
      const corrupt = await h.invoke<{ samples: unknown[] }>('metrics_get', { id: corruptServer.id, hours: 1 });
      assert.deepEqual(corrupt.samples, []);
    });
  });
}
