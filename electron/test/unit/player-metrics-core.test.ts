// Unit tests for the pure players/metrics helpers (WP-5.4 / M-13, M-20, M-21).
// Real captured log prefixes are used: Forge lines come from this workspace's 1.20.1 server log
// (`.app-data/servers/e2e-sf5-keymode/logs/latest.log`), vanilla/Fabric and Paper from live servers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpuPercent,
  parseListReply,
  parsePlayerLog,
  parseProcessSampleOutput,
  parseTpsReply,
  stripFormatting,
  stripLogLinePrefix,
  validateHours,
} from '../../services/player-metrics-core';

const FORGE_PREFIX = '[26Oct2026 13:02:43.381] [Server thread/INFO] [net.minecraft.server.dedicated.DedicatedServer/]: ';

test('stripLogLinePrefix: vanilla/Fabric, Forge/NeoForge and Paper prefixes normalize to HH:MM:SS', () => {
  const vanilla = stripLogLinePrefix('[13:02:43] [Server thread/INFO]: Steve joined the game');
  assert.deepEqual(vanilla, { time: '13:02:43', seconds: 46963, message: 'Steve joined the game' });

  const fabric = stripLogLinePrefix('[08:00:01] [Server thread/INFO]: Alex left the game');
  assert.equal(fabric?.time, '08:00:01');

  const forge = stripLogLinePrefix(`${FORGE_PREFIX}Steve joined the game`);
  assert.deepEqual(forge, { time: '13:02:43', seconds: 46963, message: 'Steve joined the game' });

  const neoforge = stripLogLinePrefix(
    '[26Oct2026 13:02:43.381] [Server thread/INFO] [net.neoforged.neoforge.logging.NeoForgeLogger/]: Alex joined the game',
  );
  assert.equal(neoforge?.time, '13:02:43');

  const paper = stripLogLinePrefix('[13:02:43 INFO]: Herobrine joined the game');
  assert.deepEqual(paper, { time: '13:02:43', seconds: 46963, message: 'Herobrine joined the game' });

  const paperWarn = stripLogLinePrefix('[13:02:43 WARN]: can\'t keep up!');
  assert.equal(paperWarn?.message, "can't keep up!");

  assert.equal(stripLogLinePrefix('java.lang.NullPointerException: boom'), null);
  assert.equal(stripLogLinePrefix('Done (12.345s)! For help, type "help"'), null);
});

test('stripLogLinePrefix/stripFormatting: ANSI and § colour codes do not break parsing', () => {
  assert.equal(stripFormatting('\u001b[32mhello\u001b[0m \u00a7cworld'), 'hello world');
  const colored = stripLogLinePrefix('\u001b[32m[13:02:43] [Server thread/INFO]: \u00a7aSteve joined the game\u001b[0m');
  assert.equal(colored?.message, 'Steve joined the game');
});

test('parsePlayerLog: vanilla/Fabric join/leave sessions produce lastSeen + playtime', () => {
  const log = [
    '[10:00:00] [Server thread/INFO]: Steve joined the game',
    '[10:30:00] [Server thread/INFO]: Alex joined the game',
    '[11:30:00] [Server thread/INFO]: Steve left the game',
    '[11:45:00] [Server thread/INFO]: Alex left the game',
    '[11:50:00] [Server thread/INFO]: Steve joined the game',
  ].join('\n');
  const parsed = parsePlayerLog(log);
  assert.equal(parsed.lastSeen.get('steve'), '11:50:00');
  assert.equal(parsed.playtime.get('steve'), 1.5); // the un-finished second session is not counted
  assert.equal(parsed.lastSeen.get('alex'), '11:45:00');
  assert.equal(parsed.playtime.get('alex'), 1.25);
  assert.equal(parsed.sessions, 2);
});

test('parsePlayerLog: Forge/NeoForge timestamped lines are parsed', () => {
  const log = [
    `${FORGE_PREFIX}Steve joined the game`,
    `${FORGE_PREFIX.replace('13:02:43.381', '13:12:43.381')}Steve left the game`,
  ].join('\n');
  const parsed = parsePlayerLog(log);
  assert.equal(parsed.lastSeen.get('steve'), '13:12:43');
  assert.equal(parsed.playtime.get('steve'), 10 / 60);
});

test('parsePlayerLog: Paper `[HH:MM:SS LEVEL]:` lines are parsed', () => {
  const log = [
    '[13:02:43 INFO]: Herobrine joined the game',
    '[13:03:43 INFO]: Herobrine left the game',
  ].join('\n');
  const parsed = parsePlayerLog(log);
  assert.equal(parsed.lastSeen.get('herobrine'), '13:03:43');
  assert.ok(Math.abs((parsed.playtime.get('herobrine') ?? 0) - 1 / 60) < 1e-9);
  assert.equal(parsed.sessions, 1);
});

test('parsePlayerLog: a leave after midnight counts as a midnight wrap; unmatched lines are ignored', () => {
  const log = [
    '[23:59:00] [Server thread/INFO]: NightOwl joined the game',
    '[00:02:00] [Server thread/INFO]: NightOwl left the game',
    '[00:03:00] [Server thread/INFO]: Ghost left the game', // left without a join (rotated log)
    '[00:04:00] [Server thread/INFO]: Starting minecraft server version 1.21.1',
  ].join('\n');
  const parsed = parsePlayerLog(log);
  assert.ok(Math.abs((parsed.playtime.get('nightowl') ?? 0) - 3 / 60) < 1e-9);
  assert.equal(parsed.playtime.has('ghost'), false);
  assert.equal(parsed.sessions, 1);
});

test('parsePlayerLog: re-join without a leave replaces the open session instead of double counting', () => {
  const log = [
    '[10:00:00] [Server thread/INFO]: Steve joined the game',
    '[10:05:00] [Server thread/INFO]: Steve joined the game', // server restarted mid-session
    '[10:10:00] [Server thread/INFO]: Steve left the game',
  ].join('\n');
  const parsed = parsePlayerLog(log);
  assert.ok(Math.abs((parsed.playtime.get('steve') ?? 0) - 5 / 60) < 1e-9);
  assert.equal(parsed.sessions, 1);
});

test('parseListReply: modern, empty, legacy and coloured replies', () => {
  assert.deepEqual(parseListReply('[12:00:00] [Server thread/INFO]: There are 2 of a max of 10 players online: Steve, Alex'), {
    online: 2,
    max: 10,
    names: ['Steve', 'Alex'],
  });
  assert.deepEqual(parseListReply('There are 0 of a max of 20 players online:'), { online: 0, max: 20, names: [] });
  assert.deepEqual(parseListReply('There are 3 of a maximum of 12 players online: Steve, Alex, Herobrine'), {
    online: 3,
    max: 12,
    names: ['Steve', 'Alex', 'Herobrine'],
  });
  assert.deepEqual(parseListReply('There are 0/20 players online:'), { online: 0, max: 20, names: [] });
  assert.deepEqual(parseListReply('\u00a7eThere are 1 of a max of 20 players online: \u00a7fSteve'), {
    online: 1,
    max: 20,
    names: ['Steve'],
  });
  assert.equal(parseListReply('Steve joined the game'), null);
  assert.equal(parseListReply('There are many players online'), null);
});

test('parseTpsReply: Paper `tps` output (incl. colour codes and starred 1m value)', () => {
  assert.deepEqual(parseTpsReply('TPS from last 1m, 5m, 15m: 20.0, 19.98, 19.95'), {
    tps1m: 20,
    tps5m: 19.98,
    tps15m: 19.95,
  });
  assert.deepEqual(parseTpsReply('\u00a7aTPS from last 1m, 5m, 15m: 20.0*, 20.0, 20.0'), {
    tps1m: 20,
    tps5m: 20,
    tps15m: 20,
  });
  assert.equal(parseTpsReply('TPS is fine'), null);
  assert.equal(parseTpsReply('TPS from last 1m, 5m, 15m: n/a, n/a, n/a'), null);
});

test('cpuPercent: normalized by logical cores (Task Manager semantics), not clamped at 100', () => {
  assert.equal(cpuPercent(1, 1_000, 1), 100);
  assert.equal(cpuPercent(1, 1_000, 4), 25);
  assert.equal(cpuPercent(0.5, 2_000, 8), 3.1);
  assert.equal(cpuPercent(2, 1_000, 1), 200); // 2 cores' worth of work on a 1-core machine: not clamped
  assert.equal(cpuPercent(0, 5_000, 8), 0);
  assert.equal(cpuPercent(-0.1, 1_000, 4), null);
  assert.equal(cpuPercent(1, 0, 4), null);
  assert.equal(cpuPercent(Number.NaN, 1_000, 4), null);
  assert.equal(cpuPercent(1, 1_000, Number.NaN), 100); // invalid core count falls back to 1
});

test('validateHours: integer 1..168 only (NaN/±Infinity/decimal/out-of-range rejected)', () => {
  for (const value of [1, 6, 24, 72, 168]) {
    assert.deepEqual(validateHours(value), { ok: true, hours: value });
  }
  assert.deepEqual(validateHours('24'), { ok: true, hours: 24 });
  for (const value of [0, -1, 169, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 'abc', '', null, undefined]) {
    const result = validateHours(value);
    assert.equal(result.ok, false, `expected invalid: ${String(value)}`);
    assert.ok(!result.ok && /hours/.test(result.reason));
  }
});

test('parseProcessSampleOutput: batched pid|cpu|memory lines, empty CPU and whitespace fallback', () => {
  const parsed = parseProcessSampleOutput([
    '1234|12.5|987654321',
    '5678||123456', // PowerShell returned an empty CPU value (e.g. protected process)
    '9012|0|2048',
    'not-a-pid|1|2',
    '',
  ].join('\r\n'));
  assert.equal(parsed.size, 3);
  assert.deepEqual(parsed.get(1234), { cpuSeconds: 12.5, workingSetBytes: 987654321 });
  assert.deepEqual(parsed.get(5678), { cpuSeconds: null, workingSetBytes: 123456 });
  assert.deepEqual(parsed.get(9012), { cpuSeconds: 0, workingSetBytes: 2048 });
  assert.deepEqual(parseProcessSampleOutput('4321 7.25 1048576'), new Map([
    [4321, { cpuSeconds: 7.25, workingSetBytes: 1048576 }],
  ]));
});
