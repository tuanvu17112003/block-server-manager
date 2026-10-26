// One-shot legacy Tauri (SQLite `app.db`) -> Electron JSON store importer (task WP-1.6 / finding B-13).
//
// PURE NODE MODULE: this file must never import `electron` (or `./paths`, which does) so it can be
// unit-tested with plain `node --test` â€” see electron/test/unit/legacy-import.test.ts. The Electron
// startup hook is wired in main.ts by the Lead via `detectLegacy` / `planImport` / `runImport`.
//
// Legacy layout (Tauri identifier `com.blockserver.manager`, Rust reference src-tauri/src/db/mod.rs):
//   <legacyRoot>/app.db           SQLite v1 servers + v2 console_command_history + v3 managed_server_files
//                                 (also backups / worlds / jobs / settings tables, additive migrations)
//   <legacyRoot>/servers/<id>/    per-server folder (server.jar, mods/, world/, logs/, backups/...)
// A prototype layout under `%APPDATA%\minecraft-server-manager` is tolerated when its columns can be
// mapped (distribution/minecraft_version/min_ram_mb+max_ram_mb/directory/java_runtime_id).
//
// Guarantees:
//  * the source is opened `readOnly:true` and never written, moved or renamed;
//  * target records merge through the existing Store (target wins on duplicate id/name/setting);
//  * a server folder is copied to a temp sibling then renamed into place; an existing target folder is
//    never overwritten and a failed copy is reported as skipped (the server row is not created then);
//  * `<dataRoot>/legacy-import.json` is written even on partial/failed runs; a terminal marker makes a
//    second run return `already-imported` (idempotent, source untouched).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store, type BackupRecord, type ServerDto } from './store';

/** Env override used by tests and by the startup confirmation flow. */
export const LEGACY_ROOT_ENV = 'MSM_LEGACY_ROOT';
/** Marker file written under the Electron data root after an import attempt. */
export const LEGACY_IMPORT_MARKER = 'legacy-import.json';
export const LEGACY_IMPORT_MARKER_VERSION = 1;
/** Rust `MAX_COMMAND_HISTORY` â€” keep the same per-server history retention at import time. */
const MAX_HISTORY_PER_SERVER = 100;
const DEFAULT_PORT = 25565;
const DEFAULT_RAM_MB = 2048;
const BYTES_PER_MB = 1024 * 1024;
const EPOCH_ISO = new Date(0).toISOString();
const LEGACY_DB_FILE = 'app.db';
/** Server ids are uuid/opaque tokens; refuse anything that could escape `servers/<id>` (Rust validate_id). */
const SAFE_SERVER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KNOWN_LOADERS = ['Vanilla', 'Paper', 'Fabric', 'Forge', 'NeoForge'];
const BACKUP_KINDS: BackupRecord['kind'][] = ['Manual', 'Auto', 'Pre-install', 'Pre-restore', 'World-delete'];

// ---------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------

export interface LegacyCounts {
  servers: number;
  backups: number;
  worlds: number;
  jobs: number;
  settings: number;
  consoleHistory: number;
  managedFiles: number;
}

export type LegacyOrigin = 'explicit' | 'env' | 'tauri-identifier' | 'prototype';
export type LegacySchemaKind = 'rust-v1' | 'rust-v2' | 'rust-v3' | 'prototype' | 'unknown';

/** Result of probing a detected legacy root (`null` when no legacy SQLite database exists). */
export interface LegacySource {
  root: string;
  dbPath: string;
  origin: LegacyOrigin;
  /** Additive Rust schema level: 1 (servers), 2 (+console_command_history), 3 (+managed_server_files). */
  schemaVersion: number | null;
  schemaKind: LegacySchemaKind;
  /** SQLite `PRAGMA user_version` when the write side set it (the Rust migrations do not). */
  userVersion: number | null;
  tables: string[];
  counts: LegacyCounts;
  warnings: string[];
  errors: string[];
}

export interface PlannedLegacyServer {
  legacyId: string;
  name: string;
  loader: string;
  mcVersion: string;
  /** Source folder resolved from `<legacyRoot>/servers/<id>` or a prototype `directory` column. */
  folder: string | null;
  folderFound: boolean;
  duplicate: 'id' | 'name' | null;
}

export interface PlannedDuplicate {
  legacyId: string;
  name: string;
  reason: 'id' | 'name';
  matchedId: string;
}

/** Dry-run result: everything the UI/startup hook needs before asking the user to import. */
export interface LegacyImportPlan {
  ok: boolean;
  alreadyImported: boolean;
  markerPath: string;
  legacyRoot: string | null;
  dbPath: string | null;
  origin: LegacyOrigin | null;
  schemaVersion: number | null;
  schemaKind: LegacySchemaKind | null;
  tables: string[];
  counts: LegacyCounts;
  servers: PlannedLegacyServer[];
  duplicates: PlannedDuplicate[];
  folders: { found: number; missing: number };
  backups: { total: number; importable: number; orphaned: number; duplicate: number };
  history: { total: number; importable: number };
  settings: { total: number; importable: number; collisions: number };
  warnings: string[];
  errors: string[];
}

export type LegacyImportStatus = 'completed' | 'partial' | 'failed' | 'already-imported' | 'nothing-to-import';

export interface LegacyImportReport {
  status: LegacyImportStatus;
  alreadyImported: boolean;
  previousImportAt?: string;
  dataRoot: string;
  markerPath: string;
  legacyRoot: string | null;
  dbPath: string | null;
  origin: LegacyOrigin | null;
  schemaVersion: number | null;
  schemaKind: LegacySchemaKind | null;
  startedAt: string;
  finishedAt: string;
  imported: { servers: number; backups: number; history: number; settings: number };
  skipped: {
    servers: { id: string; name: string; reason: string }[];
    backups: { id: string; reason: string }[];
    history: number;
    settings: number;
    folders: { id: string; reason: string }[];
  };
  foldersCopied: string[];
  duplicates: PlannedDuplicate[];
  counts: LegacyCounts;
  errors: string[];
  warnings: string[];
  /** Human-readable notes describing any target cleanup performed after a partial failure. */
  rollbackNotes: string[];
}

export interface LegacyImportMarker {
  markerVersion: number;
  source: string;
  sourceDb: string;
  sourceOrigin: LegacyOrigin;
  schemaVersion: number | null;
  schemaKind: LegacySchemaKind | null;
  timestamp: string;
  status: LegacyImportStatus;
  report: LegacyImportReport;
}

export interface LegacyImportOptions {
  /** Electron data root (`<userData>/data` prod or `<project>/.app-data` dev). */
  dataRoot: string;
  /** Optional explicit legacy root; falls back to MSM_LEGACY_ROOT then the APPDATA candidates. */
  legacyRoot?: string;
}

// ---------------------------------------------------------------------------------------------------
// Internal row/model types
// ---------------------------------------------------------------------------------------------------

interface MappedLegacyServer {
  id: string;
  name: string;
  loader: string;
  mcVersion: string;
  loaderVersion: string | null;
  modpackId: string | null;
  port: number;
  ramMb: number;
  javaPath: string | null;
  eulaAccepted: boolean;
  createdAt: string;
  /** Prototype schema: absolute server folder recorded in the DB. */
  directory: string | null;
  installState: string | null;
  legacyStatus: string | null;
}

interface MappedLegacyBackup {
  id: string;
  serverId: string;
  name: string;
  path: string;
  bytes: number;
  kind: BackupRecord['kind'];
  note: string;
  createdAt: string;
}

interface MappedHistoryRow {
  serverId: string;
  command: string;
  createdAt: string;
  order: number;
}

interface MappedSettingRow {
  key: string;
  value: unknown;
}

interface LegacyDataset {
  tables: string[];
  userVersion: number | null;
  schemaVersion: number | null;
  schemaKind: LegacySchemaKind;
  counts: LegacyCounts;
  servers: MappedLegacyServer[];
  backups: MappedLegacyBackup[];
  history: MappedHistoryRow[];
  settings: MappedSettingRow[];
  warnings: string[];
  errors: string[];
}

interface TargetSnapshot {
  store: Store;
  servers: ServerDto[];
  serverIds: Set<string>;
  names: Set<string>;
  backupIds: Set<string>;
}

interface LoadedPlan {
  source: LegacySource | null;
  dataset: LegacyDataset | null;
  target: TargetSnapshot | null;
  plan: LegacyImportPlan;
}

// ---------------------------------------------------------------------------------------------------
// Small value helpers (SQLite returns number | bigint | string | Uint8Array | null)
// ---------------------------------------------------------------------------------------------------

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'bigint') return value !== 0n;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }
  return false;
}

function pickString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const candidate = asString(row[key]);
    if (candidate !== null && candidate !== '') return candidate;
  }
  return null;
}

function pickNumber(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const candidate = asNumber(row[key]);
    if (candidate !== null) return candidate;
  }
  return null;
}

function emptyCounts(): LegacyCounts {
  return { servers: 0, backups: 0, worlds: 0, jobs: 0, settings: 0, consoleHistory: 0, managedFiles: 0 };
}

function isDirectory(candidate: string | null | undefined): candidate is string {
  if (!candidate) return false;
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------------------------------
// Legacy root detection
// ---------------------------------------------------------------------------------------------------

/** Default APPDATA candidates, newest identifier first, then the tolerated prototype directory. */
function defaultLegacyRoots(): { root: string; origin: LegacyOrigin }[] {
  const appData = process.env.APPDATA?.trim();
  if (!appData) return [];
  return [
    { root: path.join(appData, 'com.blockserver.manager'), origin: 'tauri-identifier' },
    { root: path.join(appData, 'minecraft-server-manager'), origin: 'prototype' },
  ];
}

/**
 * Probe a legacy data root (or `MSM_LEGACY_ROOT` / the default APPDATA candidates when omitted).
 * Returns `null` when no candidate has a non-empty `app.db`; otherwise a source descriptor whose
 * `errors` explain schema/read problems (an `ok:false` import plan).
 */
export function detectLegacy(root?: string): LegacySource | null {
  const explicit = root?.trim();
  const envRoot = process.env[LEGACY_ROOT_ENV]?.trim();
  let candidates: { root: string; origin: LegacyOrigin }[] = [];
  if (explicit) candidates = [{ root: explicit, origin: 'explicit' }];
  else if (envRoot) candidates = [{ root: envRoot, origin: 'env' }];
  else candidates = defaultLegacyRoots();

  for (const candidate of candidates) {
    if (!isDirectory(candidate.root)) continue;
    const dbPath = path.join(candidate.root, LEGACY_DB_FILE);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dbPath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0) continue;
    return inspectLegacySource(candidate.root, dbPath, candidate.origin);
  }
  return null;
}

function inspectLegacySource(root: string, dbPath: string, origin: LegacyOrigin): LegacySource {
  const base: LegacySource = {
    root,
    dbPath,
    origin,
    schemaVersion: null,
    schemaKind: 'unknown',
    userVersion: null,
    tables: [],
    counts: emptyCounts(),
    warnings: [],
    errors: [],
  };
  let read: { dataset: LegacyDataset; usedCopy: boolean };
  try {
    read = openAndInspect(dbPath, root);
  } catch (error) {
    base.errors.push(`cannot read legacy database ${dbPath}: ${errorMessage(error)}`);
    return base;
  }
  const { dataset, usedCopy } = read;
  base.warnings.push(...dataset.warnings);
  // Row-level data problems (bad id/name, unreadable optional table) are reported but do not block the
  // import: valid rows still import and each skipped row is listed in the run report.
  base.warnings.push(...dataset.errors.map((error) => `data issue: ${error}`));
  if (usedCopy) {
    base.warnings.push('opened a temporary read-only copy of the legacy database (WAL/lock fallback)');
  }
  base.schemaVersion = dataset.schemaVersion;
  base.schemaKind = dataset.schemaKind;
  base.userVersion = dataset.userVersion;
  base.tables = dataset.tables;
  base.counts = dataset.counts;
  if (dataset.schemaKind === 'unknown') {
    base.errors.push(
      `unknown legacy schema at ${dbPath}: expected a 'servers' table with Rust (loader/mc_version) or ` +
        `prototype (distribution/minecraft_version) columns; found tables [${dataset.tables.join(', ')}]`,
    );
  }
  return base;
}

// ---------------------------------------------------------------------------------------------------
// Read-only SQLite access (with WAL/lock tolerant fallback copy)
// ---------------------------------------------------------------------------------------------------

function openAndInspect(dbPath: string, legacyRoot: string): { dataset: LegacyDataset; usedCopy: boolean } {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return { dataset: inspectDatabase(db, legacyRoot), usedCopy: false };
    } finally {
      db.close();
    }
  } catch (primary) {
    // Read-only opens of WAL databases can fail when the -shm sidecar cannot be created, and an app
    // still holding the DB can lock it. Fall back to a private temp copy so the source stays untouched.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-legacy-db-'));
    try {
      for (const suffix of ['', '-wal', '-shm']) {
        const from = dbPath + suffix;
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(tempDir, LEGACY_DB_FILE + suffix));
      }
      const copy = path.join(tempDir, LEGACY_DB_FILE);
      if (!fs.existsSync(copy)) throw primary;
      const db = new DatabaseSync(copy, { readOnly: true });
      try {
        return { dataset: inspectDatabase(db, legacyRoot), usedCopy: true };
      } finally {
        db.close();
      }
    } catch (fallback) {
      throw new Error(`${errorMessage(primary)} (fallback copy also failed: ${errorMessage(fallback)})`);
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* best effort cleanup */
      }
    }
  }
}

function tableNames(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  return rows.map((row) => asString(row.name)).filter((name): name is string => name !== null);
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  if (!SAFE_TABLE_NAME.test(table)) return [];
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all();
  return rows.map((row) => asString(row.name)).filter((name): name is string => name !== null);
}

function readRows(db: DatabaseSync, table: string): Record<string, unknown>[] {
  if (!SAFE_TABLE_NAME.test(table)) return [];
  return db.prepare(`SELECT * FROM "${table}"`).all();
}

function countRows(db: DatabaseSync, tables: string[], table: string): number {
  if (!tables.includes(table)) return 0;
  try {
    const row = db.prepare(`SELECT COUNT(*) AS total FROM "${table}"`).get();
    return row ? asNumber(row.total) ?? 0 : 0;
  } catch {
    return 0;
  }
}

function detectSchemaKind(tables: string[], serverColumns: string[]): LegacySchemaKind {
  if (!tables.includes('servers')) return 'unknown';
  if (tables.includes('managed_server_files')) return 'rust-v3';
  if (tables.includes('console_command_history')) return 'rust-v2';
  if (serverColumns.includes('loader') || serverColumns.includes('mc_version')) return 'rust-v1';
  if (serverColumns.includes('distribution') || serverColumns.includes('minecraft_version')) return 'prototype';
  return 'unknown';
}

function schemaVersionOf(kind: LegacySchemaKind): number | null {
  if (kind === 'rust-v1') return 1;
  if (kind === 'rust-v2') return 2;
  if (kind === 'rust-v3') return 3;
  if (kind === 'prototype') return 1;
  return null;
}

function inspectDatabase(db: DatabaseSync, legacyRoot: string): LegacyDataset {
  const warnings: string[] = [];
  const errors: string[] = [];
  const tables = tableNames(db);
  const serverColumns = tables.includes('servers') ? tableColumns(db, 'servers') : [];
  const schemaKind = detectSchemaKind(tables, serverColumns);
  const dataset: LegacyDataset = {
    tables,
    userVersion: readUserVersion(db),
    schemaVersion: schemaVersionOf(schemaKind),
    schemaKind,
    counts: emptyCounts(),
    servers: [],
    backups: [],
    history: [],
    settings: [],
    warnings,
    errors,
  };
  if (schemaKind === 'unknown') return dataset;
  if (schemaKind === 'prototype') {
    warnings.push('legacy app.db uses the prototype schema; columns are mapped to the current ServerDto');
  }

  dataset.counts = {
    servers: countRows(db, tables, 'servers'),
    backups: countRows(db, tables, 'backups'),
    worlds: countRows(db, tables, 'worlds'),
    jobs: countRows(db, tables, 'jobs'),
    settings: tables.includes('settings')
      ? countRows(db, tables, 'settings')
      : countRows(db, tables, 'app_settings'),
    consoleHistory: countRows(db, tables, 'console_command_history'),
    managedFiles: countRows(db, tables, 'managed_server_files'),
  };

  const javaRuntimePaths = readJavaRuntimePaths(db, tables);
  readServersInto(db, dataset, javaRuntimePaths);
  readBackupsInto(db, dataset, legacyRoot);
  readHistoryInto(db, dataset);
  readSettingsInto(db, dataset);
  return dataset;
}

function readUserVersion(db: DatabaseSync): number | null {
  try {
    const row = db.prepare('PRAGMA user_version').get();
    return row ? asNumber(row.user_version) : null;
  } catch {
    return null;
  }
}

/** Prototype schema only: `servers.java_runtime_id` -> `java_runtimes.executable_path`. */
function readJavaRuntimePaths(db: DatabaseSync, tables: string[]): Map<string, string> {
  const paths = new Map<string, string>();
  if (!tables.includes('java_runtimes')) return paths;
  try {
    const columns = tableColumns(db, 'java_runtimes');
    if (!columns.includes('id') || !columns.includes('executable_path')) return paths;
    for (const row of readRows(db, 'java_runtimes')) {
      const id = asString(row.id);
      const executable = asString(row.executable_path);
      if (id && executable) paths.set(id, executable);
    }
  } catch {
    /* optional enrichment only */
  }
  return paths;
}

function readServersInto(db: DatabaseSync, dataset: LegacyDataset, javaRuntimePaths: Map<string, string>): void {
  let rows: Record<string, unknown>[];
  try {
    rows = readRows(db, 'servers');
  } catch (error) {
    dataset.errors.push(`cannot read legacy servers table: ${errorMessage(error)}`);
    return;
  }
  for (const row of rows) {
    const mapped = mapServerRow(row, javaRuntimePaths);
    if (typeof mapped === 'string') {
      dataset.errors.push(mapped);
      continue;
    }
    dataset.servers.push(mapped);
    const legacyStatus = mapped.legacyStatus;
    if (legacyStatus && !['stopped', 'running', 'starting', 'stopping', 'crashed'].includes(legacyStatus)) {
      dataset.warnings.push(
        `server "${mapped.name}" had legacy status "${legacyStatus}" (install state "${mapped.installState ?? 'n/a'}"); ` +
          'imported with status "stopped"',
      );
    }
    if (!KNOWN_LOADERS.includes(mapped.loader)) {
      dataset.warnings.push(
        `server "${mapped.name}" loader "${mapped.loader}" was imported as stored but is not one of ` +
          `[${KNOWN_LOADERS.join(', ')}]`,
      );
    }
    if (!mapped.mcVersion) dataset.warnings.push(`server "${mapped.name}" has no Minecraft version in app.db`);
  }
}

function mapServerRow(
  row: Record<string, unknown>,
  javaRuntimePaths: Map<string, string>,
): MappedLegacyServer | string {
  const rawId = pickString(row, ['id']);
  const id = rawId?.trim() ?? '';
  if (!SAFE_SERVER_ID.test(id)) {
    return `skipping legacy server row with unsafe/empty id ${JSON.stringify(rawId)} (path-safety rule)`;
  }
  const name = (pickString(row, ['name']) ?? '').trim();
  if (!name) return `skipping legacy server ${id}: empty name`;
  const loader = pickString(row, ['loader', 'distribution']) ?? 'Vanilla';
  const mcVersion = pickString(row, ['mc_version', 'minecraft_version']) ?? '';
  const javaRuntimeId = pickString(row, ['java_runtime_id']);
  return {
    id,
    name,
    loader,
    mcVersion,
    loaderVersion: pickString(row, ['loader_version']),
    modpackId: pickString(row, ['modpack_id']),
    port: Math.trunc(pickNumber(row, ['port']) ?? DEFAULT_PORT),
    ramMb: Math.trunc(pickNumber(row, ['ram_mb', 'max_ram_mb', 'min_ram_mb']) ?? DEFAULT_RAM_MB),
    javaPath: pickString(row, ['java_path']) ?? (javaRuntimeId ? javaRuntimePaths.get(javaRuntimeId) ?? null : null),
    eulaAccepted: asBoolean(row.eula_accepted),
    createdAt: pickString(row, ['created_at', 'updated_at']) ?? EPOCH_ISO,
    directory: pickString(row, ['directory']),
    installState: pickString(row, ['install_state']),
    legacyStatus: pickString(row, ['status', 'install_state']),
  };
}

function normalizeBackupKind(raw: string | null): BackupRecord['kind'] {
  if (!raw) return 'Manual';
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'manual') return 'Manual';
  if (normalized === 'auto') return 'Auto';
  if (normalized === 'pre-install' || normalized === 'preinstall') return 'Pre-install';
  if (normalized === 'pre-restore' || normalized === 'prerestore') return 'Pre-restore';
  if (normalized === 'world-delete' || normalized === 'worlddelete') return 'World-delete';
  return BACKUP_KINDS.find((kind) => kind.toLowerCase() === normalized) ?? 'Manual';
}

function readBackupsInto(db: DatabaseSync, dataset: LegacyDataset, legacyRoot: string): void {
  if (!dataset.tables.includes('backups')) return;
  let rows: Record<string, unknown>[];
  try {
    rows = readRows(db, 'backups');
  } catch (error) {
    dataset.errors.push(`cannot read legacy backups table: ${errorMessage(error)}`);
    return;
  }
  for (const row of rows) {
    const id = pickString(row, ['id'])?.trim() ?? '';
    const serverId = pickString(row, ['server_id'])?.trim() ?? '';
    if (!id || !SAFE_SERVER_ID.test(serverId)) {
      dataset.warnings.push(`skipping legacy backup row ${JSON.stringify(id)} (missing id/server_id)`);
      continue;
    }
    const sizeBytes = pickNumber(row, ['size_bytes']);
    const sizeMb = pickNumber(row, ['size_mb']);
    const filePath = pickString(row, ['path', 'file_path']) ?? '';
    const name = pickString(row, ['name', 'file_name']) ?? (filePath ? path.basename(filePath) : id);
    // Legacy rows store either an absolute path or one relative to the Tauri app-data root; resolve the
    // relative form so `backups_restore` can still find the archive after the JSON import.
    const resolvedPath = filePath && !path.isAbsolute(filePath) ? path.resolve(legacyRoot, filePath) : filePath;
    dataset.backups.push({
      id,
      serverId,
      name,
      path: resolvedPath,
      bytes: Math.max(0, Math.trunc(sizeBytes ?? (sizeMb ?? 0) * BYTES_PER_MB)),
      kind: normalizeBackupKind(pickString(row, ['kind', 'type'])),
      note: pickString(row, ['note']) ?? '',
      createdAt: pickString(row, ['created_at']) ?? EPOCH_ISO,
    });
  }
}

function readHistoryInto(db: DatabaseSync, dataset: LegacyDataset): void {
  if (!dataset.tables.includes('console_command_history')) return;
  let rows: Record<string, unknown>[];
  try {
    rows = readRows(db, 'console_command_history');
  } catch (error) {
    dataset.errors.push(`cannot read legacy console_command_history table: ${errorMessage(error)}`);
    return;
  }
  let order = 0;
  for (const row of rows) {
    const serverId = pickString(row, ['server_id'])?.trim() ?? '';
    const command = asString(row.command)?.trim() ?? '';
    if (!SAFE_SERVER_ID.test(serverId) || !command) continue;
    dataset.history.push({
      serverId,
      command,
      createdAt: pickString(row, ['created_at']) ?? EPOCH_ISO,
      order: Math.trunc(pickNumber(row, ['id']) ?? order),
    });
    order += 1;
  }
}

function readSettingsInto(db: DatabaseSync, dataset: LegacyDataset): void {
  const table = dataset.tables.includes('settings')
    ? 'settings'
    : dataset.tables.includes('app_settings')
      ? 'app_settings'
      : null;
  if (!table) return;
  let rows: Record<string, unknown>[];
  try {
    rows = readRows(db, table);
  } catch (error) {
    dataset.errors.push(`cannot read legacy ${table} table: ${errorMessage(error)}`);
    return;
  }
  for (const row of rows) {
    const key = pickString(row, ['key'])?.trim() ?? '';
    if (!key) continue;
    dataset.settings.push({ key, value: parseSettingValue(asString(row.value) ?? '') });
  }
}

/** Legacy `settings.value` is TEXT; the Rust side serialised JSON values, prototypes often wrote raw strings. */
function parseSettingValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------------------------------
// Folder planning / copying
// ---------------------------------------------------------------------------------------------------

function legacyServerFolder(legacyRoot: string, server: MappedLegacyServer): string | null {
  const byId = path.join(legacyRoot, 'servers', server.id);
  if (isDirectory(byId)) return byId;
  if (isDirectory(server.directory)) return server.directory;
  return null;
}

/**
 * Copy a legacy folder to a hidden temp sibling inside the target parent, then rename it into place.
 * `renameSync` is atomic per volume and fails if the target appeared meanwhile â€” never overwriting it.
 */
async function copyFolderAtomic(source: string, target: string): Promise<void> {
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const temp = path.join(parent, `.legacy-import-${path.basename(target)}-${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.promises.cp(source, temp, { recursive: true, force: true, errorOnExist: false, dereference: false });
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.rmSync(temp, { recursive: true, force: true });
    } catch {
      /* best effort cleanup; the temp dir name cannot collide with a server id */
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------
// Marker handling
// ---------------------------------------------------------------------------------------------------

/** Read `<dataRoot>/legacy-import.json`; returns `null` when absent/corrupt (corruption is non-fatal). */
export function readImportMarker(dataRoot: string): LegacyImportMarker | null {
  const markerPath = path.join(dataRoot, LEGACY_IMPORT_MARKER);
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Partial<LegacyImportMarker>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (parsed.markerVersion !== LEGACY_IMPORT_MARKER_VERSION) return null;
    if (typeof parsed.status !== 'string' || typeof parsed.timestamp !== 'string') return null;
    return parsed as LegacyImportMarker;
  } catch {
    return null;
  }
}

function markerTerminal(marker: LegacyImportMarker | null): boolean {
  return marker !== null && (marker.status === 'completed' || marker.status === 'nothing-to-import');
}

function writeMarker(dataRoot: string, marker: LegacyImportMarker): string {
  const markerPath = path.join(dataRoot, LEGACY_IMPORT_MARKER);
  fs.mkdirSync(dataRoot, { recursive: true });
  const temp = markerPath + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(marker, null, 2));
  fs.renameSync(temp, markerPath);
  return markerPath;
}

// ---------------------------------------------------------------------------------------------------
// Target snapshot (existing JSON store)
// ---------------------------------------------------------------------------------------------------

function loadTargetSnapshot(dataRoot: string): TargetSnapshot {
  const store = new Store(dataRoot);
  const servers = store.listServers();
  const backupIds = new Set<string>();
  for (const server of servers) {
    for (const backup of store.listBackups(server.id)) backupIds.add(backup.id);
  }
  return {
    store,
    servers,
    serverIds: new Set(servers.map((server) => server.id)),
    names: new Set(servers.map((server) => server.name)),
    backupIds,
  };
}

// ---------------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------------

function emptyPlan(dataRoot: string): LegacyImportPlan {
  return {
    ok: false,
    alreadyImported: false,
    markerPath: path.join(dataRoot, LEGACY_IMPORT_MARKER),
    legacyRoot: null,
    dbPath: null,
    origin: null,
    schemaVersion: null,
    schemaKind: null,
    tables: [],
    counts: emptyCounts(),
    servers: [],
    duplicates: [],
    folders: { found: 0, missing: 0 },
    backups: { total: 0, importable: 0, orphaned: 0, duplicate: 0 },
    history: { total: 0, importable: 0 },
    settings: { total: 0, importable: 0, collisions: 0 },
    warnings: [],
    errors: [],
  };
}

function loadPlan(options: LegacyImportOptions): LoadedPlan {
  const plan = emptyPlan(options.dataRoot);
  const source = detectLegacy(options.legacyRoot);
  if (!source) {
    const requested = options.legacyRoot?.trim() ?? process.env[LEGACY_ROOT_ENV]?.trim() ?? null;
    plan.errors.push(
      requested
        ? `legacy data root not found or has no non-empty ${LEGACY_DB_FILE}: ${requested}`
        : 'no legacy Tauri data root found (checked MSM_LEGACY_ROOT and the APPDATA candidates)',
    );
    return { source: null, dataset: null, target: null, plan };
  }
  plan.legacyRoot = source.root;
  plan.dbPath = source.dbPath;
  plan.origin = source.origin;
  plan.schemaVersion = source.schemaVersion;
  plan.schemaKind = source.schemaKind;
  plan.tables = source.tables;
  plan.counts = source.counts;
  plan.warnings.push(...source.warnings);
  plan.errors.push(...source.errors);
  plan.alreadyImported = markerTerminal(readImportMarker(options.dataRoot));
  if (source.schemaKind === 'unknown' || source.errors.length > 0) return { source, dataset: null, target: null, plan };

  let dataset: LegacyDataset;
  try {
    dataset = openAndInspect(source.dbPath, source.root).dataset;
  } catch (error) {
    plan.errors.push(`cannot read legacy database ${source.dbPath}: ${errorMessage(error)}`);
    return { source, dataset: null, target: null, plan };
  }
  let target: TargetSnapshot;
  try {
    target = loadTargetSnapshot(options.dataRoot);
  } catch (error) {
    plan.errors.push(`cannot read the current Electron store at ${options.dataRoot}: ${errorMessage(error)}`);
    return { source, dataset, target: null, plan };
  }

  const duplicates: PlannedDuplicate[] = [];
  const seenBatchIds = new Set<string>();
  const seenBatchNames = new Set<string>();
  for (const server of dataset.servers) {
    let duplicate: 'id' | 'name' | null = null;
    if (target.serverIds.has(server.id) || seenBatchIds.has(server.id)) {
      duplicate = 'id';
      duplicates.push({ legacyId: server.id, name: server.name, reason: 'id', matchedId: server.id });
    } else if (target.names.has(server.name) || seenBatchNames.has(server.name)) {
      duplicate = 'name';
      const matchedId = target.servers.find((candidate) => candidate.name === server.name)?.id ?? server.id;
      duplicates.push({ legacyId: server.id, name: server.name, reason: 'name', matchedId });
    }
    seenBatchIds.add(server.id);
    seenBatchNames.add(server.name);
    const folder = legacyServerFolder(source.root, server);
    plan.servers.push({
      legacyId: server.id,
      name: server.name,
      loader: server.loader,
      mcVersion: server.mcVersion,
      folder,
      folderFound: folder !== null,
      duplicate,
    });
  }
  plan.duplicates = duplicates;
  plan.folders.found = plan.servers.filter((server) => server.folderFound).length;
  plan.folders.missing = plan.servers.filter((server) => !server.folderFound).length;

  // Server ids that will exist in the target after the import (existing + non-duplicate imports).
  const targetServerIds = new Set(target.serverIds);
  for (const server of plan.servers) if (server.duplicate === null) targetServerIds.add(server.legacyId);

  const plannedBackupIds = new Set<string>();
  for (const backup of dataset.backups) {
    if (!targetServerIds.has(backup.serverId)) {
      plan.backups.orphaned += 1;
      continue;
    }
    if (target.backupIds.has(backup.id) || plannedBackupIds.has(backup.id)) {
      plan.backups.duplicate += 1;
      continue;
    }
    plannedBackupIds.add(backup.id);
    plan.backups.importable += 1;
  }
  plan.backups.total = dataset.backups.length;

  const historyFor = dataset.history.filter((row) => targetServerIds.has(row.serverId)).length;
  plan.history.total = dataset.history.length;
  plan.history.importable = historyFor;

  for (const setting of dataset.settings) {
    try {
      if (target.store.getSetting(setting.key) !== null) plan.settings.collisions += 1;
      else plan.settings.importable += 1;
    } catch (error) {
      plan.errors.push(`cannot read current settings while planning setting "${setting.key}": ${errorMessage(error)}`);
    }
  }
  plan.settings.total = dataset.settings.length;

  plan.ok = plan.errors.length === 0;
  return { source, dataset, target, plan };
}

/** Dry-run: detect + map the legacy database and diff it against the current JSON store (no writes). */
export function planImport(options: LegacyImportOptions): LegacyImportPlan {
  return loadPlan(options).plan;
}

// ---------------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------------

function serverImportInput(server: MappedLegacyServer): Parameters<Store['createServer']>[0] {
  return {
    name: server.name,
    loader: server.loader,
    mcVersion: server.mcVersion,
    loaderVersion: server.loaderVersion ?? undefined,
    modpackId: server.modpackId ?? undefined,
    port: server.port,
    ramMb: server.ramMb,
    javaPath: server.javaPath ?? undefined,
    eulaAccepted: server.eulaAccepted,
  };
}

/**
 * Recreate the legacy server row through the Store and then restore the original id/fields.
 * `createServer` always allocates a fresh UUID; the follow-up `updateServer` patch keeps the legacy id
 * so existing `servers/<id>` folders, backups and command history stay addressable.
 */
function importServerRow(store: Store, server: MappedLegacyServer): ServerDto {
  const created = store.createServer(serverImportInput(server));
  return store.updateServer(created.id, {
    id: server.id,
    loaderVersion: server.loaderVersion,
    modpackId: server.modpackId,
    javaPath: server.javaPath,
    eulaAccepted: server.eulaAccepted,
    status: 'stopped',
    createdAt: server.createdAt,
  });
}

function importBackupRow(store: Store, backup: MappedLegacyBackup): BackupRecord {
  return store.addBackup({
    id: backup.id,
    serverId: backup.serverId,
    name: backup.name,
    path: backup.path,
    bytes: backup.bytes,
    kind: backup.kind,
    note: backup.note,
    createdAt: backup.createdAt,
  });
}

function buildReport(
  dataRoot: string,
  plan: LegacyImportPlan,
  startedAt: string,
  finishedAt: string,
): LegacyImportReport {
  return {
    status: 'failed',
    alreadyImported: false,
    dataRoot,
    markerPath: path.join(dataRoot, LEGACY_IMPORT_MARKER),
    legacyRoot: plan.legacyRoot,
    dbPath: plan.dbPath,
    origin: plan.origin,
    schemaVersion: plan.schemaVersion,
    schemaKind: plan.schemaKind,
    startedAt,
    finishedAt,
    imported: { servers: 0, backups: 0, history: 0, settings: 0 },
    skipped: { servers: [], backups: [], history: 0, settings: 0, folders: [] },
    foldersCopied: [],
    duplicates: [],
    counts: emptyCounts(),
    errors: [],
    warnings: [],
    rollbackNotes: [],
  };
}

function writeMarkerFor(dataRoot: string, report: LegacyImportReport, source: LegacySource): string {
  const marker: LegacyImportMarker = {
    markerVersion: LEGACY_IMPORT_MARKER_VERSION,
    source: source.root,
    sourceDb: source.dbPath,
    sourceOrigin: source.origin,
    schemaVersion: source.schemaVersion,
    schemaKind: source.schemaKind,
    timestamp: report.finishedAt,
    status: report.status,
    report,
  };
  return writeMarker(dataRoot, marker);
}

/**
 * Import legacy Tauri data into `<dataRoot>/app-data.json` and copy server folders.
 *
 * Idempotent: a terminal marker returns `already-imported` without touching anything; a partial run is
 * safe to retry (rows/folders/settings already present are skipped). The marker is written even when
 * the import fails or is partial. Returns the report instead of throwing — a failure report is the API
 * contract because the startup hook must never crash on legacy data it cannot read.
 */
export async function runImport(options: LegacyImportOptions): Promise<LegacyImportReport> {
  const startedAt = nowIso();
  const existingMarker = readImportMarker(options.dataRoot);
  if (!markerTerminal(existingMarker)) {
    try {
      return await importLegacy(options, startedAt);
    } catch (error) {
      // Unexpected failure outside the per-item guards: still return a report and try to persist it.
      const report = buildReport(options.dataRoot, emptyPlan(options.dataRoot), startedAt, nowIso());
      report.status = 'failed';
      report.finishedAt = nowIso();
      report.errors.push(`legacy import aborted: ${errorMessage(error)}`);
      try {
        const source = detectLegacy(options.legacyRoot);
        if (source) {
          report.legacyRoot = source.root;
          report.dbPath = source.dbPath;
          report.origin = source.origin;
          report.schemaVersion = source.schemaVersion;
          report.schemaKind = source.schemaKind;
          report.markerPath = writeMarkerSafely(options.dataRoot, report, source);
        }
      } catch {
        /* marker persistence is best-effort on an already-unexpected failure */
      }
      return report;
    }
  }

  const report = buildReport(options.dataRoot, emptyPlan(options.dataRoot), startedAt, nowIso());
  report.status = 'already-imported';
  report.alreadyImported = true;
  report.previousImportAt = existingMarker?.timestamp;
  if (existingMarker) {
    report.legacyRoot = existingMarker.source;
    report.dbPath = existingMarker.sourceDb;
    report.origin = existingMarker.sourceOrigin;
    report.schemaVersion = existingMarker.schemaVersion;
    report.schemaKind = existingMarker.schemaKind;
  }
  return report;
}

async function importLegacy(options: LegacyImportOptions, startedAt: string): Promise<LegacyImportReport> {
  const loaded = loadPlan(options);
  const plan = loaded.plan;
  const report = buildReport(options.dataRoot, plan, startedAt, nowIso());
  report.duplicates = plan.duplicates;
  report.counts = plan.counts;
  report.warnings.push(...plan.warnings);
  report.errors.push(...plan.errors);

  const source = loaded.source;
  const dataset = loaded.dataset;
  const target = loaded.target;
  if (!plan.ok || !source || !dataset || !target) {
    report.status = 'failed';
    report.finishedAt = nowIso();
    report.markerPath = writeMarkerSafely(options.dataRoot, report, source);
    return report;
  }

  // Mutable import state.
  const serverIds = new Set(target.serverIds);
  const backupIds = new Set(target.backupIds);

  const importableServers = plan.servers.filter((server) => server.duplicate === null);
  const importableById = new Map(dataset.servers.map((server) => [server.id, server]));

  // --- 1. Servers (+ folders) -----------------------------------------------------------------------
  try {
    fs.mkdirSync(options.dataRoot, { recursive: true });
  } catch (error) {
    report.errors.push(`cannot create data root ${options.dataRoot}: ${errorMessage(error)}`);
    report.status = 'failed';
    report.finishedAt = nowIso();
    report.markerPath = writeMarkerSafely(options.dataRoot, report, source);
    return report;
  }
  const store = new Store(options.dataRoot);
  const serversRoot = path.join(options.dataRoot, 'servers');

  for (const planned of importableServers) {
    const server = importableById.get(planned.legacyId);
    if (!server) continue;
    let copied = false;
    try {
      if (planned.folder) {
        const targetFolder = path.join(serversRoot, server.id);
        if (fs.existsSync(targetFolder)) {
          report.skipped.folders.push({ id: server.id, reason: 'target folder already exists (kept, not overwritten)' });
          report.warnings.push(`server "${server.name}": kept existing target folder servers/${server.id}`);
        } else {
          await copyFolderAtomic(planned.folder, targetFolder);
          copied = true;
          report.foldersCopied.push(server.id);
        }
      } else {
        report.warnings.push(`server "${server.name}": no legacy folder found (row imported without files)`);
      }
      importServerRow(store, server);
      serverIds.add(server.id);
      report.imported.servers += 1;
    } catch (error) {
      report.errors.push(`server "${server.name}" (${server.id}) was skipped: ${errorMessage(error)}`);
      report.skipped.servers.push({ id: server.id, name: server.name, reason: errorMessage(error) });
      if (copied) {
        try {
          fs.rmSync(path.join(serversRoot, server.id), { recursive: true, force: true });
          report.rollbackNotes.push(`removed partially imported folder servers/${server.id} (row was not created)`);
        } catch (cleanupError) {
          report.rollbackNotes.push(
            `could not remove copied folder servers/${server.id}: ${errorMessage(cleanupError)} (delete it manually)`,
          );
        }
      }
    }
  }

  // --- 2. Backups -----------------------------------------------------------------------------------
  for (const backup of dataset.backups) {
    if (!serverIds.has(backup.serverId)) {
      report.skipped.backups.push({ id: backup.id, reason: `server ${backup.serverId} was not imported` });
      continue;
    }
    if (backupIds.has(backup.id)) {
      report.skipped.backups.push({ id: backup.id, reason: 'backup id already exists in the target store' });
      continue;
    }
    try {
      importBackupRow(store, backup);
      backupIds.add(backup.id);
      report.imported.backups += 1;
    } catch (error) {
      report.errors.push(`backup ${backup.id} was skipped: ${errorMessage(error)}`);
      report.skipped.backups.push({ id: backup.id, reason: errorMessage(error) });
    }
  }

  // --- 3. Console command history (newest MAX_HISTORY_PER_SERVER per server, oldest first) ----------
  const historyByServer = new Map<string, MappedHistoryRow[]>();
  for (const row of dataset.history) {
    if (!serverIds.has(row.serverId)) {
      report.skipped.history += 1;
      continue;
    }
    const bucket = historyByServer.get(row.serverId);
    if (bucket) bucket.push(row);
    else historyByServer.set(row.serverId, [row]);
  }
  for (const [serverId, rows] of historyByServer) {
    rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.order - right.order);
    const recent = rows.slice(-MAX_HISTORY_PER_SERVER);
    try {
      const existing = new Set(store.commandHistory(serverId));
      for (const row of recent) {
        if (existing.has(row.command)) {
          report.skipped.history += 1;
          continue;
        }
        // Store.pushCommand timestamps the row at import time (the JSON history entry has no source ts).
        store.pushCommand(serverId, row.command);
        existing.add(row.command);
        report.imported.history += 1;
      }
    } catch (error) {
      report.errors.push(`history for server ${serverId} was skipped: ${errorMessage(error)}`);
    }
  }

  // --- 4. Global settings (target wins on key collisions) -------------------------------------------
  for (const setting of dataset.settings) {
    try {
      if (store.getSetting(setting.key) !== null) {
        report.skipped.settings += 1;
        continue;
      }
      store.setSetting(setting.key, setting.value);
      report.imported.settings += 1;
    } catch (error) {
      report.errors.push(`setting "${setting.key}" was skipped: ${errorMessage(error)}`);
      report.skipped.settings += 1;
    }
  }

  // --- 5. Report + marker --------------------------------------------------------------------------
  const importedTotal =
    report.imported.servers + report.imported.backups + report.imported.history + report.imported.settings;
  const hadWork =
    plan.counts.servers + plan.counts.backups + plan.counts.consoleHistory + plan.counts.settings + plan.counts.worlds + plan.counts.jobs > 0;
  if (report.errors.length > 0) report.status = importedTotal > 0 ? 'partial' : 'failed';
  else if (!hadWork) report.status = 'nothing-to-import';
  else report.status = 'completed';
  report.alreadyImported = report.status === 'completed' || report.status === 'nothing-to-import';
  report.finishedAt = nowIso();
  report.markerPath = writeMarkerSafely(options.dataRoot, report, source);
  return report;
}

function writeMarkerSafely(dataRoot: string, report: LegacyImportReport, source: LegacySource | null): string {
  const markerPath = path.join(dataRoot, LEGACY_IMPORT_MARKER);
  if (!source) return markerPath;
  try {
    return writeMarkerFor(dataRoot, report, source);
  } catch (error) {
    report.errors.push(`could not write import marker ${markerPath}: ${errorMessage(error)}`);
    return markerPath;
  }
}
