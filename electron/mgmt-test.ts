// Headless smoke gate for the management services (no window, temp data root).
// Run with `electron . --mgmttest`; exits non-zero on the first failed assertion.
import fs from 'node:fs';
import path from 'node:path';
import { handlersMap, registerRuntimeHandlers, type IpcContext } from './ipc';
import { buildRuntime } from './services/runtime';

interface Check { name: string; ok: boolean; detail?: string }

export async function runMgmtTest(root: string): Promise<boolean> {
  const ctx: IpcContext = { dataRoot: root, send: () => undefined, getWindow: () => null };
  const runtime = buildRuntime();
  registerRuntimeHandlers(runtime.register(ctx).handlers);
  const h = handlersMap();
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string): void => { checks.push({ name, ok, detail }); };
  const must = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
    try { await fn(); check(name, true); }
    catch (error) { check(name, false, error instanceof Error ? error.message : String(error)); }
  };

  let serverId = '';
  try {
    const created = await h.servers_create({
      input: { name: 'mgmt-' + Date.now(), loader: 'Vanilla', mcVersion: '1.20.4', ramMb: 2048 },
    }, ctx) as { id: string };
    serverId = created.id;
    check('create', typeof serverId === 'string' && serverId.length > 0);
    const dir = path.join(root, 'servers', serverId);
    fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'dummy-level');

    await must('settings-update', async () => {
      await h.server_settings_update({
        id: serverId,
        values: {
          motd: 'hello', 'max-players': '30', difficulty: 'hard', gamemode: 'creative',
          'server-port': '25570', 'online-mode': 'false', 'level-name': 'world',
        },
        name: 'Renamed server', ramMb: 3072, eulaAccepted: true,
      }, ctx);
    });
    await must('settings-read', async () => {
      const settings = await h.server_settings_get({ id: serverId }, ctx) as {
        eulaAccepted: boolean; values: Record<string, string>; entries: unknown[];
      };
      if (!settings.eulaAccepted) throw new Error('eula.txt missing');
      if (settings.values['motd'] !== 'hello') throw new Error('motd not persisted');
      if (settings.values['max-players'] !== '30') throw new Error('max-players not persisted');
      if (settings.entries.length < 5) throw new Error('entries not parsed');
      if (!fs.existsSync(path.join(root, 'servers', serverId, 'eula.txt'))) throw new Error('eula file missing');
    });
    await must('servers-list-enriched', async () => {
      const list = await h.servers_list({}, ctx) as { id: string; name: string; motd?: string; maxPlayers?: number; difficulty?: string; ramMb: number; eulaAccepted: boolean }[];
      const row = list.find((entry) => entry.id === serverId);
      if (!row) throw new Error('server missing from list');
      if (row.motd !== 'hello' || row.maxPlayers !== 30 || row.difficulty !== 'Hard') throw new Error('settings not hydrated');
      if (row.ramMb !== 3072 || !row.eulaAccepted || row.name !== 'Renamed server') throw new Error('record fields not updated');
    });
    await must('worlds-list', async () => {
      const worlds = await h.worlds_list({ id: serverId }, ctx) as { name: string; active: boolean }[];
      if (worlds.length !== 1 || worlds[0]!.name !== 'world' || !worlds[0]!.active) throw new Error(JSON.stringify(worlds));
    });
    await must('backup-create', async () => {
      const backup = await h.backup_create({ id: serverId, name: 't1' }, ctx) as { id: string; path: string };
      if (!fs.existsSync(backup.path)) throw new Error('archive missing');
      const list = await h.backups_list({ id: serverId }, ctx) as { id: string }[];
      if (list.length !== 1 || list[0]!.id !== backup.id) throw new Error('index not recorded');
    });
    await must('backup-restore', async () => {
      const before = await h.server_settings_get({ id: serverId }, ctx) as { values: Record<string, string> };
      const list = await h.backups_list({ id: serverId }, ctx) as { id: string }[];
      await h.server_settings_update({ id: serverId, values: { motd: 'changed' } }, ctx);
      await h.backup_restore({ id: serverId, backupId: list[0]!.id, mode: 'in-place' }, ctx);
      const after = await h.server_settings_get({ id: serverId }, ctx) as { values: Record<string, string> };
      if (before.values['motd'] !== 'hello') throw new Error('baseline motd wrong');
      if (after.values['motd'] !== 'hello') throw new Error(`restore did not bring motd back: ${after.values['motd']}`);
    });
    await must('world-duplicate', async () => {
      const copy = await h.world_duplicate({ id: serverId, name: 'world' }, ctx) as { name: string };
      const worlds = await h.worlds_list({ id: serverId }, ctx) as { name: string }[];
      if (!worlds.some((entry) => entry.name === copy.name)) throw new Error('copy missing');
    });
    await must('world-delete', async () => {
      const worlds = await h.worlds_list({ id: serverId }, ctx) as { name: string; active: boolean }[];
      const copy = worlds.find((entry) => !entry.active)!;
      await h.world_delete({ id: serverId, name: copy.name }, ctx);
      const after = await h.worlds_list({ id: serverId }, ctx) as { name: string }[];
      if (after.some((entry) => entry.name === copy.name)) throw new Error('delete did not remove the copy');
    });
    await must('world-create-pending', async () => {
      const pending = await h.world_create({ id: serverId, name: 'newworld', seed: '42', levelType: 'minecraft:flat' }, ctx) as { pending?: boolean };
      if (!pending.pending) throw new Error('pending flag missing');
      const worlds = await h.worlds_list({ id: serverId }, ctx) as { name: string; pending?: boolean }[];
      if (!worlds.some((entry) => entry.name === 'newworld' && entry.pending)) throw new Error('pending world not listed');
    });
    await must('content-list-toggle-remove', async () => {
      fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'mods', 'example.jar'), 'dummy-jar');
      const listed = await h.content_list({ id: serverId }, ctx) as { fileName: string; enabled: boolean }[];
      if (listed.length !== 1 || listed[0]!.fileName !== 'example.jar' || !listed[0]!.enabled) throw new Error(JSON.stringify(listed));
      const disabled = await h.content_toggle({ id: serverId, fileName: 'example.jar', enabled: false }, ctx) as { enabled: boolean }[];
      if (disabled[0]!.enabled) throw new Error('disable did not rename');
      if (!fs.existsSync(path.join(dir, 'mods-disabled', 'example.jar'))) throw new Error('disabled file missing');
      const enabled = await h.content_toggle({ id: serverId, fileName: 'example.jar', enabled: true }, ctx) as { enabled: boolean }[];
      if (!enabled[0]!.enabled) throw new Error('enable did not rename');
      const removed = await h.content_remove({ id: serverId, fileName: 'example.jar' }, ctx) as unknown[];
      if (removed.length !== 0) throw new Error('remove left a row');
      if (fs.existsSync(path.join(dir, 'mods', 'example.jar'))) throw new Error('jar not removed');
    });
    await must('settings-validation', async () => {
      let code = '';
      try { await h.server_settings_update({ id: serverId, values: { 'max-players': '9999' } }, ctx); }
      catch (error) { code = (error as { code?: string }).code ?? ''; }
      if (code !== 'validation') throw new Error(`unexpected code ${code}`);
    });
    await must('players-list-stopped', async () => {
      const result = await h.players_list({ id: serverId }, ctx) as { running: boolean; players: unknown[] };
      if (result.running) throw new Error('server should be stopped');
      if (!Array.isArray(result.players)) throw new Error('players missing');
    });
    await must('metrics-history', async () => {
      const result = await h.metrics_get({ id: serverId, hours: 1 }, ctx) as { samples: unknown[]; disk: { totalBytes: number } };
      if (!Array.isArray(result.samples)) throw new Error('samples missing');
      if (result.disk.totalBytes <= 0) throw new Error('disk probe failed');
    });
    await must('backup-delete', async () => {
      const list = await h.backups_list({ id: serverId }, ctx) as { id: string; path: string }[];
      const target = list[0]!;
      await h.backup_delete({ backupId: target.id }, ctx);
      if (fs.existsSync(target.path)) throw new Error('archive not removed');
      const after = await h.backups_list({ id: serverId }, ctx) as { id: string }[];
      if (after.some((entry) => entry.id === target.id)) throw new Error('row not removed');
    });
    await must('error-contract', async () => {
      let code = '';
      try { await h.backup_restore({ id: serverId, backupId: 'missing' }, ctx); } catch (error) {
        code = (error as { code?: string }).code ?? '';
      }
      if (code !== 'not-found') throw new Error(`unexpected code ${code}`);
    });
    await must('server-delete-cleans-disk', async () => {
      const created = await h.servers_create({
        input: { name: 'delete-' + Date.now(), loader: 'Vanilla', mcVersion: '1.20.4', ramMb: 1024 },
      }, ctx) as { id: string };
      const target = path.join(root, 'servers', created.id);
      fs.mkdirSync(target, { recursive: true });
      await h.servers_delete({ id: created.id }, ctx);
      if (fs.existsSync(target)) throw new Error('server folder left behind');
      const list = await h.servers_list({}, ctx) as { id: string }[];
      if (list.some((entry) => entry.id === created.id)) throw new Error('record left behind');
    });
    // ---- Phase 5 granular regression checks (audit M-01/M-03/M-04/M-05/M-12/M-18/M-20/M-21/M-22) ----
    const p5 = await h.servers_create({
      input: { name: 'mgmt-p5-' + Date.now(), loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 2048 },
    }, ctx) as { id: string };
    const p5dir = path.join(root, 'servers', p5.id);
    fs.mkdirSync(path.join(p5dir, 'world'), { recursive: true });
    fs.writeFileSync(path.join(p5dir, 'world', 'level.dat'), 'dummy-level');
    await h.server_settings_update({ id: p5.id, values: { motd: 'p5', 'server-port': '25571' }, eulaAccepted: true }, ctx);

    await must('schedule-invalid-interval', async () => {
      let code = '';
      try { await h.backup_schedule_set({ id: p5.id, interval: 'every-second' }, ctx); }
      catch (error) { code = (error as { code?: string }).code ?? ''; }
      if (code !== 'validation') throw new Error(`unexpected code ${code}`);
    });
    await must('schedule-valid-clamps-maxkept', async () => {
      const saved = await h.backup_schedule_set({ id: p5.id, auto: true, interval: 'Daily', maxKept: 999 }, ctx) as { maxKept: number };
      if (saved.maxKept > 50 || saved.maxKept < 1) throw new Error(`maxKept not clamped: ${saved.maxKept}`);
    });
    await must('backup-retention-maxkept', async () => {
      await h.backup_schedule_set({ id: p5.id, auto: true, interval: 'Daily', maxKept: 2 }, ctx);
      for (let index = 0; index < 4; index += 1) await h.backup_create({ id: p5.id, name: `ret-${index}` }, ctx);
      const rows = await h.backups_list({ id: p5.id }, ctx) as { kind: string }[];
      const manualAuto = rows.filter((row) => row.kind === 'Manual' || row.kind === 'Auto').length;
      if (manualAuto > 2) throw new Error(`retention kept ${manualAuto} manual/auto archives (max 2)`);
    });
    await must('backup-shutdown-during-accepted', async () => {
      const row = await h.backup_create({ id: p5.id, name: 'shutdown-during', shutdownDuring: true }, ctx) as { id: string };
      if (!row?.id) throw new Error('backup row missing');
    });

    await must('eula-file-false-overrides-true-flag', async () => {
      fs.writeFileSync(path.join(p5dir, 'eula.txt'), 'eula=false\n');
      const settings = await h.server_settings_get({ id: p5.id }, ctx) as { eulaAccepted: boolean };
      if (settings.eulaAccepted) throw new Error('stale flag granted EULA consent');
      await h.server_settings_update({ id: p5.id, values: {}, eulaAccepted: true }, ctx);
    });
    await must('properties-escape-roundtrip', async () => {
      await h.server_settings_update({ id: p5.id, values: { motd: '§aHello\\nWorld' } }, ctx);
      const settings = await h.server_settings_get({ id: p5.id }, ctx) as { values: Record<string, string> };
      if (settings.values['motd'] !== '§aHello\\nWorld') throw new Error(`motd round-trip failed: ${JSON.stringify(settings.values['motd'])}`);
    });

    // World unit behaviour: dimensions travel with duplicate; delete safety archives the deleted world.
    await must('world-duplicate-copies-dimensions', async () => {
      fs.mkdirSync(path.join(p5dir, 'world_nether'), { recursive: true });
      fs.writeFileSync(path.join(p5dir, 'world_nether', 'level.dat'), 'nether-level');
      const copy = await h.world_duplicate({ id: p5.id, name: 'world' }, ctx) as { name: string };
      if (!fs.existsSync(path.join(p5dir, copy.name, 'level.dat'))) throw new Error('duplicate world dir missing');
      if (!fs.existsSync(path.join(p5dir, `${copy.name}_nether`, 'level.dat'))) throw new Error('duplicate did not copy nether dimension');
    });
    await must('world-delete-archives-deleted-world', async () => {
      const worlds = await h.worlds_list({ id: p5.id }, ctx) as { name: string; active: boolean }[];
      const target = worlds.find((row) => !row.active && row.name !== 'newworld');
      if (!target) throw new Error('no inactive world to delete');
      await h.world_delete({ id: p5.id, name: target.name }, ctx);
      const rows = await h.backups_list({ id: p5.id }, ctx) as { kind: string; name: string }[];
      const safety = rows.filter((row) => row.kind === 'World-delete');
      if (safety.length === 0) throw new Error('no World-delete safety archive recorded');
    });

    // Offline player management (M-20/M-21): roster files, log formats, stopped actions.
    await must('players-offline-roster-and-log-formats', async () => {
      fs.mkdirSync(path.join(p5dir, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(p5dir, 'logs', 'latest.log'), [
        '[12:00:01] [Server thread/INFO]: Steve joined the game',
        '[12:05:01] [Server thread/INFO]: Steve left the game',
        '[26Oct2026 13:00:00.123] [Server thread/INFO] [minecraft/DedicatedServer]: Alex joined the game',
        '[13:10:00 INFO]: Alex left the game',
      ].join('\n'));
      fs.writeFileSync(path.join(p5dir, 'usercache.json'), JSON.stringify([
        { name: 'Steve', uuid: '0123456789abcdef0123456789abcdef' },
        { name: 'Alex', uuid: 'fedcba9876543210fedcba9876543210' },
      ]));
      const result = await h.players_list({ id: p5.id }, ctx) as { players: { name: string; lastSeen: string; playtimeHrs: number }[]; running: boolean; maxPlayers: number };
      if (result.running) throw new Error('server should be stopped');
      const steve = result.players.find((player) => player.name === 'Steve');
      if (!steve) throw new Error('Steve missing from roster');
      if (!steve.lastSeen || steve.lastSeen === '—') throw new Error(`vanilla log lastSeen not parsed: ${steve.lastSeen}`);
      if (!(steve.playtimeHrs > 0)) throw new Error(`playtime not parsed: ${steve.playtimeHrs}`);
      const alex = result.players.find((player) => player.name === 'Alex');
      if (!alex || alex.lastSeen === '—') throw new Error('Forge/Paper log format not parsed');
      if (result.maxPlayers !== 20) throw new Error(`maxPlayers not from properties: ${result.maxPlayers}`);
    });
    await must('players-offline-whitelist-add', async () => {
      await h.player_action({ id: p5.id, action: 'whitelistAdd', name: 'Steve' }, ctx);
      const whitelist = JSON.parse(fs.readFileSync(path.join(p5dir, 'whitelist.json'), 'utf8')) as { name: string; uuid: string }[];
      if (!whitelist.some((row) => row.name === 'Steve' && row.uuid.includes('-'))) throw new Error(JSON.stringify(whitelist));
    });
    await must('players-offline-op', async () => {
      await h.player_action({ id: p5.id, action: 'op', name: 'Alex' }, ctx);
      const ops = JSON.parse(fs.readFileSync(path.join(p5dir, 'ops.json'), 'utf8')) as { name: string; level: number }[];
      if (!ops.some((row) => row.name === 'Alex' && row.level === 4)) throw new Error(JSON.stringify(ops));
    });
    await must('players-offline-ban-unban', async () => {
      await h.player_action({ id: p5.id, action: 'ban', name: 'Steve' }, ctx);
      const bannedAfterBan = JSON.parse(fs.readFileSync(path.join(p5dir, 'banned-players.json'), 'utf8')) as { name: string; uuid: string }[];
      if (!bannedAfterBan.some((row) => row.name === 'Steve' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.uuid))) throw new Error(JSON.stringify(bannedAfterBan));
      await h.player_action({ id: p5.id, action: 'unban', name: 'Steve' }, ctx);
      const bannedAfterUnban = JSON.parse(fs.readFileSync(path.join(p5dir, 'banned-players.json'), 'utf8')) as { name: string }[];
      if (bannedAfterUnban.some((row) => row.name === 'Steve')) throw new Error('unban left the entry');
    });
    await must('players-running-only-action-conflict', async () => {
      let code = '';
      try { await h.player_action({ id: p5.id, action: 'kick', name: 'Steve' }, ctx); }
      catch (error) { code = (error as { code?: string }).code ?? ''; }
      if (code !== 'conflict') throw new Error(`unexpected code ${code}`);
    });

    for (const [name, hours] of [['zero', 0], ['too-large', 169], ['fractional', 1.5]] as [string, number][]) {
      await must(`metrics-hours-${name}`, async () => {
        let code = '';
        try { await h.metrics_get({ id: p5.id, hours }, ctx); } catch (error) { code = (error as { code?: string }).code ?? ''; }
        if (code !== 'validation') throw new Error(`unexpected code ${code}`);
      });
    }
    await must('metrics-history-shape', async () => {
      const result = await h.metrics_get({ id: p5.id, hours: 1 }, ctx) as { samples: unknown[]; disk: { totalBytes: number } };
      if (!Array.isArray(result.samples) || result.disk.totalBytes <= 0) throw new Error('metrics shape invalid');
    });
    await must('server-delete-cleans-p5', async () => {
      await h.servers_delete({ id: p5.id }, ctx);
      if (fs.existsSync(p5dir)) throw new Error('p5 folder left behind');
      const list = await h.servers_list({}, ctx) as { id: string }[];
      if (list.some((row) => row.id === p5.id)) throw new Error('p5 record left behind');
    });
  } catch (error) {
    check('unexpected', false, error instanceof Error ? error.message : String(error));
  } finally {
    await runtime.shutdown();
  }

  for (const entry of checks) {
    // eslint-disable-next-line no-console
    console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`);
  }
  const ok = checks.length > 0 && checks.every((entry) => entry.ok);
  // eslint-disable-next-line no-console
  console.log(ok ? 'MGMTTEST PASS' : 'MGMTTEST FAIL');
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  return ok;
}
