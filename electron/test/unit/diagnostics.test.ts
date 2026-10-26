// Unit tests for diagnostics (WP-7.4 / B-26): rotating launcher.log, redaction, JSONL timeline,
// support-bundle contents and never-throw behavior on an unwritable data root.
// Plain Node (`node --test`); the support ZIP is read back with the app's existing yauzl helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REDACTED,
  closeDiagnostics,
  createLogger,
  createSupportBundle,
  createTimeline,
  getDiagnostics,
  initDiagnostics,
  installProcessHandlers,
  readTimeline,
  recentDiagnostics,
  recordTimeline,
  redactText,
  redactValue,
} from '../../services/diagnostics';
import { readZipEntry } from '../../services/installer/core';

// ------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------

function tempRoot(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `msm-diag-${label}-`));
}

function makeClock(startIso: string): { now: () => Date; advance: (ms: number) => void } {
  let at = new Date(startIso);
  return {
    now: () => new Date(at),
    advance: (ms: number) => { at = new Date(at.getTime() + ms); },
  };
}

function readFile(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

function logFiles(root: string): string[] {
  try {
    return fs.readdirSync(path.join(root, 'logs')).filter((name) => /^launcher.*\.log$/.test(name)).sort();
  } catch {
    return [];
  }
}

function timelineFiles(root: string): string[] {
  try {
    return fs.readdirSync(path.join(root, 'logs')).filter((name) => /^timeline-.*\.jsonl$/.test(name)).sort();
  } catch {
    return [];
  }
}

async function bundleEntry(bundlePath: string, entry: string): Promise<string> {
  return (await readZipEntry(bundlePath, entry)).toString('utf8');
}

// ------------------------------------------------------------------------------------------------
// Logger: format, ring, child scopes, mirror
// ------------------------------------------------------------------------------------------------

test('logger: writes formatted level/scope lines, fills the ring, child scopes and mirror', (t) => {
  const root = tempRoot('log');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = makeClock('2026-10-26T10:00:00.000Z');
  const mirrored: string[] = [];
  const logger = createLogger({ dataRoot: root, now: clock.now, mirror: (line) => mirrored.push(line) });

  logger.info('app started', { pid: 42 });
  logger.child('installer').warn('slow download');
  logger.child('server:start').error('spawn failed', new Error('kaput'));

  const file = readFile(path.join(root, 'logs', 'launcher.log'));
  assert.match(file, /^\[2026-10-26T10:00:00\.000Z\] INFO {2}\[app\] app started \{"pid":42\}$/m);
  assert.match(file, /^\[2026-10-26T10:00:00\.000Z\] WARN {2}\[installer\] slow download$/m);
  assert.match(file, /^\[2026-10-26T10:00:00\.000Z\] ERROR \[server:start\] spawn failed /m);
  assert.match(file, /kaput/);

  const recent = logger.recent();
  assert.equal(recent.length, 3);
  assert.deepEqual(recent.map((entry) => entry.level), ['info', 'warn', 'error']);
  assert.deepEqual(recent.map((entry) => entry.scope), ['app', 'installer', 'server:start']);
  assert.equal(mirrored.length, 3);
  assert.equal(logger.recent(1).length, 1);
  assert.equal(logger.recent(1)[0]!.scope, 'server:start');
  assert.equal(logger.recent(1)[0]!.message, 'spawn failed');
});

test('logger: circular/bigint details are serialized without throwing', (t) => {
  const root = tempRoot('log-circular');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logger = createLogger({ dataRoot: root, now: () => new Date('2026-10-26T10:00:00.000Z') });
  const circular: Record<string, unknown> = { name: 'loop' };
  circular.self = circular;
  assert.doesNotThrow(() => logger.info('circular', circular));
  assert.doesNotThrow(() => logger.info('bigint', { value: BigInt('9007199254740993') }));
  logger.flush();
  const file = readFile(path.join(root, 'logs', 'launcher.log'));
  assert.match(file, /\[Circular\]/);
  assert.match(file, /9007199254740993/);
});

// ------------------------------------------------------------------------------------------------
// Logger: rotation
// ------------------------------------------------------------------------------------------------

test('logger: rotates by size, keeps at most maxFiles files each <= maxBytes, newest line in launcher.log', (t) => {
  const root = tempRoot('rotate-size');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = makeClock('2026-10-26T10:00:00.000Z');
  const logger = createLogger({ dataRoot: root, now: clock.now, maxBytes: 512, maxFiles: 4 });
  for (let index = 0; index < 30; index += 1) logger.info(`line ${index} ${'x'.repeat(80)}`);

  const files = logFiles(root);
  assert.ok(files.length > 1, 'size rotation must create at least one archive');
  assert.ok(files.length <= 4, `kept ${files.length} files, maxFiles=4`);
  assert.ok(files.includes('launcher.log'));
  for (const name of files) {
    const size = fs.statSync(path.join(root, 'logs', name)).size;
    assert.ok(size <= 512, `${name} is ${size} bytes (> maxBytes)`);
    assert.match(name, /^launcher(-\d{8}(-\d+)?)?\.log$/);
  }
  assert.match(readFile(path.join(root, 'logs', 'launcher.log')), /line 29/);
});

test('logger: rotates on a calendar-day change (UTC day in the line timestamp)', (t) => {
  const root = tempRoot('rotate-day');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = makeClock('2026-10-26T23:59:00.000Z');
  const logger = createLogger({ dataRoot: root, now: clock.now });
  logger.info('day one');
  clock.advance(2 * 60 * 1000); // 2026-10-27T00:01Z
  logger.info('day two');

  const files = logFiles(root);
  assert.ok(files.includes('launcher-20261026.log'), `missing day archive: ${files.join(',')}`);
  assert.match(readFile(path.join(root, 'logs', 'launcher-20261026.log')), /day one/);
  assert.match(readFile(path.join(root, 'logs', 'launcher.log')), /day two/);
  assert.doesNotMatch(readFile(path.join(root, 'logs', 'launcher.log')), /day one/);
});

test('logger: archived files are pruned to maxFiles across several rotations', (t) => {
  const root = tempRoot('rotate-prune');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = makeClock('2026-10-26T10:00:00.000Z');
  const logger = createLogger({ dataRoot: root, now: clock.now, maxFiles: 3 });
  for (let day = 0; day < 6; day += 1) {
    logger.info(`day ${day}`);
    clock.advance(24 * 60 * 60 * 1000);
  }
  logger.info('day 6');
  const files = logFiles(root);
  assert.ok(files.length <= 3, `kept ${files.length} files, maxFiles=3 (${files.join(',')})`);
  assert.ok(files.includes('launcher.log'));
});

// ------------------------------------------------------------------------------------------------
// Redaction
// ------------------------------------------------------------------------------------------------

test('redactText: covers the full secret matrix and leaves -Dtestmultiai markers intact', () => {
  const matrix: { input: string; secret: string }[] = [
    { input: 'boot with key cfc_abcdef1234567890 and continue', secret: 'abcdef1234567890' },
    { input: 'curseforge-key=SUPER-SECRET-123', secret: 'SUPER-SECRET-123' },
    { input: '{"curseforge-key":"quoted-secret-value"}', secret: 'quoted-secret-value' },
    { input: 'Authorization: Bearer topsecretbearer', secret: 'topsecretbearer' },
    { input: '"authorization": "Bearer abcdef123456"', secret: 'abcdef123456' },
    { input: 'x-api-key: api-secret-value', secret: 'api-secret-value' },
    { input: 'api_key=another-api-secret', secret: 'another-api-secret' },
  ];
  for (const { input, secret } of matrix) {
    const out = redactText(input);
    assert.ok(!out.includes(secret), `secret leaked from ${JSON.stringify(input)}: ${out}`);
    assert.ok(out.includes(REDACTED), `no redaction marker for ${JSON.stringify(input)}`);
  }
  assert.equal(redactText('plain diagnostic line'), 'plain diagnostic line');
  const marker = '-Dtestmultiai.server.id=1234-abcd-5678';
  assert.equal(redactText(marker), marker, 'the JVM identity marker must never be redacted');
  assert.equal(redactText('"curseforge-key": "x"').includes('curseforge-key'), true);
});

test('logger: secrets are redacted before they reach the ring and the file (message + detail)', (t) => {
  const root = tempRoot('log-redact');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logger = createLogger({ dataRoot: root, now: () => new Date('2026-10-26T10:00:00.000Z') });
  logger.error('request failed', {
    url: 'https://api.curseforge.com/v1/mods?curseforge-key=AAAA-BBBB-CCCC',
    headers: { Authorization: 'Bearer super-secret-token', 'x-api-key': 'header-secret' },
    marker: '-Dtestmultiai.server.id=identity-1',
  });
  const file = readFile(path.join(root, 'logs', 'launcher.log'));
  for (const secret of ['AAAA-BBBB-CCCC', 'super-secret-token', 'header-secret']) {
    assert.ok(!file.includes(secret), `secret leaked to launcher.log: ${secret}`);
  }
  assert.ok(file.includes('identity-1'), 'identity marker must be preserved');
  const detail = JSON.stringify(logger.recent()[0]!.detail);
  assert.ok(!detail.includes('super-secret-token'));
  assert.equal(logger.recent()[0]!.detail && (logger.recent()[0]!.detail as { marker: string }).marker, '-Dtestmultiai.server.id=identity-1');
});

test('redactValue: deep structures are cloned with secret-named keys and string values redacted', () => {
  const input = {
    token: 'raw-token-value',
    nested: {
      authorization: 'Bearer abc',
      keep: 'visible',
      list: ['cfc_zzzzzzzzzz', 'plain'],
    },
    '-Dtestmultiai.server.id': 'id-1',
  };
  const out = redactValue(input) as typeof input;
  assert.notEqual(out, input);
  assert.equal(out.token, REDACTED);
  assert.equal(out.nested.authorization, REDACTED);
  assert.equal(out.nested.keep, 'visible');
  assert.deepEqual(out.nested.list, [REDACTED, 'plain']);
  assert.equal(out['-Dtestmultiai.server.id'], 'id-1');
  assert.equal(input.token, 'raw-token-value', 'input must not be mutated');
});

// ------------------------------------------------------------------------------------------------
// Timeline
// ------------------------------------------------------------------------------------------------

test('timeline: appends JSONL, reads newest-first with limit/since, ignores malformed lines', (t) => {
  const root = tempRoot('timeline');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = makeClock('2026-10-26T10:00:00.000Z');
  const timeline = createTimeline({ dataRoot: root, now: clock.now });

  timeline.record({ kind: 'server', action: 'start', serverId: 'srv-1', detail: { pid: 42 } });
  clock.advance(1000);
  timeline.record({ kind: 'install', action: 'complete', detail: { planId: 'plan-1', apiKey: 'secret-value' } });
  clock.advance(1000);
  timeline.record({ kind: 'backup', action: 'create' });

  const file = path.join(root, 'logs', 'timeline-20261026.jsonl');
  assert.ok(fs.existsSync(file));
  const lines = readFile(file).split('\n').filter((line) => line.trim() !== '');
  assert.equal(lines.length, 3);
  const first = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(first.kind, 'server');
  assert.equal(first.action, 'start');
  assert.equal(first.serverId, 'srv-1');
  assert.equal((first.detail as { pid: number }).pid, 42);
  assert.ok(!lines[1]!.includes('secret-value'), 'timeline detail must be redacted');

  // Malformed JSONL must be skipped, not thrown.
  fs.appendFileSync(file, 'not-json\n', 'utf8');

  const all = timeline.read();
  assert.deepEqual(all.map((row) => row.action), ['create', 'complete', 'start']);
  assert.equal(timeline.read({ limit: 2 }).length, 2);
  assert.deepEqual(
    timeline.read({ since: '2026-10-26T10:00:01.000Z' }).map((row) => row.action),
    ['create', 'complete'],
  );
  assert.equal(timeline.read({ since: '2027-01-01T00:00:00.000Z' }).length, 0);
});

test('timeline: size cap rotates into numbered files and prunes to maxFiles', (t) => {
  const root = tempRoot('timeline-cap');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = makeClock('2026-10-26T10:00:00.000Z');
  const timeline = createTimeline({ dataRoot: root, now: clock.now, maxBytes: 400, maxFiles: 3 });
  for (let index = 0; index < 25; index += 1) {
    clock.advance(1000); // distinct timestamps keep newest-first ordering meaningful
    timeline.record({ kind: 'app', action: `event-${index}`, detail: { payload: 'x'.repeat(80) } });
  }
  const files = timelineFiles(root);
  assert.ok(files.length > 1, `expected rotated timeline files, got ${files.join(',')}`);
  assert.ok(files.length <= 3, `kept ${files.length} timeline files, maxFiles=3`);
  const newest = timeline.read({ limit: 5 });
  assert.equal(newest.length, 5);
  assert.equal(newest[0]!.action, 'event-24');
});

// ------------------------------------------------------------------------------------------------
// Never throw on an unwritable data root
// ------------------------------------------------------------------------------------------------

test('logger + timeline: an unwritable logs path never throws and the ring still works', (t) => {
  const root = tempRoot('unwritable');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'logs'), 'not-a-directory'); // blocks <dataRoot>/logs/*
  const logger = createLogger({ dataRoot: root, now: () => new Date('2026-10-26T10:00:00.000Z') });
  assert.doesNotThrow(() => logger.info('still alive', { step: 1 }));
  assert.doesNotThrow(() => logger.error('still alive', new Error('x')));
  assert.equal(logger.recent().length, 2);
  assert.equal(logger.recent()[1]!.level, 'error');

  const timeline = createTimeline({ dataRoot: root, now: () => new Date('2026-10-26T10:00:00.000Z') });
  assert.doesNotThrow(() => timeline.record({ kind: 'app', action: 'start' }));
  assert.deepEqual(timeline.read(), []);
});

// ------------------------------------------------------------------------------------------------
// Process handlers
// ------------------------------------------------------------------------------------------------

test('installProcessHandlers: logs both handler types, calls onFatal, and disposes cleanly', (t) => {
  const root = tempRoot('handlers');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logger = createLogger({ dataRoot: root, now: () => new Date('2026-10-26T10:00:00.000Z') });
  const target = new EventEmitter();
  const fatals: unknown[] = [];
  const dispose = installProcessHandlers(
    logger,
    { onFatal: (error) => fatals.push(error), rethrowUncaught: false },
    target,
  );
  const error = new Error('kaboom');
  target.emit('uncaughtException', error);
  target.emit('unhandledRejection', new Error('rejected'));
  assert.deepEqual(fatals, [error]);

  const recent = logger.recent();
  assert.equal(recent.length, 2);
  assert.match(recent[0]!.message, /uncaughtException/);
  assert.match(recent[1]!.message, /unhandledRejection/);
  const file = readFile(path.join(root, 'logs', 'launcher.log'));
  assert.match(file, /kaboom/);
  assert.match(file, /rejected/);

  dispose();
  assert.equal(target.listenerCount('uncaughtException'), 0);
  assert.equal(target.listenerCount('unhandledRejection'), 0);
});

test('installProcessHandlers: default configuration registers listeners and disposes them', (t) => {
  const root = tempRoot('handlers-default');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logger = createLogger({ dataRoot: root, now: () => new Date('2026-10-26T10:00:00.000Z') });
  const target = new EventEmitter();
  const dispose = installProcessHandlers(logger, {}, target);
  assert.equal(target.listenerCount('uncaughtException'), 1);
  assert.equal(target.listenerCount('unhandledRejection'), 1);
  // Default unhandled rejections are logged, not fatal.
  assert.doesNotThrow(() => target.emit('unhandledRejection', new Error('benign')));
  assert.match(logger.recent()[0]!.message, /unhandledRejection/);
  dispose();
});

// ------------------------------------------------------------------------------------------------
// Module singleton
// ------------------------------------------------------------------------------------------------

test('initDiagnostics/getDiagnostics: module-level recordTimeline/readTimeline/recentDiagnostics work', (t) => {
  const root = tempRoot('singleton');
  t.after(() => {
    closeDiagnostics();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const diagnostics = initDiagnostics({ dataRoot: root, now: () => new Date('2026-10-26T10:00:00.000Z') });
  assert.equal(getDiagnostics(), diagnostics);
  diagnostics.logger.info('singleton boot');
  const event = recordTimeline({ kind: 'app', action: 'start' });
  assert.ok(event);
  assert.equal(event.action, 'start');
  assert.equal(readTimeline().length, 1);
  assert.equal(recentDiagnostics().length, 1);
  closeDiagnostics();
  assert.equal(getDiagnostics(), null);
  assert.equal(recordTimeline({ kind: 'app', action: 'after-close' }), null);
  assert.deepEqual(readTimeline(), []);
});

// ------------------------------------------------------------------------------------------------
// Support bundle
// ------------------------------------------------------------------------------------------------

test('createSupportBundle: contains versions/servers/redacted app-data/log tail/timeline, no secrets', async (t) => {
  const root = tempRoot('bundle');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'logs', 'launcher.log'),
    [
      '[2026-10-26T10:00:00.000Z] INFO  [app] booted with cfc_abcdef1234567890',
      '[2026-10-26T10:00:01.000Z] WARN  [server:start] Authorization: Bearer supersecretbearer',
      '[2026-10-26T10:00:02.000Z] ERROR [installer] failed',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(path.join(root, 'logs', 'launcher-20261025.log'), '[2026-10-25T09:00:00.000Z] INFO  [app] older line\n', 'utf8');
  fs.writeFileSync(
    path.join(root, 'logs', 'timeline-20261026.jsonl'),
    `${JSON.stringify({ at: '2026-10-26T10:00:00.000Z', kind: 'app', action: 'start' })}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(root, 'curseforge-key.txt'), 'cfc_MUST_NOT_BE_BUNDLED', 'utf8');
  const appData = {
    schemaVersion: 2,
    servers: [{
      id: 'srv-1', name: 'Alpha Server', loader: 'Fabric', mcVersion: '1.21.1', loaderVersion: '0.16.9',
      port: 25565, ramMb: 4096, javaPath: 'C:\\Users\\alice\\jdk\\bin\\java.exe', eulaAccepted: true,
      status: 'stopped', createdAt: '2026-01-01T00:00:00.000Z', motd: 'hello',
    }],
    settings: { theme: 'dark', 'curseforge-key': 'cfc_settingsSecret123', contentMeta: 'mods/example.jar' },
    consoleCommandHistory: [{ serverId: 'srv-1', command: 'list', at: '2026-01-01T00:00:00.000Z' }],
    backups: [{
      id: 'b1', serverId: 'srv-1', name: 'backup', path: 'C:\\Users\\alice\\backups\\b1.zip',
      bytes: 10, kind: 'Manual', note: '', createdAt: '2026-01-01T00:00:00.000Z',
    }],
    backupSchedules: {},
    pendingWorlds: {},
  };
  fs.writeFileSync(path.join(root, 'app-data.json'), JSON.stringify(appData), 'utf8');

  const bundle = await createSupportBundle({
    dataRoot: root,
    versions: {
      app: '9.9.9', electron: '45.0.0', node: 'v24.0.0', chrome: '144.0.0',
      platform: 'win32', arch: 'x64', os: 'Windows_NT 10.0',
    },
    now: () => new Date('2026-10-26T12:00:00.000Z'),
    maxLogLines: 100,
    maxTimeline: 10,
  });
  t.after(() => { try { fs.rmSync(bundle.path, { force: true }); } catch { /* already removed */ } });
  assert.ok(fs.existsSync(bundle.path));
  assert.ok(bundle.bytes > 0);
  assert.deepEqual(bundle.entries, [
    'manifest.json', 'versions.json', 'servers.json', 'app-data.redacted.json',
    'logs/launcher.log.tail.txt', 'logs/timeline.recent.jsonl', 'notes.txt',
  ]);
  assert.equal(bundle.createdAt, '2026-10-26T12:00:00.000Z');

  const manifest = JSON.parse(await bundleEntry(bundle.path, 'manifest.json')) as Record<string, any>;
  assert.equal(manifest.bundleVersion, 1);
  assert.equal(manifest.app, '9.9.9');
  assert.equal(manifest.platform, 'win32');
  assert.equal(manifest.hasCurseforgeKeyFile, true);
  assert.equal(manifest.counts.servers, 1);
  assert.ok(Array.isArray(manifest.exclusions));
  assert.ok(manifest.launcherLogFiles.some((file: { name: string }) => file.name === 'launcher.log'));

  const versions = JSON.parse(await bundleEntry(bundle.path, 'versions.json')) as Record<string, any>;
  assert.equal(versions.electron, '45.0.0');
  assert.equal(versions.node, 'v24.0.0');

  const servers = JSON.parse(await bundleEntry(bundle.path, 'servers.json')) as Record<string, any>[];
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, 'Alpha Server');
  assert.equal(servers[0].port, 25565);
  assert.equal(servers[0].status, 'stopped');
  assert.equal(servers[0].javaPathRedacted, true);
  assert.ok(!JSON.stringify(servers).includes('alice'), 'server summary must not leak absolute paths');

  const redacted = await bundleEntry(bundle.path, 'app-data.redacted.json');
  for (const secret of ['cfc_abcdef1234567890', 'cfc_settingsSecret123', 'alice', 'MUST_NOT_BE_BUNDLED']) {
    assert.ok(!redacted.includes(secret), `redacted app-data leaked ${secret}`);
  }
  assert.ok(redacted.includes('Alpha Server'), 'non-secret registry data is kept');
  assert.ok(redacted.includes(REDACTED));

  const logTail = await bundleEntry(bundle.path, 'logs/launcher.log.tail.txt');
  assert.ok(logTail.includes('failed'), 'recent lines are included');
  assert.ok(logTail.includes('older line'), 'rotated launcher log lines are appended');
  for (const secret of ['abcdef1234567890', 'supersecretbearer']) assert.ok(!logTail.includes(secret));

  const timeline = await bundleEntry(bundle.path, 'logs/timeline.recent.jsonl');
  assert.ok(timeline.includes('"action":"start"'));

  const notes = await bundleEntry(bundle.path, 'notes.txt');
  assert.match(notes, /Excluded/i);
  for (const entry of bundle.entries) {
    assert.ok(!/^(worlds|backups|mods)\//.test(entry), `forbidden bundle entry ${entry}`);
    assert.ok(!entry.includes('curseforge-key.txt'));
  }
});

test('createSupportBundle: missing/corrupt app-data.json still produces a usable bundle', async (t) => {
  const root = tempRoot('bundle-empty');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = await createSupportBundle({ dataRoot: root, versions: { app: '1.0.0' } });
  t.after(() => { try { fs.rmSync(bundle.path, { force: true }); } catch { /* already removed */ } });
  assert.ok(fs.existsSync(bundle.path));
  const servers = JSON.parse(await bundleEntry(bundle.path, 'servers.json')) as unknown[];
  assert.deepEqual(servers, []);
  const redacted = JSON.parse(await bundleEntry(bundle.path, 'app-data.redacted.json')) as Record<string, unknown>;
  assert.match(String(redacted.error), /unreadable|missing/);
  const launcherTail = await bundleEntry(bundle.path, 'logs/launcher.log.tail.txt');
  assert.match(launcherTail, /no launcher\.log lines yet/);
});

test('createSupportBundle: honors an explicit outPath and leaves no staging directory behind', async (t) => {
  const root = tempRoot('bundle-out');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outPath = path.join(root, 'custom', 'support.zip');
  const bundle = await createSupportBundle({ dataRoot: root, outPath, now: () => new Date('2026-10-26T12:00:00.000Z') });
  assert.equal(bundle.path, path.resolve(outPath));
  assert.ok(fs.existsSync(outPath));
  assert.deepEqual(fs.readdirSync(path.join(root, 'custom')), ['support.zip'], 'only the final ZIP remains (temp+rename)');
  // Rejects for a missing entry instead of silently returning something.
  await assert.rejects(() => readZipEntry(outPath, 'curseforge-key.txt'));
});
