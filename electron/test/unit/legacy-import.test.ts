// Unit tests for the legacy Tauri SQLite -> Electron JSON store importer (WP-1.6 / finding B-13).
//
// Fixtures are built with `node:sqlite` in fresh temp dirs: a legacy root with `app.db` (Rust schema
// v1+v2+v3), fake `servers/<id>/` folders, and a separate target data root. Each test owns its temp
// dirs; nothing here touches the real `%APPDATA%` or the project `.app-data`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  LEGACY_IMPORT_MARKER,
  LEGACY_ROOT_ENV,
  detectLegacy,
  planImport,
  readImportMarker,
  runImport,
} from '../../services/legacy-import';
import { Store } from '../../services/store';

const SERVER_A = '11111111-1111-4111-8111-111111111111';
const SERVER_B = '22222222-2222-4222-8222-222222222222';
const SERVER_C = '33333333-3333-4333-8333-333333333333';
const BACKUP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROTO_SERVER = '44444444-4444-4444-8444-444444444444';

// Mirrors src-tauri/src/db/mod.rs SCHEMA_V1 (tables the legacy Tauri app shipped).
const RUST_SCHEMA_V1 = `
CREATE TABLE servers (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  loader         TEXT NOT NULL,
  mc_version     TEXT NOT NULL,
  loader_version TEXT,
  modpack_id     TEXT,
  port           INTEGER NOT NULL UNIQUE,
  ram_mb         INTEGER NOT NULL,
  java_path      TEXT,
  eula_accepted  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'stopped',
  created_at     TEXT NOT NULL
);
CREATE TABLE backups (
  id         TEXT PRIMARY KEY,
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  size_mb    REAL NOT NULL DEFAULT 0,
  path       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT ''
);
CREATE TABLE worlds (
  id        TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  path      TEXT NOT NULL,
  size_mb   REAL NOT NULL DEFAULT 0,
  seed      TEXT NOT NULL DEFAULT '',
  active    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE jobs (
  id       TEXT PRIMARY KEY,
  kind     TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  log      TEXT NOT NULL DEFAULT ''
);
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const RUST_SCHEMA_V2 = `
CREATE TABLE console_command_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  command    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX console_command_history_server_id ON console_command_history (server_id, id DESC);
`;

const RUST_SCHEMA_V3 = `
CREATE TABLE managed_server_files (
  server_id        TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  canonical_root   TEXT NOT NULL,
  path_key         TEXT NOT NULL,
  relative_path    TEXT NOT NULL,
  installed_size   INTEGER NOT NULL CHECK (installed_size >= 0),
  installed_sha1   TEXT NOT NULL,
  installed_sha512 TEXT NOT NULL,
  plan_id          TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (server_id, path_key)
);
CREATE INDEX managed_server_files_server_id ON managed_server_files (server_id, path_key);
`;

// ------------------------------------------------------------------------------------------------
// Fixture helpers
// ------------------------------------------------------------------------------------------------

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `msm-legacy-${prefix}-`));
}

function writeIn(root: string, relative: string, content: string | Buffer): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function withWritableDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Content-addressed recursive snapshot: detects any source write/add/delete/rename. */
function treeSnapshot(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        snapshot[`${relative}/`] = 'dir';
        walk(full, relative);
      } else if (entry.isFile()) {
        snapshot[relative] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      } else {
        snapshot[relative] = 'other';
      }
    }
  };
  walk(root, '');
  return snapshot;
}

/** Legacy Tauri root: app.db with schema v1+v2+v3 rows and two fake `servers/<id>/` folders. */
function buildRustFixture(root: string): void {
  fs.mkdirSync(path.join(root, 'servers'), { recursive: true });
  withWritableDb(path.join(root, 'app.db'), (db) => {
    db.exec(RUST_SCHEMA_V1);
    db.exec(RUST_SCHEMA_V2);
    db.exec(RUST_SCHEMA_V3);
    const insertServer = db.prepare(
      `INSERT INTO servers (id, name, loader, mc_version, loader_version, modpack_id, port, ram_mb, java_path, eula_accepted, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertServer.run(
      SERVER_A, 'Alpha', 'Fabric', '1.21.1', '0.16.9', 'abcd1234', 25565, 4096,
      'C:\\Java\\jdk21\\bin\\java.exe', 1, 'running', '2026-01-02T03:04:05.000Z',
    );
    insertServer.run(
      SERVER_B, 'Beta', 'Vanilla', '1.20.1', null, null, 25566, 2048,
      null, 0, 'stopped', '2026-01-01T00:00:00.000Z',
    );
    db.prepare(
      `INSERT INTO backups (id, server_id, name, kind, size_mb, path, created_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(BACKUP_A, SERVER_A, 'alpha-backup', 'Manual', 1.5, 'backups/alpha.zip', '2026-01-03T00:00:00.000Z', 'first backup');
    db.prepare(`INSERT INTO worlds (id, server_id, name, path, size_mb, seed, active) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'world-1', SERVER_A, 'world', 'world', 12.5, 'seed123', 1,
    );
    db.prepare(`INSERT INTO jobs (id, kind, progress, log) VALUES (?, ?, ?, ?)`).run('job-1', 'backup', 0.5, 'running');
    const insertSetting = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`);
    insertSetting.run('theme', '"dark"');
    insertSetting.run('autoBackup', 'true');
    insertSetting.run('greeting', 'hello');
    const insertHistory = db.prepare(
      `INSERT INTO console_command_history (server_id, command, created_at) VALUES (?, ?, ?)`,
    );
    insertHistory.run(SERVER_A, 'list', '2026-01-02T03:05:00.000Z');
    insertHistory.run(SERVER_A, 'say hi', '2026-01-02T03:06:00.000Z');
    insertHistory.run(SERVER_A, 'stop', '2026-01-02T03:07:00.000Z');
    insertHistory.run(SERVER_B, 'op Steve', '2026-01-02T03:08:00.000Z');
    db.prepare(
      `INSERT INTO managed_server_files
         (server_id, canonical_root, path_key, relative_path, installed_size, installed_sha1, installed_sha512, plan_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(SERVER_A, 'C:\\data', 'mods/test.jar', 'mods/test.jar', 123, 'sha1', 'sha512', 'plan-1', '2026-01-02T00:00:00.000Z');
  });
  writeIn(root, `servers/${SERVER_A}/server.properties`, 'motd=Alpha\nserver-port=25565\n');
  writeIn(root, `servers/${SERVER_A}/mods/test.jar`, 'jar-bytes');
  writeIn(root, `servers/${SERVER_B}/server.properties`, 'motd=Beta\n');
}

/** Append one extra legacy server (+ its folder) to an existing fixture database. */
function appendLegacyServer(legacyRoot: string, id: string, name: string): void {
  withWritableDb(path.join(legacyRoot, 'app.db'), (db) => {
    db.prepare(
      `INSERT INTO servers (id, name, loader, mc_version, loader_version, modpack_id, port, ram_mb, java_path, eula_accepted, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, 'Forge', '1.19.2', null, null, 25567, 3072, null, 0, 'stopped', '2026-01-04T00:00:00.000Z');
  });
  writeIn(legacyRoot, `servers/${id}/server.properties`, `motd=${name}\n`);
}

/** Legacy prototype root (older Tauri variant found under %APPDATA%\\minecraft-server-manager). */
function buildPrototypeFixture(root: string): { directory: string } {
  const directory = path.join(root, 'servers', 'MyServer');
  fs.mkdirSync(directory, { recursive: true });
  withWritableDb(path.join(root, 'app.db'), (db) => {
    db.exec(`
      CREATE TABLE servers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, directory TEXT NOT NULL, distribution TEXT NOT NULL,
        minecraft_version TEXT NOT NULL, loader_version TEXT, installer_version TEXT, build_version TEXT,
        java_runtime_id TEXT, min_ram_mb INTEGER NOT NULL, max_ram_mb INTEGER NOT NULL, port INTEGER NOT NULL,
        install_state TEXT NOT NULL DEFAULT 'pending', install_error TEXT, jvm_args TEXT NOT NULL DEFAULT '',
        icon_path TEXT, eula_accepted INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_started_at TEXT, last_stopped_at TEXT
      );
      CREATE TABLE java_runtimes (
        id TEXT PRIMARY KEY, major_version INTEGER NOT NULL, version TEXT NOT NULL, vendor TEXT NOT NULL,
        architecture TEXT NOT NULL, executable_path TEXT NOT NULL, managed INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL, size_bytes INTEGER, added_at TEXT NOT NULL
      );
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE backups (
        id TEXT PRIMARY KEY, server_id TEXT NOT NULL, file_path TEXT NOT NULL, file_name TEXT NOT NULL,
        type TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        world_name TEXT, verified INTEGER, note TEXT NOT NULL DEFAULT ''
      );
    `);
    db.prepare(
      `INSERT INTO java_runtimes (id, major_version, version, vendor, architecture, executable_path, managed, source, size_bytes, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'java-1', 21, '21.0.5', 'Eclipse Adoptium', 'amd64',
      'C:\\Program Files\\Eclipse Adoptium\\jdk-21\\bin\\java.exe', 1, 'detected', null, '2026-01-01T00:00:00.000Z',
    );
    db.prepare(
      `INSERT INTO servers
         (id, name, directory, distribution, minecraft_version, loader_version, java_runtime_id, min_ram_mb, max_ram_mb,
          port, install_state, eula_accepted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      PROTO_SERVER, 'Proto', directory, 'fabric', '1.21.1', '0.19.5', 'java-1', 2048, 8192, 25565,
      'installed', 1, '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z',
    );
    db.prepare(
      `INSERT INTO backups (id, server_id, file_path, file_name, type, size_bytes, created_at, verified, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', PROTO_SERVER, 'backups/proto.zip', 'proto-backup.zip', 'Auto', 2048, '2026-01-06T00:00:00.000Z', 1, 'proto note');
    db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?)`).run('theme', '"light"');
  });
  writeIn(directory, 'server.properties', 'motd=Proto\n');
  return { directory };
}

// ------------------------------------------------------------------------------------------------
// detectLegacy
// ------------------------------------------------------------------------------------------------

test('detectLegacy: returns null for missing/empty roots and detects a Rust-schema fixture', () => {
  const tmp = tempDir('detect');
  assert.equal(detectLegacy(path.join(tmp, 'missing')), null);

  const emptyDir = path.join(tmp, 'empty');
  fs.mkdirSync(emptyDir);
  assert.equal(detectLegacy(emptyDir), null);

  const zeroByte = path.join(tmp, 'zero-byte');
  fs.mkdirSync(zeroByte);
  fs.writeFileSync(path.join(zeroByte, 'app.db'), '');
  assert.equal(detectLegacy(zeroByte), null);

  const legacyRoot = path.join(tmp, 'legacy');
  buildRustFixture(legacyRoot);
  const source = detectLegacy(legacyRoot);
  assert.ok(source);
  assert.equal(source?.root, legacyRoot);
  assert.equal(source?.origin, 'explicit');
  assert.equal(source?.schemaVersion, 3);
  assert.equal(source?.schemaKind, 'rust-v3');
  assert.deepEqual(source?.counts, {
    servers: 2,
    backups: 1,
    worlds: 1,
    jobs: 1,
    settings: 3,
    consoleHistory: 4,
    managedFiles: 1,
  });
  assert.deepEqual(source?.errors, []);
});

test('detectLegacy: MSM_LEGACY_ROOT override is used when no explicit root is passed', () => {
  const tmp = tempDir('detect-env');
  const legacyRoot = path.join(tmp, 'legacy-env');
  buildRustFixture(legacyRoot);
  const previous = process.env[LEGACY_ROOT_ENV];
  process.env[LEGACY_ROOT_ENV] = legacyRoot;
  try {
    const source = detectLegacy();
    assert.ok(source);
    assert.equal(source?.root, legacyRoot);
    assert.equal(source?.origin, 'env');
    assert.equal(source?.schemaVersion, 3);
  } finally {
    if (previous === undefined) delete process.env[LEGACY_ROOT_ENV];
    else process.env[LEGACY_ROOT_ENV] = previous;
  }
});

// ------------------------------------------------------------------------------------------------
// planImport (dry run)
// ------------------------------------------------------------------------------------------------

test('planImport: dry run reports servers, folders, backups/history/settings and writes nothing', () => {
  const tmp = tempDir('plan');
  const legacyRoot = path.join(tmp, 'legacy');
  buildRustFixture(legacyRoot);
  const dataRoot = path.join(tmp, 'target-data');
  const sourceBefore = treeSnapshot(legacyRoot);

  const plan = planImport({ dataRoot, legacyRoot });

  assert.equal(plan.ok, true, plan.errors.join('; '));
  assert.equal(plan.alreadyImported, false);
  assert.equal(plan.schemaVersion, 3);
  assert.equal(plan.schemaKind, 'rust-v3');
  assert.deepEqual(plan.counts, {
    servers: 2,
    backups: 1,
    worlds: 1,
    jobs: 1,
    settings: 3,
    consoleHistory: 4,
    managedFiles: 1,
  });
  assert.deepEqual(plan.servers.map((server) => server.legacyId).sort(), [SERVER_A, SERVER_B].sort());
  assert.deepEqual(plan.duplicates, []);
  assert.deepEqual(plan.folders, { found: 2, missing: 0 });
  assert.deepEqual(plan.backups, { total: 1, importable: 1, orphaned: 0, duplicate: 0 });
  assert.deepEqual(plan.history, { total: 4, importable: 4 });
  assert.deepEqual(plan.settings, { total: 3, importable: 3, collisions: 0 });
  const alpha = plan.servers.find((server) => server.legacyId === SERVER_A);
  assert.equal(alpha?.folder, path.join(legacyRoot, 'servers', SERVER_A));
  assert.equal(alpha?.folderFound, true);

  // Dry run only reads: no target dir, no marker, source byte-identical.
  assert.equal(fs.existsSync(dataRoot), false);
  assert.deepEqual(treeSnapshot(legacyRoot), sourceBefore);
});

test('planImport: flags duplicates by id and name against the current JSON store', () => {
  const tmp = tempDir('plan-dupes');
  const legacyRoot = path.join(tmp, 'legacy');
  buildRustFixture(legacyRoot);
  const dataRoot = path.join(tmp, 'target');

  const store = new Store(dataRoot);
  const sameId = store.createServer({ name: 'AlphaRenamed', loader: 'Vanilla', mcVersion: '1.20.1', ramMb: 1024 });
  store.updateServer(sameId.id, { id: SERVER_A });
  store.createServer({ name: 'Beta', loader: 'Vanilla', mcVersion: '1.20.1', ramMb: 1024 });

  const plan = planImport({ dataRoot, legacyRoot });
  assert.equal(plan.ok, true, plan.errors.join('; '));
  assert.equal(plan.duplicates.length, 2);
  assert.equal(plan.duplicates.find((duplicate) => duplicate.reason === 'id')?.legacyId, SERVER_A);
  assert.equal(plan.duplicates.find((duplicate) => duplicate.reason === 'name')?.name, 'Beta');
  assert.equal(plan.servers.find((server) => server.legacyId === SERVER_A)?.duplicate, 'id');
  assert.equal(plan.servers.find((server) => server.legacyId === SERVER_B)?.duplicate, 'name');
});

test('planImport: a missing legacy root is reported as an explicit error', () => {
  const tmp = tempDir('plan-missing');
  const plan = planImport({ dataRoot: path.join(tmp, 'data'), legacyRoot: path.join(tmp, 'nope') });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /legacy data root not found/);
});

// ------------------------------------------------------------------------------------------------
// runImport (happy path)
// ------------------------------------------------------------------------------------------------

test('runImport: imports servers/folders/backups/history/settings, writes marker, source untouched', async () => {
  const tmp = tempDir('import');
  const legacyRoot = path.join(tmp, 'legacy');
  buildRustFixture(legacyRoot);
  const dataRoot = path.join(tmp, 'nested', 'data');
  const sourceBefore = treeSnapshot(legacyRoot);

  const report = await runImport({ dataRoot, legacyRoot });

  assert.equal(report.status, 'completed', report.errors.join('; '));
  assert.equal(report.alreadyImported, true);
  assert.deepEqual(report.imported, { servers: 2, backups: 1, history: 4, settings: 3 });
  assert.deepEqual(report.foldersCopied.slice().sort(), [SERVER_A, SERVER_B].sort());
  assert.deepEqual(report.duplicates, []);
  assert.deepEqual(report.errors, []);
  assert.equal(report.legacyRoot, legacyRoot);
  assert.equal(report.schemaVersion, 3);

  const store = new Store(dataRoot);
  const servers = store.listServers();
  assert.equal(servers.length, 2);
  const alpha = servers.find((server) => server.id === SERVER_A);
  assert.ok(alpha);
  assert.equal(alpha?.name, 'Alpha');
  assert.equal(alpha?.loader, 'Fabric');
  assert.equal(alpha?.mcVersion, '1.21.1');
  assert.equal(alpha?.loaderVersion, '0.16.9');
  assert.equal(alpha?.modpackId, 'abcd1234');
  assert.equal(alpha?.port, 25565);
  assert.equal(alpha?.ramMb, 4096);
  assert.equal(alpha?.javaPath, 'C:\\Java\\jdk21\\bin\\java.exe');
  assert.equal(alpha?.eulaAccepted, true);
  assert.equal(alpha?.status, 'stopped'); // legacy 'running' is normalised to stopped
  assert.equal(alpha?.createdAt, '2026-01-02T03:04:05.000Z');
  const beta = servers.find((server) => server.id === SERVER_B);
  assert.equal(beta?.eulaAccepted, false);
  assert.equal(beta?.javaPath, null);
  assert.equal(beta?.loader, 'Vanilla');

  // Folders were copied (temp-then-rename) and contain the legacy bytes.
  assert.equal(fs.readFileSync(path.join(dataRoot, 'servers', SERVER_A, 'server.properties'), 'utf8'), 'motd=Alpha\nserver-port=25565\n');
  assert.equal(fs.readFileSync(path.join(dataRoot, 'servers', SERVER_A, 'mods', 'test.jar'), 'utf8'), 'jar-bytes');
  assert.equal(fs.readFileSync(path.join(dataRoot, 'servers', SERVER_B, 'server.properties'), 'utf8'), 'motd=Beta\n');
  assert.deepEqual(
    fs.readdirSync(path.join(dataRoot, 'servers')).filter((name) => name.startsWith('.legacy-import-')),
    [],
    'no temporary copy folders may be left behind',
  );

  // Backups: REAL MiB -> bytes, kind/note/path/createdAt preserved.
  const backups = store.listBackups(SERVER_A);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].id, BACKUP_A);
  assert.equal(backups[0].bytes, 1572864);
  assert.equal(backups[0].kind, 'Manual');
  assert.equal(backups[0].path, path.join(legacyRoot, 'backups', 'alpha.zip'));
  assert.equal(backups[0].note, 'first backup');
  assert.equal(backups[0].createdAt, '2026-01-03T00:00:00.000Z');

  // Console history: newest-first per server (WP-2.3 / Rust `ORDER BY id DESC`).
  assert.deepEqual(store.commandHistory(SERVER_A), ['stop', 'say hi', 'list']);
  assert.deepEqual(store.commandHistory(SERVER_B), ['op Steve']);

  // Settings: JSON values decoded, raw strings kept.
  assert.equal(store.getSetting('theme'), 'dark');
  assert.equal(store.getSetting('autoBackup'), true);
  assert.equal(store.getSetting('greeting'), 'hello');

  // Marker: source/schema/version/timestamp/report.
  const marker = readImportMarker(dataRoot);
  assert.ok(marker);
  assert.equal(marker?.markerVersion, 1);
  assert.equal(marker?.source, legacyRoot);
  assert.equal(marker?.sourceDb, path.join(legacyRoot, 'app.db'));
  assert.equal(marker?.schemaVersion, 3);
  assert.equal(marker?.schemaKind, 'rust-v3');
  assert.equal(marker?.status, 'completed');
  assert.equal(marker?.timestamp, report.finishedAt);
  assert.equal(marker?.report.imported.servers, 2);
  assert.equal(fs.existsSync(path.join(dataRoot, LEGACY_IMPORT_MARKER)), true);

  // Source untouched: same files, same bytes, no SQLite sidecars added.
  assert.deepEqual(treeSnapshot(legacyRoot), sourceBefore);
});

test('runImport: second run is idempotent (already-imported, no store/marker changes)', async () => {
  const tmp = tempDir('idempotent');
  const legacyRoot = path.join(tmp, 'legacy');
  buildRustFixture(legacyRoot);
  const dataRoot = path.join(tmp, 'data');
  const sourceBefore = treeSnapshot(legacyRoot);

  const first = await runImport({ dataRoot, legacyRoot });
  assert.equal(first.status, 'completed');
  const markerPath = path.join(dataRoot, LEGACY_IMPORT_MARKER);
  const markerBytes = fs.readFileSync(markerPath);
  const serversAfterFirst = new Store(dataRoot).listServers().length;

  const second = await runImport({ dataRoot, legacyRoot });
  assert.equal(second.status, 'already-imported');
  assert.equal(second.alreadyImported, true);
  assert.equal(second.previousImportAt, first.finishedAt);
  assert.deepEqual(second.imported, { servers: 0, backups: 0, history: 0, settings: 0 });
  assert.equal(new Store(dataRoot).listServers().length, serversAfterFirst);
  assert.deepEqual(fs.readFileSync(markerPath), markerBytes);
  assert.deepEqual(treeSnapshot(legacyRoot), sourceBefore);

  // Even a vanished source must not matter once the terminal marker exists.
  fs.rmSync(legacyRoot, { recursive: true, force: true });
  const third = await runImport({ dataRoot, legacyRoot });
  assert.equal(third.status, 'already-imported');
});

test('runImport: an empty legacy database reports nothing-to-import and becomes terminal', async () => {
  const tmp = tempDir('empty-db');
  const legacyRoot = path.join(tmp, 'legacy');
  fs.mkdirSync(legacyRoot, { recursive: true });
  withWritableDb(path.join(legacyRoot, 'app.db'), (db) => {
    db.exec(RUST_SCHEMA_V1);
    db.exec(RUST_SCHEMA_V2);
    db.exec(RUST_SCHEMA_V3);
  });
  const dataRoot = path.join(tmp, 'data');

  const source = detectLegacy(legacyRoot);
  assert.equal(source?.counts.servers, 0);
  const plan = planImport({ dataRoot, legacyRoot });
  assert.equal(plan.ok, true);
  assert.equal(plan.servers.length, 0);

  const report = await runImport({ dataRoot, legacyRoot });
  assert.equal(report.status, 'nothing-to-import');
  assert.equal(report.alreadyImported, true);
  assert.equal(readImportMarker(dataRoot)?.status, 'nothing-to-import');
  assert.equal(fs.existsSync(path.join(dataRoot, 'servers')), false);

  const second = await runImport({ dataRoot, legacyRoot });
  assert.equal(second.status, 'already-imported');
});

// ------------------------------------------------------------------------------------------------
// Duplicate / merge handling
// ------------------------------------------------------------------------------------------------

test('runImport: duplicate ids/names keep target rows, settings and folders untouched', async () => {
  const tmp = tempDir('merge');
  const legacyRoot = path.join(tmp, 'legacy');
  buildRustFixture(legacyRoot);
  appendLegacyServer(legacyRoot, SERVER_C, 'Gamma');
  const dataRoot = path.join(tmp, 'data');

  const store = new Store(dataRoot);
  const sameId = store.createServer({ name: 'AlphaRenamed', loader: 'Vanilla', mcVersion: '1.18.2', ramMb: 1024 });
  store.updateServer(sameId.id, { id: SERVER_A });
  store.createServer({ name: 'Beta', loader: 'Paper', mcVersion: '1.16.5', ramMb: 512 });
  store.setSetting('theme', 'target-theme');
  store.addBackup({
    id: BACKUP_A,
    serverId: SERVER_A,
    name: 'target-backup',
    path: 'backups/target.zip',
    bytes: 10,
    kind: 'Auto',
    note: 'target owns this id',
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  // Target folder exists for C while its row does not: the folder must be kept, the row imported.
  const sentinelC = path.join(dataRoot, 'servers', SERVER_C, 'sentinel.txt');
  writeIn(dataRoot, `servers/${SERVER_C}/sentinel.txt`, 'keep-me');
  // Target folder for B exists too (duplicate by name means B is not imported at all).
  writeIn(dataRoot, `servers/${SERVER_B}/sentinel.txt`, 'keep-me-too');
  const sourceBefore = treeSnapshot(legacyRoot);

  const report = await runImport({ dataRoot, legacyRoot });

  assert.equal(report.status, 'completed', report.errors.join('; '));
  assert.equal(report.imported.servers, 1); // only Gamma
  assert.equal(report.imported.backups, 0); // backup id owned by the target
  assert.equal(report.imported.settings, 2); // theme collision skipped
  assert.equal(report.duplicates.length, 2);

  const after = new Store(dataRoot);
  const servers = after.listServers();
  const alpha = servers.find((server) => server.id === SERVER_A);
  assert.equal(alpha?.name, 'AlphaRenamed');
  assert.equal(alpha?.mcVersion, '1.18.2');
  assert.equal(servers.find((server) => server.name === 'Beta')?.loader, 'Paper');
  assert.equal(servers.find((server) => server.id === SERVER_C)?.name, 'Gamma');

  // Target rows/settings/backups are never overwritten by legacy data.
  assert.equal(after.getSetting('theme'), 'target-theme');
  const targetBackup = after.getBackup(BACKUP_A);
  assert.equal(targetBackup?.name, 'target-backup');
  assert.equal(targetBackup?.bytes, 10);

  // Existing folders are kept and never merged into; only Gamma's row was created.
  assert.equal(fs.readFileSync(sentinelC, 'utf8'), 'keep-me');
  assert.equal(fs.existsSync(path.join(dataRoot, 'servers', SERVER_C, 'server.properties')), false);
  assert.equal(fs.readFileSync(path.join(dataRoot, 'servers', SERVER_B, 'sentinel.txt'), 'utf8'), 'keep-me-too');
  assert.ok(report.skipped.folders.some((folder) => folder.id === SERVER_C && /already exists/.test(folder.reason)));
  assert.ok(report.skipped.backups.some((backup) => backup.id === BACKUP_A));
  assert.deepEqual(treeSnapshot(legacyRoot), sourceBefore);
});

// ------------------------------------------------------------------------------------------------
// Failure paths
// ------------------------------------------------------------------------------------------------

test('runImport: unknown legacy schema fails explicitly and leaves the target untouched', async () => {
  const tmp = tempDir('unknown-schema');
  const legacyRoot = path.join(tmp, 'legacy');
  fs.mkdirSync(legacyRoot, { recursive: true });
  withWritableDb(path.join(legacyRoot, 'app.db'), (db) => {
    db.exec('CREATE TABLE misc (x TEXT); INSERT INTO misc (x) VALUES (\'y\');');
  });
  const dataRoot = path.join(tmp, 'data');
  const sourceBefore = treeSnapshot(legacyRoot);

  const plan = planImport({ dataRoot, legacyRoot });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /unknown legacy schema/);

  const report = await runImport({ dataRoot, legacyRoot });
  assert.equal(report.status, 'failed');
  assert.match(report.errors.join(' '), /unknown legacy schema/);
  assert.equal(fs.existsSync(path.join(dataRoot, 'app-data.json')), false);
  assert.equal(fs.existsSync(path.join(dataRoot, 'servers')), false);
  assert.equal(readImportMarker(dataRoot)?.status, 'failed');
  assert.deepEqual(treeSnapshot(legacyRoot), sourceBefore);
});

test('runImport: a server-folder copy failure is reported as skipped without partial server rows', async () => {
  const tmp = tempDir('copy-failure');
  const legacyRoot = path.join(tmp, 'legacy');
  buildRustFixture(legacyRoot);
  const dataRoot = path.join(tmp, 'data');
  fs.mkdirSync(dataRoot, { recursive: true });
  // Blocking the copy target: `dataRoot/servers` is a file, so the temp-then-rename copy must fail.
  fs.writeFileSync(path.join(dataRoot, 'servers'), 'not-a-directory');
  const sourceBefore = treeSnapshot(legacyRoot);

  const report = await runImport({ dataRoot, legacyRoot });

  // Server rows are only published after their folder copied; the global settings still merge, so the
  // run is "partial" (retryable), never a silent success.
  assert.equal(report.status, 'partial');
  assert.equal(report.imported.servers, 0);
  assert.equal(report.imported.settings, 3);
  assert.equal(report.skipped.servers.length, 2);
  assert.ok(report.errors.every((error) => /was skipped/.test(error)));
  assert.deepEqual(new Store(dataRoot).listServers(), []);
  assert.equal(fs.existsSync(path.join(dataRoot, 'app-data.json')), true);
  const marker = readImportMarker(dataRoot);
  assert.equal(marker?.status, 'partial');
  assert.ok((marker?.report.skipped.servers.length ?? 0) === 2);
  assert.deepEqual(treeSnapshot(legacyRoot), sourceBefore);
});

// ------------------------------------------------------------------------------------------------
// Prototype schema tolerance (real-world schema variance)
// ------------------------------------------------------------------------------------------------

test('runImport: prototype schema maps distribution/minecraft_version/directory columns', async () => {
  const tmp = tempDir('prototype');
  const legacyRoot = path.join(tmp, 'legacy');
  const { directory } = buildPrototypeFixture(legacyRoot);
  const dataRoot = path.join(tmp, 'data');
  const sourceBefore = treeSnapshot(legacyRoot);

  const plan = planImport({ dataRoot, legacyRoot });
  assert.equal(plan.ok, true, plan.errors.join('; '));
  assert.equal(plan.schemaKind, 'prototype');
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.servers.length, 1);
  assert.equal(plan.servers[0].folder, directory);
  assert.ok(plan.warnings.some((warning) => /prototype schema/.test(warning)));

  const report = await runImport({ dataRoot, legacyRoot });
  assert.equal(report.status, 'completed', report.errors.join('; '));
  assert.equal(report.schemaKind, 'prototype');

  const server = new Store(dataRoot).listServers()[0];
  assert.equal(server.id, PROTO_SERVER);
  assert.equal(server.name, 'Proto');
  assert.equal(server.loader, 'fabric'); // stored as-is, not normalised
  assert.equal(server.mcVersion, '1.21.1');
  assert.equal(server.ramMb, 8192); // max_ram_mb
  assert.equal(server.port, 25565);
  assert.equal(server.eulaAccepted, true);
  assert.equal(server.status, 'stopped');
  assert.equal(server.javaPath, 'C:\\Program Files\\Eclipse Adoptium\\jdk-21\\bin\\java.exe');
  assert.equal(fs.readFileSync(path.join(dataRoot, 'servers', PROTO_SERVER, 'server.properties'), 'utf8'), 'motd=Proto\n');

  const backups = new Store(dataRoot).listBackups(PROTO_SERVER);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].name, 'proto-backup.zip');
  assert.equal(backups[0].bytes, 2048);
  assert.equal(backups[0].kind, 'Auto');
  assert.equal(backups[0].note, 'proto note');
  assert.equal(new Store(dataRoot).getSetting('theme'), 'light');
  assert.deepEqual(treeSnapshot(legacyRoot), sourceBefore);
});
