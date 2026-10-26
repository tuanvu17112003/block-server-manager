// Diagnostics — rotating launcher.log, JSONL lifecycle timeline, in-memory ring and support bundle
// (Phase 7 WP-7.4 / audit finding B-26).
//
// PURE NODE: this module never imports `electron`; the caller injects the data root and app versions
// (main.ts: `initDiagnostics({ dataRoot: ctx.dataRoot, versions: { app: app.getVersion(), ... } })`).
// It is unit-testable with `node --test` — see electron/test/unit/diagnostics.test.ts.
//
// Design guarantees:
//  * logging never throws into a caller (unwritable data root keeps the in-memory ring intact);
//  * launcher.log rotates by size (default 10 MiB) and by calendar day, keeping `maxFiles` total
//    files (`launcher.log` + `launcher-YYYYMMDD[-n].log`); appends are fsynced best-effort;
//  * every line is redacted before it reaches the ring, the file or a support bundle (cfc_* keys,
//    curseforge-key values, Authorization headers, generic bearer/API-key values);
//  * `-Dtestmultiai.server.id=<id>` (the JVM identity marker) is never touched by redaction;
//  * timeline events are append-only JSONL under `<dataRoot>/logs/timeline-YYYYMMDD.jsonl`, size-capped
//    and pruned;
//  * the support bundle is written with the existing classic-ZIP writer and contains only selected,
//    redacted diagnostics — never worlds/backups/mods/server jars.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeZip, type ZipInput } from './zip';

// ---------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------

export type DiagnosticLevel = 'info' | 'warn' | 'error';
export type TimelineKind = 'server' | 'install' | 'backup' | 'settings' | 'process' | 'app';

export interface DiagnosticEntry {
  /** ISO timestamp of the line. */
  at: string;
  level: DiagnosticLevel;
  /** Logger scope (e.g. `server:start`, `installer`, `backup`). */
  scope: string;
  message: string;
  /** Redacted structured detail (JSON-serialisable); absent when none was passed. */
  detail?: unknown;
}

export interface DiagnosticLogger {
  readonly logPath: string;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
  /** Child logger sharing the same file/ring with a `parent:child` scope. */
  child(scope: string): DiagnosticLogger;
  /** Best-effort flush (appends are already fsynced per line; kept for API completeness). */
  flush(): void;
  /** Last `limit` ring entries in chronological order (oldest first). */
  recent(limit?: number): DiagnosticEntry[];
}

export interface LoggerOptions {
  dataRoot: string;
  /** Total launcher*.log files kept including the active one. Default 5. */
  maxFiles?: number;
  /** Per-file size cap in bytes. Default 10 MiB. */
  maxBytes?: number;
  /** In-memory ring size. Default 1000. */
  ringSize?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Optional stderr/console mirror (dev). Default off. */
  mirror?: ((line: string) => void) | false;
}

export interface TimelineEvent {
  at: string;
  kind: TimelineKind;
  action: string;
  serverId?: string;
  detail?: unknown;
}

export type TimelineEventInput = Omit<TimelineEvent, 'at'> & { at?: string };

export interface TimelineReadOptions {
  /** Maximum events returned (newest first). Default 200, hard cap 5000. */
  limit?: number;
  /** ISO timestamp lower bound; older events are filtered out. */
  since?: string;
}

export interface Timeline {
  readonly timelineDir: string;
  record(event: TimelineEventInput): TimelineEvent;
  read(options?: TimelineReadOptions): TimelineEvent[];
}

export interface TimelineOptions {
  dataRoot: string;
  now?: () => Date;
  /** Per-file size cap before rotating to a numbered file. Default 4 MiB. */
  maxBytes?: number;
  /** Total timeline files kept including the active one. Default 5. */
  maxFiles?: number;
}

export interface Diagnostics extends Timeline {
  dataRoot: string;
  logger: DiagnosticLogger;
  recordTimeline(event: TimelineEventInput): TimelineEvent;
  readTimeline(options?: TimelineReadOptions): TimelineEvent[];
  close(): void;
}

export interface DiagnosticsOptions extends LoggerOptions, Omit<TimelineOptions, 'dataRoot' | 'now'> {
  now?: () => Date;
}

export interface VersionInfo {
  app?: string;
  electron?: string;
  node?: string;
  chrome?: string;
  platform?: string;
  arch?: string;
  os?: string;
}

export interface SupportBundleOptions {
  dataRoot: string;
  /** Default: `<dataRoot>/diagnostics/support-YYYYMMDD-HHmmss.zip`. */
  outPath?: string;
  /** Injected by main.ts (`app.getVersion()` + `process.versions`); defaults from `process.versions`. */
  versions?: VersionInfo;
  now?: () => Date;
  /** Launcher log lines included. Default 2000 (hard cap 20000). */
  maxLogLines?: number;
  /** Timeline events included. Default 200 (hard cap 2000). */
  maxTimeline?: number;
}

export interface SupportBundleResult {
  path: string;
  bytes: number;
  entries: string[];
  createdAt: string;
}

export interface ProcessHandlerOptions {
  /** Called after an uncaught exception is logged (e.g. app.exit(1) or dialog). */
  onFatal?: (error: unknown) => void;
  /** Re-throw uncaught exceptions asynchronously when no onFatal was given. Default true. */
  rethrowUncaught?: boolean;
  /** Treat unhandled rejections as fatal too. Default false (log only). */
  fatalUnhandledRejections?: boolean;
}

// ---------------------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------------------

export const REDACTED = '***REDACTED***';

/** Secret-ish object keys removed/redacted from structured bundle data. */
const SECRET_KEY = /(curseforge|api[-_]?key|authorization|bearer|token|secret|password|passwd|cookie)/i;

const REDACTION_RULES: { pattern: RegExp; replace: string }[] = [
  // CurseForge API keys as pasted in URLs/headers/settings.
  { pattern: /\bcfc_[A-Za-z0-9_-]{6,}/g, replace: REDACTED },
  // `curseforge-key=...` / `"curseforge-key": "..."` (manual key file / query string / settings JSON).
  { pattern: /(curseforge[-_ ]?key"?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,"'}&]+)/gi, replace: `$1${REDACTED}` },
  // Authorization headers: `Authorization: Bearer xyz`, `"authorization":"Bearer xyz"`, `Authorization: xyz`.
  {
    pattern: /(authorization"?\s*[=:]\s*)("[^"]*"|'[^']*'|(?:bearer\s+)?[^\s,"'}&]+)/gi,
    replace: `$1${REDACTED}`,
  },
  // Bare bearer tokens anywhere (e.g. logged request headers).
  { pattern: /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, replace: `$1${REDACTED}` },
  // Generic API-key headers (`x-api-key: ...`, `api_key=...`, `apikey: ...`).
  {
    pattern: /((?:x-api-key|api[-_]?key)"?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,"'}&]+)/gi,
    replace: `$1${REDACTED}`,
  },
];

/** Redact obvious secrets from a text line. `-Dtestmultiai...` markers are left untouched. */
export function redactText(text: string): string {
  let out = String(text ?? '');
  for (const rule of REDACTION_RULES) out = out.replace(rule.pattern, rule.replace);
  return out;
}

/** Deep-redact all string values (never mutates the input); circular refs/limits are handled. */
export function redactValue<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return redactText(value) as unknown as T;
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString() as unknown as T;
  if (typeof value === 'function' || typeof value === 'symbol') return '[unserializable]' as unknown as T;
  if (depth >= 8) return '[depth-limit]' as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1)) as unknown as T;
  if (value instanceof Error) {
    return redactValue(
      { name: value.name, message: value.message, stack: value.stack, code: (value as { code?: unknown }).code },
      depth + 1,
    ) as unknown as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(item, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------
// Small durable-write helpers (all no-throw unless noted)
// ---------------------------------------------------------------------------------------------------

const DEFAULT_MAX_FILES = 5;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_RING_SIZE = 1000;
const TIMELINE_MAX_BYTES = 4 * 1024 * 1024;
const MAX_DETAIL_CHARS = 4000;
const LOG_TAIL_READ_BYTES = 4096;

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** UTC calendar day key, e.g. `20261026` (log timestamps and rotated file names are UTC). */
function dayKey(at: Date): string {
  return `${at.getUTCFullYear()}${pad2(at.getUTCMonth() + 1)}${pad2(at.getUTCDate())}`;
}

function stamp(at: Date): string {
  return `${dayKey(at)}-${pad2(at.getUTCHours())}${pad2(at.getUTCMinutes())}${pad2(at.getUTCSeconds())}`;
}

function statSafe(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

/** Serialise arbitrary log detail to single-line JSON, redacted and truncated. */
function serialiseDetail(detail: unknown): string {
  if (detail === undefined) return '';
  let text: string;
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(detail, (_key, value: unknown) => {
      if (typeof value === 'bigint') return value.toString();
      if (typeof value === 'function' || typeof value === 'symbol') return '[unserializable]';
      if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack, code: (value as { code?: unknown }).code };
      }
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    });
    text = json ?? String(detail);
  } catch {
    text = String(detail);
  }
  const redacted = redactText(text).replace(/[\r\n]+/g, ' ');
  return redacted.length > MAX_DETAIL_CHARS ? `${redacted.slice(0, MAX_DETAIL_CHARS)}…(truncated)` : redacted;
}

function errorDetail(error: unknown): unknown {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack, code: (error as { code?: unknown }).code };
  }
  return { error: String(error) };
}

/** Last non-empty line's date key from a log file (cheap day-rotation probe). */
function lastLineDayKey(file: string): string | null {
  const stats = statSafe(file);
  if (!stats || stats.size === 0) return null;
  try {
    const length = Math.min(stats.size, LOG_TAIL_READ_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, stats.size - length);
    } finally {
      fs.closeSync(fd);
    }
    const text = buffer.toString('utf8');
    const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    const last = lines[lines.length - 1];
    if (!last) return null;
    const match = /^\[(\d{4}-\d{2}-\d{2})T/.exec(last);
    return match ? match[1]!.replace(/-/g, '') : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------------------------------

export function createLogger(options: LoggerOptions): DiagnosticLogger {
  const dataRoot = path.resolve(options.dataRoot);
  const logDir = path.join(dataRoot, 'logs');
  const logPath = path.join(logDir, 'launcher.log');
  const maxFiles = clampInt(options.maxFiles, DEFAULT_MAX_FILES, 1, 50);
  const maxBytes = clampInt(options.maxBytes, DEFAULT_MAX_BYTES, 256, 1024 * 1024 * 1024);
  const ringSize = clampInt(options.ringSize, DEFAULT_RING_SIZE, 10, 50_000);
  const now = options.now ?? (() => new Date());
  const mirror = options.mirror;
  const ring: DiagnosticEntry[] = [];

  const pushRing = (entry: DiagnosticEntry): void => {
    ring.push(entry);
    while (ring.length > ringSize) ring.shift();
  };

  const archivePathFor = (key: string): string => {
    let candidate = path.join(logDir, `launcher-${key}.log`);
    for (let index = 2; fs.existsSync(candidate); index += 1) {
      candidate = path.join(logDir, `launcher-${key}-${index}.log`);
    }
    return candidate;
  };

  const pruneArchives = (): void => {
    try {
      const archives = fs.readdirSync(logDir)
        .filter((name) => /^launcher.*\.log$/.test(name))
        .map((name) => path.join(logDir, name))
        .filter((file) => file !== logPath)
        .map((file) => ({ file, mtime: statSafe(file)?.mtimeMs ?? 0 }))
        .sort((left, right) => right.mtime - left.mtime);
      for (const extra of archives.slice(Math.max(0, maxFiles - 1))) {
        try { fs.rmSync(extra.file, { force: true }); } catch { /* best effort */ }
      }
    } catch {
      /* pruning is best effort */
    }
  };

  const rotateIfNeeded = (incomingBytes: number, at: Date): void => {
    const stats = statSafe(logPath);
    if (!stats || stats.size === 0) return;
    const previousDay = lastLineDayKey(logPath);
    const dayChanged = previousDay !== null && previousDay !== dayKey(at);
    const sizeExceeded = stats.size + incomingBytes > maxBytes;
    if (!dayChanged && !sizeExceeded) return;
    // Day rotation archives under the *previous* day (the content's day); size rotation under today.
    const archiveDay = dayChanged && previousDay !== null ? previousDay : dayKey(at);
    try {
      fs.renameSync(logPath, archivePathFor(archiveDay));
      pruneArchives();
    } catch {
      /* rotation is best effort: keep appending to the active file */
    }
  };

  const writeLine = (line: string, at: Date): void => {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      rotateIfNeeded(Buffer.byteLength(line, 'utf8') + 1, at);
      const fd = fs.openSync(logPath, 'a');
      try {
        fs.writeFileSync(fd, `${line}\n`, 'utf8');
        try { fs.fsyncSync(fd); } catch { /* fsync is best effort (some volumes reject it) */ }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* logging never throws into the caller (the in-memory ring already holds the entry) */
    }
  };

  const makeLogger = (currentScope: string): DiagnosticLogger => ({
    logPath,
    info(message, detail) { emit('info', currentScope, message, detail); },
    warn(message, detail) { emit('warn', currentScope, message, detail); },
    error(message, detail) { emit('error', currentScope, message, detail); },
    child(childScope) { return makeLogger(currentScope ? `${currentScope}:${String(childScope)}` : String(childScope)); },
    flush() { /* appends are fsynced per line; kept for API completeness */ },
    recent(limit) {
      const wanted = clampInt(limit, ring.length || 1, 1, 50_000);
      return ring.slice(Math.max(0, ring.length - wanted));
    },
  });

  function emit(level: DiagnosticLevel, currentScope: string, message: unknown, detail?: unknown): void {
    const at = now();
    const atIso = at.toISOString();
    const scopeLabel = currentScope || 'app';
    const safeMessage = redactText(String(message ?? ''));
    const line = `[${atIso}] ${level.toUpperCase().padEnd(5)} [${scopeLabel}] ${safeMessage}`;
    const detailText = serialiseDetail(detail);
    const fullLine = detailText ? `${line} ${detailText}` : line;
    pushRing({
      at: atIso,
      level,
      scope: scopeLabel,
      message: safeMessage,
      ...(detail === undefined ? {} : { detail: redactValue(detail) }),
    });
    writeLine(fullLine, at);
    if (mirror) {
      try { mirror(fullLine); } catch { /* a broken mirror must never break logging */ }
    }
  }

  return makeLogger('');
}

// ---------------------------------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------------------------------

const TIMELINE_KINDS: TimelineKind[] = ['server', 'install', 'backup', 'settings', 'process', 'app'];

function timelineFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
      .filter((name) => /^timeline-.*\.jsonl$/.test(name))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

export function createTimeline(options: TimelineOptions): Timeline {
  const dataRoot = path.resolve(options.dataRoot);
  const timelineDir = path.join(dataRoot, 'logs');
  const maxBytes = clampInt(options.maxBytes, TIMELINE_MAX_BYTES, 256, 64 * 1024 * 1024);
  const maxFiles = clampInt(options.maxFiles, DEFAULT_MAX_FILES, 1, 50);
  const now = options.now ?? (() => new Date());

  const activeFile = (at: Date): string => path.join(timelineDir, `timeline-${dayKey(at)}.jsonl`);

  const prune = (): void => {
    try {
      const files = timelineFiles(timelineDir)
        .map((file) => ({ file, mtime: statSafe(file)?.mtimeMs ?? 0 }))
        .sort((left, right) => right.mtime - left.mtime);
      for (const extra of files.slice(maxFiles)) {
        try { fs.rmSync(extra.file, { force: true }); } catch { /* best effort */ }
      }
    } catch {
      /* best effort */
    }
  };

  const rotateIfNeeded = (file: string, at: Date, incomingBytes: number): string => {
    const stats = statSafe(file);
    if (!stats || stats.size + incomingBytes <= maxBytes) return file;
    let archived = path.join(timelineDir, `timeline-${dayKey(at)}-${Date.now()}.jsonl`);
    for (let index = 2; fs.existsSync(archived); index += 1) {
      archived = path.join(timelineDir, `timeline-${dayKey(at)}-${index}-${Date.now()}.jsonl`);
    }
    try { fs.renameSync(file, archived); } catch { /* keep appending if the rename fails */ }
    prune();
    return file;
  };

  const record = (event: TimelineEventInput): TimelineEvent => {
    const at = event.at ? new Date(event.at) : now();
    const date = Number.isNaN(at.getTime()) ? now() : at;
    const kind = TIMELINE_KINDS.includes(event.kind) ? event.kind : 'app';
    const row: TimelineEvent = {
      at: date.toISOString(),
      kind,
      action: redactText(String(event.action ?? 'unknown')),
      ...(event.serverId ? { serverId: String(event.serverId) } : {}),
    };
    if (event.detail !== undefined) row.detail = redactValue(event.detail);
    try {
      const file = rotateIfNeeded(activeFile(date), date, Buffer.byteLength(JSON.stringify(row), 'utf8') + 1);
      fs.mkdirSync(timelineDir, { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
      prune();
    } catch {
      /* timeline persistence is best effort: never break the caller */
    }
    return row;
  };

  const read = (readOptions: TimelineReadOptions = {}): TimelineEvent[] => {
    const limit = clampInt(readOptions.limit, 200, 1, 5000);
    const sinceMs = readOptions.since ? Date.parse(readOptions.since) : Number.NaN;
    const rows: TimelineEvent[] = [];
    for (const file of timelineFiles(timelineDir).sort()) {
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
          const parsed = JSON.parse(trimmed) as Partial<TimelineEvent>;
          if (typeof parsed.at !== 'string' || typeof parsed.action !== 'string') continue;
          if (Number.isNaN(Date.parse(parsed.at))) continue;
          if (!Number.isNaN(sinceMs) && Date.parse(parsed.at) < sinceMs) continue;
          rows.push({
            at: parsed.at,
            kind: TIMELINE_KINDS.includes(parsed.kind as TimelineKind) ? (parsed.kind as TimelineKind) : 'app',
            action: String(parsed.action),
            ...(parsed.serverId ? { serverId: String(parsed.serverId) } : {}),
            ...(parsed.detail === undefined ? {} : { detail: parsed.detail }),
          });
        } catch {
          /* skip malformed line */
        }
      }
    }
    rows.sort((left, right) => right.at.localeCompare(left.at));
    return rows.slice(0, limit);
  };

  return { timelineDir, record, read };
}

// ---------------------------------------------------------------------------------------------------
// Module-level diagnostics singleton (initialised once by main.ts)
// ---------------------------------------------------------------------------------------------------

let activeDiagnostics: Diagnostics | null = null;

export function createDiagnostics(options: DiagnosticsOptions): Diagnostics {
  const logger = createLogger(options);
  const timeline = createTimeline(options);
  const diagnostics: Diagnostics = {
    dataRoot: path.resolve(options.dataRoot),
    logger,
    recordTimeline: (event) => timeline.record(event),
    readTimeline: (readOptions) => timeline.read(readOptions),
    timelineDir: timeline.timelineDir,
    record: (event) => timeline.record(event),
    read: (readOptions) => timeline.read(readOptions),
    close: () => logger.flush(),
  };
  return diagnostics;
}

/** Initialise the process-wide diagnostics logger + timeline (call once, after `dataRoot()`). */
export function initDiagnostics(options: DiagnosticsOptions): Diagnostics {
  activeDiagnostics = createDiagnostics(options);
  return activeDiagnostics;
}

export function getDiagnostics(): Diagnostics | null {
  return activeDiagnostics;
}

export function closeDiagnostics(): void {
  activeDiagnostics?.close();
  activeDiagnostics = null;
}

/** Record a timeline event on the active diagnostics instance (no-op before init, never throws). */
export function recordTimeline(event: TimelineEventInput): TimelineEvent | null {
  return activeDiagnostics ? activeDiagnostics.recordTimeline(event) : null;
}

/** Read timeline events from the active diagnostics instance (empty before init). */
export function readTimeline(options?: TimelineReadOptions): TimelineEvent[] {
  return activeDiagnostics ? activeDiagnostics.readTimeline(options) : [];
}

/** In-memory recent diagnostics from the active logger (empty before init). */
export function recentDiagnostics(limit?: number): DiagnosticEntry[] {
  return activeDiagnostics ? activeDiagnostics.logger.recent(limit) : [];
}

// ---------------------------------------------------------------------------------------------------
// Process-level crash handlers
// ---------------------------------------------------------------------------------------------------

/**
 * Log `uncaughtException` / `unhandledRejection` to the diagnostics ring+file.
 * Safe semantics: uncaught exceptions still terminate the process (re-thrown on the next tick) unless
 * `onFatal` is supplied; unhandled rejections are logged only unless `fatalUnhandledRejections`.
 * Returns a disposer (tests use an injected EventEmitter target).
 */
export function installProcessHandlers(
  logger: DiagnosticLogger,
  options: ProcessHandlerOptions = {},
  target: NodeJS.EventEmitter = process,
): () => void {
  const rethrowUncaught = options.rethrowUncaught ?? options.onFatal === undefined;
  const onFatal = options.onFatal;
  const fatalRejections = options.fatalUnhandledRejections ?? false;
  const logFatal = (label: string, error: unknown): void => {
    try {
      logger.error(label, errorDetail(error));
      logger.flush();
    } catch {
      /* logging must never mask the original failure */
    }
  };
  const onUncaught = (error: unknown): void => {
    logFatal('uncaughtException', error);
    try { onFatal?.(error); } catch { /* keeper of the original error */ }
    if (rethrowUncaught) {
      setImmediate(() => { throw error; });
    }
  };
  const onRejection = (reason: unknown): void => {
    logFatal('unhandledRejection', reason);
    if (fatalRejections) {
      setImmediate(() => { throw reason; });
    }
  };
  target.on('uncaughtException', onUncaught);
  target.on('unhandledRejection', onRejection);
  return () => {
    target.removeListener('uncaughtException', onUncaught);
    target.removeListener('unhandledRejection', onRejection);
  };
}

// ---------------------------------------------------------------------------------------------------
// Support bundle
// ---------------------------------------------------------------------------------------------------

const BUNDLE_VERSION = 1;

function defaultVersions(): VersionInfo {
  const versions = process.versions as Record<string, string | undefined>;
  return {
    app: 'unknown',
    electron: versions.electron ?? 'not-running-in-electron',
    node: versions.node ?? process.version,
    chrome: versions.chrome ?? 'n/a',
    platform: process.platform,
    arch: process.arch,
    os: `${os.type()} ${os.release()}`,
  };
}

function tailLinesOf(file: string, maxLines: number): string[] {
  const stats = statSafe(file);
  if (!stats || !stats.isFile() || stats.size === 0 || maxLines <= 0) return [];
  try {
    const readBytes = Math.min(stats.size, 8 * 1024 * 1024);
    const buffer = Buffer.alloc(readBytes);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buffer, 0, readBytes, stats.size - readBytes);
    } finally {
      fs.closeSync(fd);
    }
    let lines = buffer.toString('utf8').split('\n');
    if (stats.size > readBytes) lines = lines.slice(1); // started mid-line
    lines = lines.filter((line) => line.trim() !== '');
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

/** Launcher log files ordered newest-first (`launcher.log` active first, then rotated archives). */
function launcherLogFiles(dataRoot: string): string[] {
  const logDir = path.join(dataRoot, 'logs');
  let names: string[];
  try {
    names = fs.readdirSync(logDir).filter((name) => /^launcher.*\.log$/.test(name));
  } catch {
    return [];
  }
  const active = path.join(logDir, 'launcher.log');
  const archives = names
    .map((name) => path.join(logDir, name))
    .filter((file) => file !== active)
    .map((file) => ({ file, mtime: statSafe(file)?.mtimeMs ?? 0 }))
    .sort((left, right) => right.mtime - left.mtime)
    .map(({ file }) => file);
  return names.includes('launcher.log') ? [active, ...archives] : archives;
}

/** Collect up to `maxLines` launcher log lines (oldest→newest), spanning rotated files. */
function collectLauncherTail(dataRoot: string, maxLines: number): string[] {
  const files = launcherLogFiles(dataRoot);
  let out: string[] = [];
  for (const file of files) {
    const remaining = maxLines - out.length;
    if (remaining <= 0) break;
    const lines = tailLinesOf(file, remaining);
    out = [...lines, ...out];
  }
  return out.slice(-maxLines);
}

function readAppData(dataRoot: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataRoot, 'app-data.json'), 'utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

interface ServerSummary {
  id: string;
  name: string;
  loader: string;
  mcVersion: string;
  loaderVersion: string | null;
  port: number;
  ramMb: number;
  status: string;
  createdAt: string;
  javaPathRedacted: boolean;
}

function serverSummaries(appData: Record<string, unknown> | null): ServerSummary[] {
  if (!appData) return [];
  const servers = Array.isArray(appData.servers) ? appData.servers : [];
  const out: ServerSummary[] = [];
  for (const row of servers) {
    if (!row || typeof row !== 'object') continue;
    const server = row as Record<string, unknown>;
    out.push({
      id: String(server.id ?? ''),
      name: String(server.name ?? ''),
      loader: String(server.loader ?? ''),
      mcVersion: String(server.mcVersion ?? ''),
      loaderVersion: server.loaderVersion === undefined || server.loaderVersion === null ? null : String(server.loaderVersion),
      port: Number(server.port ?? 0),
      ramMb: Number(server.ramMb ?? 0),
      status: String(server.status ?? ''),
      createdAt: String(server.createdAt ?? ''),
      javaPathRedacted: Boolean(server.javaPath),
    });
  }
  return out;
}

/** Redacted copy of `app-data.json`: no key material, no absolute Java paths, no backup paths. */
function redactedAppData(appData: Record<string, unknown> | null, dataRoot: string): Record<string, unknown> {
  if (!appData) {
    return { error: 'app-data.json is missing or unreadable', dataRootName: path.basename(dataRoot) };
  }
  const clone = JSON.parse(JSON.stringify(appData)) as Record<string, unknown>;
  if (Array.isArray(clone.servers)) {
    clone.servers = clone.servers.map((row) => {
      if (!row || typeof row !== 'object') return row;
      const server = row as Record<string, unknown>;
      const redacted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(server)) {
        if (key === 'javaPath') { redacted.javaPath = value ? REDACTED : value; continue; }
        redacted[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(value);
      }
      return redacted;
    });
  }
  if (Array.isArray(clone.backups)) {
    clone.backups = clone.backups.map((row) => {
      if (!row || typeof row !== 'object') return row;
      const backup = row as Record<string, unknown>;
      return { ...redactValue(backup), path: backup.path ? REDACTED : backup.path };
    });
  }
  const settings = clone.settings;
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    const redactedSettings: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(settings as Record<string, unknown>)) {
      redactedSettings[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(value);
    }
    clone.settings = redactedSettings;
  }
  return clone;
}

/**
 * Build a support ZIP with versions/platform, server summaries, recent launcher log + timeline and a
 * redacted `app-data.json`. Never includes worlds/backups/mods/jars or the CurseForge key file.
 */
export async function createSupportBundle(options: SupportBundleOptions): Promise<SupportBundleResult> {
  const dataRoot = path.resolve(options.dataRoot);
  const now = options.now ?? (() => new Date());
  const at = now();
  const createdAt = at.toISOString();
  const versions = { ...defaultVersions(), ...(options.versions ?? {}) };
  const maxLogLines = clampInt(options.maxLogLines, 2000, 10, 20_000);
  const maxTimeline = clampInt(options.maxTimeline, 200, 1, 2000);
  const outPath = path.resolve(options.outPath ?? path.join(dataRoot, 'diagnostics', `support-${stamp(at)}.zip`));

  const appData = readAppData(dataRoot);
  const serverList = serverSummaries(appData);
  const launcherTail = collectLauncherTail(dataRoot, maxLogLines).map((line) => redactText(line));
  const timeline = createTimeline({ dataRoot, now }).read({ limit: maxTimeline }).reverse();
  const timelineLines = timeline.map((row) => JSON.stringify({ ...row, action: redactText(row.action) }));
  const logFiles = launcherLogFiles(dataRoot).map((file) => ({
    name: path.basename(file),
    bytes: statSafe(file)?.size ?? 0,
  }));
  const curseforgeKeyFile = fs.existsSync(path.join(dataRoot, 'curseforge-key.txt'));

  const manifest = {
    bundleVersion: BUNDLE_VERSION,
    createdAt,
    app: versions.app ?? 'unknown',
    platform: versions.platform ?? process.platform,
    arch: versions.arch ?? process.arch,
    dataRootName: path.basename(dataRoot),
    counts: {
      servers: serverList.length,
      launcherLogFiles: logFiles.length,
      launcherLogLines: launcherTail.length,
      timelineEvents: timelineLines.length,
    },
    launcherLogFiles: logFiles,
    hasCurseforgeKeyFile: curseforgeKeyFile,
    exclusions: ['worlds', 'backups', 'mods', 'server jars', 'curseforge-key.txt'],
    redaction: [
      'cfc_* API keys', 'curseforge-key values', 'Authorization/Bearer headers', 'api-key values',
      'server.javaPath', 'backup archive paths', 'secret-named settings keys',
      '(-Dtestmultiai.server.id markers are preserved)',
    ],
  };

  const files: { name: string; content: string | Buffer }[] = [
    { name: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
    { name: 'versions.json', content: `${JSON.stringify({ ...versions, capturedAt: createdAt }, null, 2)}\n` },
    { name: 'servers.json', content: `${JSON.stringify(serverList, null, 2)}\n` },
    { name: 'app-data.redacted.json', content: `${JSON.stringify(redactedAppData(appData, dataRoot), null, 2)}\n` },
    { name: 'logs/launcher.log.tail.txt', content: launcherTail.length > 0 ? `${launcherTail.join('\n')}\n` : '(no launcher.log lines yet)\n' },
    { name: 'logs/timeline.recent.jsonl', content: timelineLines.length > 0 ? `${timelineLines.join('\n')}\n` : '' },
    {
      name: 'notes.txt',
      content: [
        'Block Server Manager support bundle (diagnostics).',
        '',
        'Included: manifest/versions, server registry summary, redacted app-data.json,',
        'recent launcher.log lines and timeline events.',
        '',
        'Excluded on purpose: worlds, backups, mods, server jars, the CurseForge API key file,',
        'and any obvious secret (cfc_* keys, curseforge-key=..., Authorization headers).',
        'Absolute Java/backup paths are redacted. The Minecraft process identity marker',
        '(-Dtestmultiai.server.id=<uuid>) is preserved to help diagnose orphan processes.',
        '',
      ].join('\n'),
    },
  ];

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-support-'));
  try {
    const inputs: ZipInput[] = [];
    for (const file of files) {
      const target = path.join(staging, file.name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content);
      inputs.push({ name: file.name, path: target });
    }
    const bytes = await writeZip(outPath, inputs);
    return { path: outPath, bytes, entries: inputs.map((input) => input.name), createdAt };
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
