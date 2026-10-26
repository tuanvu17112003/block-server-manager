// Unit tests for the pure backup policy helpers (WP-5.2/5.5): schedule validation, retention
// pools, flush acknowledgement, restore planning, naming and classic-ZIP preflight budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKUP_KINDS,
  INTERVAL_MS,
  SAFETY_POOL_SIZE,
  WORLD_DELETE_POOL_SIZE,
  ZIP_LIMIT_BYTES,
  backupFileName,
  backupTimestamp,
  buildBackupNote,
  checkZipBudget,
  dosDateTime,
  hasSaveAck,
  humanBytes,
  isSaveAckLine,
  isScheduleDue,
  normalizeBackupKind,
  normalizeInterval,
  normalizeMaxKept,
  normalizeSchedulePatch,
  planRestoreSwap,
  planRetention,
  slugify,
  waitForSaveAck,
  type BackupKind,
} from '../../services/backups-core';
import type { BackupRecord, BackupSchedule } from '../../services/store';

let seq = 0;
function row(kind: BackupKind, createdAt: string, id = `b-${++seq}`): BackupRecord {
  return {
    id,
    serverId: 'server-1',
    name: id,
    path: `C:/backups/${id}.zip`,
    bytes: 1024,
    kind,
    note: '',
    createdAt,
  };
}

function schedule(overrides: Partial<BackupSchedule> = {}): BackupSchedule {
  return { auto: true, interval: 'Daily', maxKept: 10, lastRunAt: null, ...overrides };
}

const isValidation = (error: unknown): boolean => (error as { code?: string }).code === 'validation';

test('normalizeInterval: canonicalises Hourly/Daily/Weekly and rejects anything else', () => {
  assert.equal(normalizeInterval('Hourly'), 'Hourly');
  assert.equal(normalizeInterval('daily'), 'Daily');
  assert.equal(normalizeInterval('  WEEKLY  '), 'Weekly');
  assert.equal(INTERVAL_MS.Hourly, 3_600_000);
  for (const bad of ['every-minute', '', 'Minutely', 60, null]) {
    assert.throws(() => normalizeInterval(bad), isValidation, `expected rejection for ${String(bad)}`);
  }
});

test('normalizeMaxKept: clamps 1..50 and rejects non-numeric patches', () => {
  assert.equal(normalizeMaxKept(undefined, 10), 10);
  assert.equal(normalizeMaxKept(0, 10), 1);
  assert.equal(normalizeMaxKept(999, 10), 50);
  assert.equal(normalizeMaxKept(7.9, 10), 7);
  assert.equal(normalizeMaxKept(undefined, 999), 50);
  assert.throws(() => normalizeMaxKept('7' as never, 10), isValidation);
  assert.throws(() => normalizeMaxKept(Number.NaN, 10), isValidation);
});

test('normalizeBackupKind: canonicalises known kinds and rejects unknown values', () => {
  assert.equal(normalizeBackupKind(undefined), 'Manual');
  assert.equal(normalizeBackupKind('auto'), 'Auto');
  assert.equal(normalizeBackupKind('pre-install'), 'Pre-install');
  assert.equal(normalizeBackupKind(' Pre-Restore '), 'Pre-restore');
  assert.equal(normalizeBackupKind('world-delete'), 'World-delete');
  assert.deepEqual([...BACKUP_KINDS].sort(), ['Auto', 'Manual', 'Pre-install', 'Pre-restore', 'World-delete']);
  assert.throws(() => normalizeBackupKind('bogus'), isValidation);
  assert.throws(() => normalizeBackupKind(3), isValidation);
});

test('normalizeSchedulePatch: validates a patch, merges current values and preserves lastRunAt', () => {
  const current = schedule({ interval: 'Weekly', maxKept: 5, lastRunAt: '2026-10-01T00:00:00.000Z' });
  assert.deepEqual(normalizeSchedulePatch({ interval: 'hourly' as never }, current), {
    auto: true, interval: 'Hourly', maxKept: 5, lastRunAt: '2026-10-01T00:00:00.000Z',
  });
  assert.equal(normalizeSchedulePatch({ maxKept: 999 }, current).maxKept, 50);
  assert.equal(normalizeSchedulePatch({ auto: false }, current).auto, false);
  assert.throws(() => normalizeSchedulePatch({ interval: 'nope' as never }, current), isValidation);
  assert.throws(() => normalizeSchedulePatch({ maxKept: Number.NaN }, current), isValidation);
  assert.throws(() => normalizeSchedulePatch({ auto: 'yes' as never }, current), isValidation);
});

test('isScheduleDue: injectable clock drives the interval check', () => {
  const now = Date.parse('2026-10-26T12:00:00.000Z');
  assert.equal(isScheduleDue(schedule({ lastRunAt: null }), now), true);
  assert.equal(isScheduleDue(schedule({ interval: 'Hourly', lastRunAt: new Date(now - 60_000).toISOString() }), now), false);
  assert.equal(isScheduleDue(schedule({ interval: 'Hourly', lastRunAt: new Date(now - INTERVAL_MS.Hourly).toISOString() }), now), true);
  assert.equal(isScheduleDue(schedule({ interval: 'Daily', lastRunAt: new Date(now - INTERVAL_MS.Hourly).toISOString() }), now), false);
  assert.equal(isScheduleDue(schedule({ lastRunAt: 'not-a-date' }), now), true);
  assert.equal(isScheduleDue(schedule({ interval: 'Bogus' as never, lastRunAt: null }), now), true);
});

test('planRetention: Manual/Auto keep exactly maxKept and never prune the just-created archive', () => {
  const rows = [
    row('Manual', '2026-10-26T05:00:00.000Z', 'm5'),
    row('Manual', '2026-10-26T04:00:00.000Z', 'm4'),
    row('Manual', '2026-10-26T03:00:00.000Z', 'm3'),
    row('Manual', '2026-10-26T02:00:00.000Z', 'm2'),
    row('Manual', '2026-10-26T01:00:00.000Z', 'm1'),
    row('Auto', '2026-10-26T00:30:00.000Z', 'a1'),
  ];
  const doomed = planRetention(rows, { maxKept: 2, keepId: 'm5' });
  assert.deepEqual(doomed.map((entry) => entry.id).sort(), ['a1', 'm1', 'm2', 'm3']);

  // The just-created archive is always protected, even if it would fall into the prune slice.
  const protectedRows = planRetention(rows, { maxKept: 1, keepId: 'm1' });
  assert.ok(!protectedRows.some((entry) => entry.id === 'm1'));
  assert.equal(protectedRows.filter((entry) => entry.kind === 'Manual' || entry.kind === 'Auto').length, 4);
});

test('planRetention: Pre-* safety pools are bounded per kind; World-delete keeps its own bound', () => {
  const rows: BackupRecord[] = [];
  for (let index = 1; index <= 3; index += 1) rows.push(row('Pre-install', `2026-10-2${index}T00:00:00.000Z`, `pi-${index}`));
  for (let index = 1; index <= 3; index += 1) rows.push(row('Pre-restore', `2026-10-2${index}T00:00:00.000Z`, `pr-${index}`));
  for (let index = 1; index <= 6; index += 1) rows.push(row('World-delete', `2026-10-2${index}T00:00:00.000Z`, `wd-${index}`));
  rows.push(row('Manual', '2026-10-26T09:00:00.000Z', 'manual-keep'));
  const doomed = planRetention(rows, { maxKept: 1 });
  const ids = doomed.map((entry) => entry.id).sort();
  assert.ok(ids.includes('pi-1'), 'oldest Pre-install should be pruned');
  assert.ok(ids.includes('pr-1'), 'oldest Pre-restore should be pruned');
  assert.equal(ids.filter((id) => id.startsWith('pi-')).length, 1);
  assert.equal(ids.filter((id) => id.startsWith('pr-')).length, 1);
  const prunedWorldDeletes = ids.filter((id) => id.startsWith('wd-'));
  assert.equal(prunedWorldDeletes.length, 6 - WORLD_DELETE_POOL_SIZE);
  assert.equal(ids.includes('manual-keep'), false);
});

test('flush acknowledgement detection: Saved the game/world only, with baseline offset', () => {
  assert.equal(isSaveAckLine('[12:00:00] [Server thread/INFO]: Saved the game'), true);
  assert.equal(isSaveAckLine('[12:00:00] [Server thread/INFO]: Saved the world'), true);
  assert.equal(isSaveAckLine('Saving the game'), false);
  assert.equal(isSaveAckLine('Stopping server'), false);

  const lines = ['[11:59:00] [Server thread/INFO]: Saved the game', '[12:00:00] [Server thread/INFO]: save-all flush'];
  assert.equal(hasSaveAck(lines), true);
  assert.equal(hasSaveAck(lines, 1), false);
  assert.equal(hasSaveAck(lines, 50), false);
});

test('waitForSaveAck: bounded polling with injected clock/sleep', async () => {
  const clock = { now: 0 };
  const slowLines: string[] = [];
  let polls = 0;
  const ok = await waitForSaveAck({
    lines: () => slowLines,
    baseline: 0,
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
      polls += 1;
      if (polls === 2) slowLines.push('[12:00:00] [Server thread/INFO]: Saved the game');
    },
    timeoutMs: 50,
    pollMs: 10,
  });
  assert.equal(ok, true);
  assert.equal(polls, 2);

  const missingClock = { now: 0 };
  let missingPolls = 0;
  const timedOut = await waitForSaveAck({
    lines: () => [],
    baseline: 0,
    now: () => missingClock.now,
    sleep: async (ms) => { missingClock.now += ms; missingPolls += 1; },
    timeoutMs: 30,
    pollMs: 10,
  });
  assert.equal(timedOut, false);
  assert.equal(missingPolls, 3);

  // An acknowledgement printed before the baseline must not count.
  const staleAck = await waitForSaveAck({
    lines: () => ['Saved the game'],
    baseline: 1,
    now: () => 0,
    sleep: async () => undefined,
    timeoutMs: 0,
    pollMs: 1,
  });
  assert.equal(staleAck, false);
});

test('buildBackupNote: reports the consistency level of the archive', () => {
  assert.equal(buildBackupNote({ kind: 'Auto', live: false, flushAck: false, flushTimedOut: false, shutdownDuring: false }), 'Scheduled backup');
  assert.equal(buildBackupNote({ kind: 'Manual', live: true, flushAck: true, flushTimedOut: false, shutdownDuring: false }), 'Taken while running after flush acknowledged');
  assert.equal(buildBackupNote({ kind: 'Manual', live: true, flushAck: false, flushTimedOut: true, shutdownDuring: false }), 'Taken while running; flush acknowledgement timed out');
  assert.equal(buildBackupNote({ kind: 'Manual', live: true, flushAck: false, flushTimedOut: false, shutdownDuring: false }), 'Taken while the server was running');
  assert.equal(buildBackupNote({ kind: 'Manual', live: false, flushAck: false, flushTimedOut: false, shutdownDuring: false }), 'Taken while stopped');
  assert.equal(buildBackupNote({ kind: 'Manual', live: false, flushAck: false, flushTimedOut: false, shutdownDuring: true }), 'Server stopped for a consistent backup');
});

test('naming helpers: stable slug, timestamp and per-kind file name', () => {
  assert.equal(slugify('My Server!'), 'my-server');
  assert.equal(slugify('!!!'), 'server');
  const at = new Date('2026-10-26T12:34:56.789Z');
  assert.equal(backupTimestamp(at), '2026-10-26T12-34-56-789Z');
  assert.equal(backupFileName('My Server!', at, 'Pre-install'), 'my-server-2026-10-26T12-34-56-789Z-pre-install.zip');
  assert.equal(humanBytes(512), '512 B');
  assert.equal(humanBytes(2048), '2.0 KB');
  assert.equal(humanBytes(5 * 1024 ** 3), '5.00 GB');
});

test('planRestoreSwap: in-place moves aside, reset removes colliding directories, missing targets are untouched', () => {
  const staged = ['world', 'server.properties', 'extra'];
  const candidates = [
    { name: 'world', existing: true, isDirectory: true },
    { name: 'server.properties', existing: true, isDirectory: false },
    { name: 'extra', existing: false, isDirectory: false },
  ];
  assert.deepEqual(planRestoreSwap(staged, candidates, 'in-place'), [
    { name: 'world', action: 'aside' },
    { name: 'server.properties', action: 'aside' },
    { name: 'extra', action: 'none' },
  ]);
  assert.deepEqual(planRestoreSwap(staged, candidates, 'reset'), [
    { name: 'world', action: 'remove' },
    { name: 'server.properties', action: 'aside' },
    { name: 'extra', action: 'none' },
  ]);
});

test('dosDateTime: source mtime becomes valid DOS date/time (clamped to 1980)', () => {
  const local = new Date(2026, 9, 26, 12, 34, 56);
  const stamp = dosDateTime(local);
  assert.equal(stamp.date, ((2026 - 1980) << 9) | (10 << 5) | 26);
  assert.equal(stamp.time, (12 << 11) | (34 << 5) | 28);
  const clamped = dosDateTime(new Date(1970, 0, 1, 0, 0, 0));
  assert.equal(clamped.date >> 9, 0, 'years before 1980 clamp to DOS year 1980');
  const oddSecond = dosDateTime(new Date(2026, 9, 26, 12, 0, 1));
  assert.equal(oddSecond.time & 0x1f, 0, 'DOS timestamps have two-second resolution');
  assert.equal(Number.isFinite(dosDateTime(Number.NaN).date), true);
});

test('checkZipBudget: preflight entry count, name length and total size before any read', () => {
  assert.deepEqual(checkZipBudget([{ name: 'a.txt', size: 10 }, { name: 'b.txt', size: 20 }]), {
    totalBytes: 30,
    limit: ZIP_LIMIT_BYTES,
    maxEntries: 0xffff,
  });
  assert.throws(
    () => checkZipBudget(Array.from({ length: 3 }, (_, index) => ({ name: `f-${index}`, size: 1 })), { maxEntries: 2 }),
    (error: unknown) => (error as { code?: string }).code === 'backup-failed' && /too many entries/.test((error as Error).message),
  );
  assert.throws(
    () => checkZipBudget([{ name: 'big.bin', size: 101 }], { limit: 100 }),
    (error: unknown) => (error as { code?: string }).code === 'backup-failed' && /too large/.test((error as Error).message) && /100 bytes/.test((error as Error).message),
  );
  assert.throws(
    () => checkZipBudget([{ name: 'x'.repeat(70_000), size: 1 }]),
    (error: unknown) => (error as { code?: string }).code === 'backup-failed' && /name is too long/.test((error as Error).message),
  );
  assert.throws(
    () => checkZipBudget([{ name: 'a', size: ZIP_LIMIT_BYTES + 1 }]),
    (error: unknown) => /4 GiB/.test((error as Error).message),
  );
  assert.throws(() => checkZipBudget([{ name: 'a', size: Number.NaN }]), (error: unknown) => (error as { code?: string }).code === 'backup-failed');
});
