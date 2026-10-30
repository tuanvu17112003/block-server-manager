// Atomic staged install publication (Phase 2, WP-2.4).
//
// Invariant: a server becomes visible (store record + `servers/<id>` directory) only after the
// staged install has been fully written AND validated (loader artifact + launch shape). Any
// failure or cancellation removes the staging directory and leaves no record and no final dir
// (complete-or-nothing, B-09/INST-004/M-7). The record insert and the atomic rename happen in one
// synchronous block after async validation, so no other IPC handler can observe a record without
// its directory or a directory without its record.
//
// Staging lives under `<dataRoot>/installer-staging/<uuid>` which is on the same volume as
// `<dataRoot>/servers`, so publication is a single `renameSync`; a cross-device (EXDEV) fallback
// copies to a private temp name and only then renames it into place.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appError, Store, type CreateServerInput, type ServerDto } from './store';
import { launchCommand, startAndVerify, type LaunchCommand, type LoaderKind } from './installer/core';
import { writeEulaFile, writePropertyValues } from './properties';

export const STAGING_DIR = 'installer-staging';
export const INSTALLER_LOG_FILE = 'installer.log';

const LOADER_KIND_BY_NAME: Record<string, LoaderKind> = {
  vanilla: 'vanilla',
  paper: 'paper',
  fabric: 'fabric',
  quilt: 'quilt',
  forge: 'forge',
  neoforge: 'neoforge',
};

/** Files that prove the requested loader was actually installed; any one pattern must match. */
const LOADER_ARTIFACTS: Record<LoaderKind, RegExp[]> = {
  vanilla: [/^server\.jar$/i],
  paper: [/^server\.jar$/i],
  fabric: [/^fabric-server-launch\.jar$/i],
  quilt: [/^quilt-server-launch\.jar$/i],
  forge: [/^run\.bat$/i, /^run\.sh$/i, /^forge-.*\.jar$/i],
  neoforge: [/^run\.bat$/i, /^run\.sh$/i, /^(?:forge|neoforge)-.*\.jar$/i],
};

/** Map a display loader name (`Vanilla`, `NeoForge`, …) or engine kind to a `LoaderKind`. */
export function loaderKindOf(loader: string | null | undefined): LoaderKind | null {
  if (!loader) return null;
  return LOADER_KIND_BY_NAME[loader.trim().toLowerCase()] ?? null;
}

export function stagingRoot(dataRoot: string): string {
  return path.join(dataRoot, STAGING_DIR);
}

/**
 * Fail fast (before a multi-GB download) when the name is taken; `Store.createServer` re-checks at
 * publish time so a concurrent create can never slip through.
 */
export function assertServerNameAvailable(store: Store, name: string): void {
  if (store.listServers().some((row) => row.name === name)) {
    throw appError('conflict', `A server named "${name}" already exists.`);
  }
}

export interface StagedServerContext {
  /** UUID reserved for this install; also the provisional `serverId` for failed report DTOs. */
  stagingId: string;
  stagingDir: string;
  dataRoot: string;
  /** Append a line to `<staging>/installer.log` (published with the server on success). */
  log: (line: string) => void;
}

export interface ValidateStagedOptions {
  stagingDir: string;
  /** When provided, require a loader-specific artifact in addition to a usable launch shape. */
  loaderKind?: LoaderKind | null;
  log?: (line: string) => void;
}

/**
 * Pure-ish validator: the staged tree must exist, be non-empty, contain an artifact for the
 * requested loader (when known) and resolve to a launch command via `launchCommand`.
 * Returns the resolved launch shape; throws a `install-invalid` app error otherwise.
 */
export function validateStagedInstall(opts: ValidateStagedOptions): LaunchCommand {
  const { stagingDir, loaderKind = null, log } = opts;
  if (!fs.existsSync(stagingDir) || !fs.statSync(stagingDir).isDirectory()) {
    throw appError('install-invalid', `staged install directory is missing: ${stagingDir}`);
  }
  const entries = fs.readdirSync(stagingDir);
  if (entries.length === 0) {
    throw appError('install-invalid', 'staged install is empty');
  }
  if (loaderKind) {
    const patterns = LOADER_ARTIFACTS[loaderKind];
    const artifact = entries.find((name) => patterns.some((pattern) => pattern.test(name)));
    if (!artifact) {
      throw appError('install-invalid', `staged install has no ${loaderKind} artifact (expected ${patterns.map((pattern) => pattern.source).join(' | ')})`);
    }
    if (/\.jar$/i.test(artifact) && fs.statSync(path.join(stagingDir, artifact)).size === 0) {
      throw appError('install-invalid', `staged ${loaderKind} artifact is empty: ${artifact}`);
    }
    log?.(`artifact: ${artifact}`);
  }
  let launch: LaunchCommand;
  try {
    launch = launchCommand(stagingDir, 'java');
  } catch (error) {
    throw appError('install-invalid', `no usable launch shape in staged install: ${(error as Error).message}`);
  }
  // The launch target itself must be a non-empty file (launchCommand only checks existence).
  const jarIndex = launch.args.indexOf('-jar');
  if (jarIndex >= 0 && launch.args[jarIndex + 1]) {
    const jar = path.resolve(stagingDir, launch.args[jarIndex + 1]);
    if (!fs.existsSync(jar) || fs.statSync(jar).size === 0) {
      throw appError('install-invalid', `launch jar is missing or empty: ${launch.args[jarIndex + 1]}`);
    }
  }
  log?.(`launch: ${path.basename(launch.exe)} ${launch.args.slice(0, 6).join(' ')}`);
  return launch;
}

export interface BootCheckResult {
  ok: boolean;
  reason: string;
  tail: string[];
}

export interface VerifyStagedBootOptions {
  stagingDir: string;
  /** Resolved Java executable used for the one verification boot. */
  javaPath: string;
  /** Launch shape from `validateStagedInstall` (defaults to resolving it again). */
  launch?: LaunchCommand;
  timeoutMs?: number;
  log?: (line: string) => void;
}

/**
 * WP-4.3 (M-10): installs only succeed after the staged server has actually reached `Done (` once.
 * The verification boot is allowed to write the initial world, then the process is stopped; the
 * staged tree (now including world/logs) is what gets published.
 */
export async function verifyStagedBoot(opts: VerifyStagedBootOptions): Promise<void> {
  const { stagingDir, javaPath, timeoutMs = 5 * 60_000, log } = opts;
  const launch = opts.launch ?? validateStagedInstall({ stagingDir, loaderKind: null, log });
  log?.(`boot verification: ${path.basename(launch.exe)} ${launch.args.slice(0, 6).join(' ')}`);
  const result = await startAndVerify(stagingDir, javaPath ? { exe: javaPath, args: launch.args } : launch, { timeoutMs });
  if (!result.ok) {
    const tail = result.tail.slice(-20).join('\n');
    log?.(`boot verification failed: ${result.reason}`);
    throw appError('install-unverified', `The server did not reach "Done (" during install verification: ${result.reason}${tail ? `\n${tail}` : ''}`);
  }
  log?.(`boot verification passed: ${result.reason}`);
}

export interface PublishStagedServerOptions {
  dataRoot: string;
  store: Store;
  /** Record fields; `port`/`javaPath`/`eulaAccepted` should already be resolved by the caller. */
  input: CreateServerInput;
  /** Loader for the default artifact validation. Omit to derive from `input.loader`; pass `null` for
   *  launch-shape-only validation (pack routes where the loader is detected from the archive). */
  loaderKind?: LoaderKind | null;
  /** Install into `ctx.stagingDir`. Engines that create their own dir (modrinth/curseforge) work. */
  install: (ctx: StagedServerContext) => Promise<void> | void;
  /** Extra/override validation; defaults to `validateStagedInstall`. May return the launch shape. */
  verify?: (ctx: StagedServerContext) => Promise<LaunchCommand | void> | LaunchCommand | void;
  /** WP-4.3: verify one `Done (` boot before publishing (default off; runtime/pipeline enable it). */
  bootVerify?: { enabled: boolean; javaPath?: string | null; timeoutMs?: number };
  /** Manager-owned config enforced after extraction, before validation/boot (archive cannot override). */
  enforceManagerConfig?: { port: number; eulaAccepted: boolean };
  /** Test seam: override the boot check. */
  bootCheck?: (stagingDir: string, launch: LaunchCommand, javaPath: string | null) => Promise<BootCheckResult>;
  /** Reserved staging path, before any installer work (pipeline uses it for the report serverId). */
  onStaging?: (ctx: { stagingId: string; stagingDir: string }) => void;
  /** After validation + record creation, before the atomic publish (sync on purpose: no IPC gap). */
  beforePublish?: (server: ServerDto, ctx: StagedServerContext) => void;
  /** Override the directory publisher (tests inject a failing one; default rename + EXDEV fallback). */
  publish?: (fromDir: string, toDir: string) => void;
  onProgress?: (event: { stage: string; progress: number }) => void;
  isCancelled?: () => boolean;
  /** Cooperative cancellation signal shared with installer engines (WP-4.1). */
  signal?: AbortSignal;
}

export interface PublishStagedServerResult {
  server: ServerDto;
  stagingId: string;
  installDurationMs: number;
  publishDurationMs: number;
  launch: LaunchCommand | null;
}

const RETRYABLE_PUBLISH_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EEXIST']);

function isRetryablePublishError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code !== undefined && RETRYABLE_PUBLISH_CODES.has(code);
}

/** Synchronous sleep: the publish runs inside a sync section on purpose (no IPC gap). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Windows can briefly deny renaming a freshly built tree: Defender/indexers scan the new files, and
 * a still-exiting verification JVM may hold the staging directory as its cwd. Retry with backoff
 * before falling back to a copy, instead of failing an otherwise successful install with EPERM.
 */
function renameSyncWithRetry(from: string, to: string, attempts = 10, baseDelayMs = 120): void {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryablePublishError(error) || attempt === attempts - 1) throw error;
      sleepSync(baseDelayMs + attempt * baseDelayMs);
    }
  }
  throw lastError;
}

function copySyncWithRetry(from: string, to: string, attempts = 5): void {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      // `force: true` matters for the retry path: a previous attempt may have created part of the tree before failing,
      // and `force: false` would then refuse to overwrite it on the next attempt, turning a transient lock into a
      // permanent failure. `recursive` keeps the copy complete.
      //
      // When `to` already exists as a directory (the file-by-file rung creates it first), cpSync copies `from` INTO it
      // rather than onto it, which would produce `to/<basename>/...`. Descending into the source and copying children
      // keeps the destination shape correct regardless of whether it pre-existed.
      if (fs.existsSync(to) && fs.statSync(to).isDirectory()) {
        for (const entry of fs.readdirSync(from)) {
          fs.cpSync(path.join(from, entry), path.join(to, entry), { recursive: true, force: true, errorOnExist: false });
        }
      } else {
        fs.cpSync(from, to, { recursive: true, force: true, errorOnExist: false });
      }
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryablePublishError(error) || attempt === attempts - 1) throw error;
      sleepSync(250 + attempt * 250);
    }
  }
  throw lastError;
}

/**
 * Move the staged tree into its final location.
 *
 * Three rungs, each tolerating something the previous one cannot. The ladder exists because of a measured failure, not
 * as defensive padding: an install reached 95% "publishing" and failed with EPERM while four `.publishing-*` folders
 * (112 MB each) were left behind. Reading the disk state showed exactly which step broke:
 *
 *   rename(staging → servers/<id>)        failed — a JVM still had the staging dir as its cwd
 *   copy(staging → <id>.publishing-<uuid>) succeeded — 66 files copied
 *   rename(<id>.publishing-<uuid> → final) failed — Defender held handles on the freshly written jars
 *
 * The last step is the one that matters here. Renaming a DIRECTORY requires exclusive access to everything inside it,
 * so a real-time antivirus scanner reading those jars blocks it — but the scanner releases them within seconds, and a
 * 6.6-second retry budget was simply too short for 112 MB. A manual rename of the leftover folder succeeded later,
 * which confirmed the lock is transient rather than a permission problem.
 *
 * So:
 *   1. rename, quick retries — the happy path, atomic and instant.
 *   2. copy to a temp sibling, retrying — succeeds where rename cannot, because copying reads the source without
 *      needing exclusive access to the directory.
 *   3. rename temp → final with a MUCH longer budget — waiting out the scanner is the minimal fix, and it keeps the
 *      publish atomic.
 *   4. if even that fails, copy temp → final file by file. Copying does not need to rename a directory, so a scanner
 *      holding an individual file no longer blocks the whole operation; the cost is that this rung is not atomic, which
 *      is why it is last and why the caller rolls the record back on failure.
 */

/** Marker for folders left behind by an interrupted publish: `<serverId>.publishing-<uuid>`. */
const PUBLISHING_SUFFIX = '.publishing-';

/**
 * Finish or discard publishes that were interrupted.
 *
 * A failed publish can leave `<serverId>.publishing-<uuid>` directories next to the real server folders. Measured on a
 * real machine after three failed installs: four of them, 106-112 MB each — roughly 430 MB of orphaned server copies
 * that no UI showed and nothing ever cleaned up.
 *
 * Two cases, and the difference matters:
 *
 *  - The final folder does NOT exist: the copy completed but was never renamed into place. The leftover is a complete,
 *    verified copy, so it is renamed into position — recovering an install the user already waited minutes for.
 *  - The final folder DOES exist: the server is published and the leftover is stale. It is removed.
 *
 * Never throws: this runs at startup and must not be able to prevent the app from opening.
 */
export function recoverInterruptedPublishes(
  dataRoot: string,
): { recovered: string[]; removed: string[]; skipped: string[] } {
  const serversDir = path.join(dataRoot, 'servers');
  const result = { recovered: [] as string[], removed: [] as string[], skipped: [] as string[] };

  let entries: string[];
  try { entries = fs.readdirSync(serversDir); } catch { return result; }

  for (const entry of entries) {
    const marker = entry.indexOf(PUBLISHING_SUFFIX);
    if (marker <= 0) continue;
    const serverId = entry.slice(0, marker);
    const leftover = path.join(serversDir, entry);
    const finalDir = path.join(serversDir, serverId);

    try {
      if (fs.existsSync(finalDir)) {
        fs.rmSync(leftover, { recursive: true, force: true });
        result.removed.push(entry);
        continue;
      }
      // Not published yet: the copy precedes the rename, so this leftover is a complete tree. Finish the job.
      renameSyncWithRetry(leftover, finalDir, 20, 300);
      result.recovered.push(entry);
    } catch {
      // Still locked. Leave it for the next startup rather than deleting a possibly complete server copy.
      result.skipped.push(entry);
    }
  }
  return result;
}

export function publishStagedDirectory(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    renameSyncWithRetry(from, to);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== 'EXDEV' && !isRetryablePublishError(error)) throw error;
    // eslint-disable-next-line no-console
    console.warn(`[install] direct publish failed (${code ?? 'unknown'}); retrying with a copy fallback.`);
  }

  const temp = `${to}.publishing-${randomUUID()}`;
  try {
    copySyncWithRetry(from, temp);

    // Generous budget: a scanner reading the copied jars is the expected blocker, and it is transient. 40 attempts with
    // a 400ms base reach ~4 minutes, which is far longer than any plausible scan of a single modpack and cheap when the
    // first attempt succeeds (the common case).
    renameSyncWithRetry(temp, to, 40, 400);
    try { fs.rmSync(from, { recursive: true, force: true }); } catch { /* best effort, see below */ }
    return;
  } catch (renameError) {
    // Last rung: copy the temp tree into place file by file. A directory rename needs exclusive access to the whole
    // tree; a file copy does not, so this succeeds when a scanner is holding individual jars.
    // eslint-disable-next-line no-console
    console.warn(`[install] renaming into place failed (${(renameError as NodeJS.ErrnoException).code ?? 'unknown'}); copying file-by-file.`);
    try {
      fs.mkdirSync(to, { recursive: true });
      copySyncWithRetry(temp, to, 10);
      try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(from, { recursive: true, force: true }); } catch { /* best effort */ }
      return;
    } catch (copyError) {
      // Everything failed. Report the ORIGINAL cause; it names the step that actually blocked publishing.
      const code = (copyError as NodeJS.ErrnoException | null)?.code ?? (renameError as NodeJS.ErrnoException | null)?.code ?? 'unknown';
      const detail = (copyError as Error).message;
      const leftovers = fs.existsSync(temp) ? ` Partial output was left at ${temp}.` : '';
      throw appError(
        'io',
        `Could not publish the installed server (${code}). A process kept the files locked through several retries. `
        + 'This is almost always antivirus real-time scanning of the freshly written jars. Wait a few seconds and press '
        + 'Retry — the staging files are kept precisely so a retry can finish the job. To stop it recurring, add the app '
        + `data folder to your antivirus exclusions.${leftovers} Underlying error: ${detail}`,
      );
    }
  }
}

/**
 * Stage → install → validate → record → publish. See the file header for the invariant.
 * Errors are re-thrown unchanged (callers keep their `{code,message}` envelope; `cancelled` when
 * `isCancelled()` trips) after the staging tree and any partially published record are removed.
 */
export async function publishStagedServer(opts: PublishStagedServerOptions): Promise<PublishStagedServerResult> {
  const { dataRoot, store } = opts;
  const stagingId = randomUUID();
  const stagingDir = path.join(stagingRoot(dataRoot), stagingId);
  const logLines: string[] = [];
  const startedAt = Date.now();
  let record: ServerDto | null = null;

  const log = (line: string): void => { logLines.push(`[${new Date().toISOString()}] ${line}`); };
  const ctx: StagedServerContext = { stagingId, stagingDir, dataRoot, log };
  const flushLog = (): void => {
    try {
      if (!fs.existsSync(stagingDir) || !fs.statSync(stagingDir).isDirectory()) return;
      fs.writeFileSync(path.join(stagingDir, INSTALLER_LOG_FILE), `${logLines.join('\n')}\n`);
    } catch { /* log capture is best-effort */ }
  };
  const cleanupStaging = (): void => {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  const rollbackRecord = (): void => {
    if (!record) return;
    const id = record.id;
    record = null;
    try { store.deleteServer(id); } catch { /* best effort */ }
    try { fs.rmSync(path.join(dataRoot, 'servers', id), { recursive: true, force: true }); } catch { /* best effort */ }
  };
  const throwIfCancelled = (): void => {
    if (opts.isCancelled?.()) {
      log('cancelled before publish');
      throw appError('cancelled', 'Install cancelled.');
    }
  };

  try {
    fs.mkdirSync(stagingRoot(dataRoot), { recursive: true });
    opts.onStaging?.({ stagingId, stagingDir });
    log(`staged install ${stagingId}: loader=${opts.input.loader} mc=${opts.input.mcVersion}`);
    throwIfCancelled();

    // Installers create the staging dir themselves (modrinth/curseforge reject an existing dir).
    await opts.install(ctx);
    if (opts.enforceManagerConfig) {
      // INST-005: an archive must never overwrite manager-owned state. The reviewed port wins and
      // EULA consent is only what the user explicitly accepted (no silent archive acceptance).
      writePropertyValues(stagingDir, { 'server-port': String(opts.enforceManagerConfig.port) });
      writeEulaFile(stagingDir, opts.enforceManagerConfig.eulaAccepted);
      log(`manager config enforced: server-port=${opts.enforceManagerConfig.port} eula=${opts.enforceManagerConfig.eulaAccepted}`);
    }
    const installDurationMs = Date.now() - startedAt;
    throwIfCancelled();

    const loaderKind = opts.loaderKind === undefined ? loaderKindOf(opts.input.loader) : opts.loaderKind;
    const validate = async (): Promise<LaunchCommand | null> => {
      if (opts.verify) {
        const returned = await opts.verify(ctx);
        return returned && typeof returned === 'object' && 'args' in returned ? returned : null;
      }
      return validateStagedInstall({ stagingDir, loaderKind, log });
    };
    opts.onProgress?.({ stage: 'validating install', progress: 85 });
    log('validating staged install');
    const launch = await validate();
    throwIfCancelled();
    flushLog();

    // WP-4.3 / M-10: optional one-boot verification before the record exists (rollback is a plain
    // staging cleanup). Runtime server_install and the modpack pipeline enable this.
    if (opts.bootVerify?.enabled) {
      const javaPath = opts.bootVerify.javaPath ?? opts.input.javaPath ?? null;
      if (!javaPath) throw appError('validation', 'Boot verification requires a resolved Java runtime.');
      const bootLaunch = launch ?? validateStagedInstall({ stagingDir, loaderKind, log });
      opts.onProgress?.({ stage: 'boot verification', progress: 90 });
      const bootCheck = opts.bootCheck ?? (async (dir, cmd, java) => {
        const result = await startAndVerify(dir, java ? { exe: java, args: cmd.args } : cmd, {
          timeoutMs: opts.bootVerify?.timeoutMs ?? 5 * 60_000,
        });
        return { ok: result.ok, reason: result.reason, tail: result.tail };
      });
      const bootResult = await bootCheck(stagingDir, bootLaunch, javaPath);
      if (!bootResult.ok) {
        log(`boot verification failed: ${bootResult.reason}`);
        flushLog();
        throw appError(
          'install-unverified',
          `The server did not reach "Done (" during install verification: ${bootResult.reason}` +
          (bootResult.tail.length > 0 ? `\n${bootResult.tail.slice(-15).join('\n')}` : ''),
        );
      }
      log(`boot verification passed: ${bootResult.reason}`);
      flushLog();
      throwIfCancelled();
    }

    opts.onProgress?.({ stage: 'publishing', progress: 95 });
    const publishStartedAt = Date.now();
    // Record insert → beforePublish → rename are synchronous: no IPC can interleave between them.
    record = store.createServer(opts.input);
    try {
      opts.beforePublish?.(record, ctx);
      flushLog();
      (opts.publish ?? publishStagedDirectory)(stagingDir, path.join(dataRoot, 'servers', record.id));
    } catch (error) {
      rollbackRecord();
      throw error;
    }
    const publishDurationMs = Date.now() - publishStartedAt;
    const server = (() => { try { return store.getServer(record!.id) ?? record!; } catch { return record!; } })();
    try {
      fs.appendFileSync(path.join(dataRoot, 'servers', server.id, INSTALLER_LOG_FILE), `[${new Date().toISOString()}] published as servers/${server.id}\n`);
    } catch { /* log capture is best-effort */ }
    log(`published as servers/${server.id}`);
    return { server, stagingId, installDurationMs, publishDurationMs, launch };
  } catch (error) {
    rollbackRecord();
    cleanupStaging();
    throw error;
  }
}
