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
import { launchCommand, type LaunchCommand, type LoaderKind } from './installer/core';

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
  /** Reserved staging path, before any installer work (pipeline uses it for the report serverId). */
  onStaging?: (ctx: { stagingId: string; stagingDir: string }) => void;
  /** After validation + record creation, before the atomic publish (sync on purpose: no IPC gap). */
  beforePublish?: (server: ServerDto, ctx: StagedServerContext) => void;
  /** Override the directory publisher (tests inject a failing one; default rename + EXDEV fallback). */
  publish?: (fromDir: string, toDir: string) => void;
  onProgress?: (event: { stage: string; progress: number }) => void;
  isCancelled?: () => boolean;
}

export interface PublishStagedServerResult {
  server: ServerDto;
  stagingId: string;
  installDurationMs: number;
  publishDurationMs: number;
  launch: LaunchCommand | null;
}

/** `renameSync`, falling back to a private copy + rename for cross-volume data roots (EXDEV). */
export function publishStagedDirectory(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  const temp = `${to}.publishing-${randomUUID()}`;
  try {
    fs.cpSync(from, temp, { recursive: true, errorOnExist: true, force: false });
    fs.renameSync(temp, to);
    fs.rmSync(from, { recursive: true, force: true });
  } catch (error) {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
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
