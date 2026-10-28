// Modpack pipeline — preview/install/cancel mapped to the Rust DTO contract (src/tauri.ts).
// Preview = resolve + plan (no install); install = staged engine run (atomic publish, complete-or-
// nothing) with the durable report + sidecar. Phase 4 (WP-4.2/4.5/4.6/4.8):
//  - L1/L4 file decisions: optional files are included by default (`optionalDefaultKeep`); only
//    contradictory env/L4 signals fall back to `awaitingUserChoice`/`conflictingSignals`; server-
//    unsupported files stay excluded. Unresolved conflicts stop an unattended install.
//  - Preview plans are single-use and pinned: the resolved archive's size/mtime/SHA-256 snapshot is
//    re-checked at install time and a mismatch is rejected instead of installing unreviewed bytes.
//  - CurseForge route A/B installs never publish blank metadata: a pack that does not yield an exact
//    Minecraft version + loader fails cleanly before (or during) the staged transaction.
//  - Quilt is rejected for new installs (ADR-0005) in preview and again at install.
import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { IpcContext, Handler } from '../ipc';
import { appError, Store, type CreateServerInput, type ServerDto } from './store';
import { Jobs } from './jobs';
import { log, ensureServerProperties, writeEula } from './installer/core';
import { publishStagedServer, assertServerNameAvailable } from './install-transaction';
import { installMajorFor, requiredJavaMajor, ensureJava, validateJava } from './java';
import { makeCuratedResolver } from './installer/curated';
import { resolveMrpack, splitDeps, installModrinth, type MrIndex } from './installer/modrinth';
import { installCurseforge, inspectStagedZip, inspectCurseForgeProject, type InstallCfResult } from './installer/curseforge';
import { effectiveCacheDir } from './storage';

// ---- public source contract (renderer `PipelineSourceRequest`) ----
export type PipelineSourceRequest =
  | { kind: 'modrinthRemote'; projectId: string; versionId: string; loader?: PipelineLoaderPin; javaPath?: string }
  | { kind: 'localMrpack'; sourceId: string }
  | { kind: 'curseForgeServerZip'; zipName: string }
  | { kind: 'curseforgeProject'; projectId: number };

export type PipelineFileAction = 'include' | 'exclude' | 'awaitingUserChoice';
export type PipelineFileChoice = 'include' | 'exclude';
export type PipelineFileSide = 'server' | 'client' | 'both';
export type PipelineFileReason =
  | 'required'
  | 'optionalDefaultKeep'
  | 'userChoice'
  | 'serverUnsupported'
  | 'missingEnvironmentRetained'
  | 'conflictingSignals';

export interface PipelineFileDecision {
  path: string;
  side: PipelineFileSide | null;
  action: PipelineFileAction;
  reason: PipelineFileReason;
}

export interface PipelineLoaderPin { kind: string; minecraftVersion: string; loaderVersion: string | null }
export interface PipelineInstallTarget { serverId?: string; serverName?: string; directory?: string }

/** Snapshot of the resolved pack archive captured at preview time (drift guard). */
export interface PipelineArtifactSnapshot {
  kind: 'modrinthMrpack' | 'localMrpack' | 'curseforgeZip' | 'unknown';
  sizeBytes: number;
  mtimeMs: number;
  /** SHA-256 of the archive; null when the file is above the hashing limit (size/mtime still apply). */
  sha256: string | null;
}

export interface PipelineSourcePin {
  source: 'modrinth' | 'curseforge' | 'localMrpack' | 'unknown';
  projectId?: string | number;
  versionId?: string;
  zipName?: string;
  sourceId?: string;
  artifact: PipelineArtifactSnapshot | null;
}

/** Preview plan — matches `PipelineInstallPlan` in src/tauri.ts. */
export interface PipelineInstallPlan {
  schemaVersion: number;
  planId: string;
  createdAt: string;
  target: PipelineInstallTarget;
  sourcePin: unknown;
  loader: PipelineLoaderPin;
  fileDecisions: PipelineFileDecision[];
}

export interface PipelinePreviewDto {
  previewId: string;
  sourceName: string;
  warnings: string[];
  plan: PipelineInstallPlan;
}

interface HeldPreview {
  planId: string;
  createdAt: string;
  source: PipelineSourceRequest;
  sourceName: string;
  loader: PipelineLoaderPin;
  sourcePin: PipelineSourcePin;
  /** Archive the source pin snapshots (mrpack or CF zip); absent for key-mode projects. */
  artifactPath?: string;
  warnings: string[];
  /** L1/L4 decisions derived at preview (optionalDefaultKeep/conflictingSignals/…). */
  fileDecisions: PipelineFileDecision[];
  mrpackPath?: string;
  index?: MrIndex;
  slug?: string | null;
  zipPath?: string;
}

export interface PipelineInstallChoices { files: Record<string, PipelineFileChoice>; approvedReplacements: string[]; autoDeleteCurseForgeZip: boolean }
export interface PipelineCreateInput { name: string; port?: number; ramMb: number; javaPath?: string; eulaAccepted?: boolean }

// ---- install report / result DTOs (renderer `PipelineInstallReport`/`PipelineInstallResult`) ----
/** Install-report schema version; mirrors `PIPELINE_SCHEMA_VERSION` in the Rust reference. */
export const PIPELINE_REPORT_SCHEMA_VERSION = 1;
export const INSTALL_REPORT_FILE = 'install-report.json';

export type PipelineInstallStatus = 'preparing' | 'complete' | 'failed' | 'cancelled';

export interface PipelineInstallReportFile {
  path: string;
  outcome: string;
  sizeBytes?: number | null;
  hashes?: { sha1: string; sha512: string } | null;
  sourceHost?: string | null;
  detail?: string | null;
}
export interface PipelineInstallReportStage { stage: string; outcome: string; detail?: string | null }

/** Full durable install report — matches `PipelineInstallReport` in src/tauri.ts. */
export interface PipelineInstallReport {
  schemaVersion: number;
  planId: string;
  serverId: string;
  createdAt: string;
  status: PipelineInstallStatus;
  sourcePin: unknown;
  loader: PipelineLoaderPin;
  files: PipelineInstallReportFile[];
  stages: PipelineInstallReportStage[];
  warnings: string[];
  errors: string[];
}

export interface PipelineInstallResult {
  status: 'complete' | 'failed' | 'cancelled';
  server: ServerDto | null;
  report: PipelineInstallReport;
  error: string | null;
}

const LOADER_DTO: Record<string, string> = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt', vanilla: 'Vanilla', paper: 'Paper' };
/** Renderer `PipelineLoaderKind` uses `neoForge`; the engine uses `neoforge`. */
const REPORT_LOADER_KIND: Record<string, string> = { neoforge: 'neoForge' };

// ---- WP-4.8: new-install loader policy (ADR-0005) ----
export const QUILT_REJECTION_MESSAGE =
  'Quilt packs are not supported for new server installs (ADR-0005). Use a Fabric, Forge, NeoForge or Vanilla pack.';
/** Loaders accepted for a brand-new server install; existing Quilt servers keep working. */
const NEW_INSTALL_LOADERS = new Set(['vanilla', 'fabric', 'forge', 'neoforge']);

export function assertSupportedNewInstallLoader(kind: string | null | undefined): string {
  const normalized = (kind ?? '').trim().toLowerCase();
  if (normalized === 'quilt') throw appError('validation', QUILT_REJECTION_MESSAGE);
  if (!normalized) {
    throw appError('validation', 'The pack does not declare a supported server loader (expected Fabric, Forge, NeoForge or Vanilla).');
  }
  if (!NEW_INSTALL_LOADERS.has(normalized)) {
    throw appError('validation', `Loader "${kind}" is not supported for new server installs (expected Fabric, Forge, NeoForge or Vanilla).`);
  }
  return normalized;
}

// ---- WP-4.8: local .mrpack / staged archive source checks (Rust `pick_local_mrpack` parity) ----
export const MAX_LOCAL_MRPACK_BYTES = 2 * 1024 ** 3;

function assertRegularArchiveFile(filePath: string, label: string, extension?: string): fs.Stats {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch {
    throw appError('not-found', `The selected ${label} could not be found.`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw appError('validation', `Select a regular ${label}, not a folder or link.`);
  }
  if (extension && path.extname(filePath).toLowerCase() !== extension) {
    throw appError('validation', `Select a file with a ${extension} extension.`);
  }
  if (stats.size === 0 || stats.size > MAX_LOCAL_MRPACK_BYTES) {
    throw appError('validation', `${label} size is outside the 2 GiB import limit.`);
  }
  return stats;
}

/** Validate a renderer-supplied local .mrpack path: regular file, .mrpack extension, 0 < size <= 2 GiB. */
export function assertLocalMrpackSource(sourceId: string): fs.Stats {
  if (!sourceId || sourceId.trim() === '') throw appError('validation', 'Select a local .mrpack file.');
  return assertRegularArchiveFile(sourceId, '.mrpack file', '.mrpack');
}

// ---- WP-4.6: pure L1 env + curated-L4 file decision mapping ----
type EnvironmentPolicy = 'required' | 'optional' | 'unsupported';
const ENVIRONMENT_POLICIES = new Set<string>(['required', 'optional', 'unsupported']);

function normalizeEnvironmentPolicy(value: string | null | undefined): EnvironmentPolicy | null {
  const normalized = (value ?? '').trim().toLowerCase();
  return ENVIRONMENT_POLICIES.has(normalized) ? (normalized as EnvironmentPolicy) : null;
}

export interface PipelineFilePolicyInput {
  path: string;
  /** Modrinth `env.server` declaration; null/undefined = metadata missing. */
  serverEnv?: string | null;
  /** Modrinth `env.client` declaration (used for the client|server|both side). */
  clientEnv?: string | null;
  /** Curated L4 verdict for the same path (`makeCuratedResolver().resolve(...)`). */
  curated: { env: string; why: string };
  /** Explicit user choice from `PipelineInstallChoices.files` (install-time only). */
  choice?: PipelineFileChoice | null;
}

export interface PipelineFilePolicyResult { decision: PipelineFileDecision; warnings: string[] }

function sideFromClient(client: EnvironmentPolicy | null, policy: EnvironmentPolicy): PipelineFileSide | null {
  const clientSupported = client === 'required' || client === 'optional';
  if (policy === 'unsupported') return clientSupported ? 'client' : client === 'unsupported' ? 'both' : 'server';
  return client === 'unsupported' ? 'server' : clientSupported ? 'both' : 'server';
}

/**
 * Map one pack file's L1 `env` declarations + L4 curated verdict to a review decision.
 *
 * Rules (Rust `pipeline/selection.rs` parity + `docs/specs/modpack-server-setup-overhaul.md`):
 * - required -> include; server-unsupported -> exclude; missing env -> include with a warning.
 * - optional -> include by default (`optionalDefaultKeep`); an explicit choice overrides it
 *   (`userChoice`). Optional is never forced through `awaitingUserChoice`.
 * - contradictory signals (e.g. env required/optional but curated says unsupported) ->
 *   `awaitingUserChoice`/`conflictingSignals` until the user picks Include or Exclude.
 * - choices cannot bypass required/server-unsupported policy (validation error).
 */
export function mapFilePolicy(input: PipelineFilePolicyInput): PipelineFilePolicyResult {
  const declared = normalizeEnvironmentPolicy(input.serverEnv);
  const client = normalizeEnvironmentPolicy(input.clientEnv);
  const curated = normalizeEnvironmentPolicy(input.curated.env);
  // A curated hit only becomes an additional server-side signal when it actually overrides L1.
  const curatedSignal = curated !== null && input.curated.why !== 'declared' && curated !== declared;
  const warnings: string[] = [];
  if (curatedSignal) warnings.push(`${input.path}: ${input.curated.why}`);

  const serverSignals: EnvironmentPolicy[] = [];
  if (declared) serverSignals.push(declared);
  if (curatedSignal && curated) serverSignals.push(curated);
  const serverRequired = serverSignals.includes('required');
  const serverOptional = serverSignals.includes('optional');
  const serverUnsupported = serverSignals.includes('unsupported');
  const conflict = serverUnsupported && (serverRequired || serverOptional);
  const choice = input.choice ?? null;

  if (conflict) {
    if (choice) {
      return { decision: { path: input.path, side: null, action: choice, reason: 'userChoice' }, warnings };
    }
    return { decision: { path: input.path, side: null, action: 'awaitingUserChoice', reason: 'conflictingSignals' }, warnings };
  }
  if (serverUnsupported) {
    if (choice) throw appError('validation', `The server-unsupported file "${input.path}" does not accept a user choice.`);
    return { decision: { path: input.path, side: sideFromClient(client, 'unsupported'), action: 'exclude', reason: 'serverUnsupported' }, warnings };
  }
  if (serverRequired) {
    if (choice) throw appError('validation', `The required file "${input.path}" does not accept a user choice.`);
    return { decision: { path: input.path, side: sideFromClient(client, 'required'), action: 'include', reason: 'required' }, warnings };
  }
  if (serverOptional) {
    const side = sideFromClient(client, 'optional');
    if (choice) return { decision: { path: input.path, side, action: choice, reason: 'userChoice' }, warnings };
    return { decision: { path: input.path, side, action: 'include', reason: 'optionalDefaultKeep' }, warnings };
  }
  if (choice) throw appError('validation', `The file "${input.path}" has no server environment metadata and does not accept a user choice.`);
  return { decision: { path: input.path, side: null, action: 'include', reason: 'missingEnvironmentRetained' }, warnings };
}

// ---- WP-4.5: archive snapshot + drift guard ----
/** Archives above this size are pinned by size+mtime only (hashing multi-GB packs at preview costs). */
export const SNAPSHOT_HASH_LIMIT_BYTES = 128 * 1024 * 1024;

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Stat (+ SHA-256 when small enough) the resolved archive so a preview can be pinned to exact bytes. */
export async function snapshotArtifact(
  filePath: string,
  kind: PipelineArtifactSnapshot['kind'] = 'unknown',
  hashLimitBytes = SNAPSHOT_HASH_LIMIT_BYTES,
): Promise<PipelineArtifactSnapshot> {
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) throw appError('validation', 'The resolved pack archive is not a regular file.');
  const sha256 = stats.size <= hashLimitBytes ? await sha256File(filePath) : null;
  return { kind, sizeBytes: stats.size, mtimeMs: Math.round(stats.mtimeMs), sha256 };
}

/** Null when the archive still matches the reviewed snapshot; otherwise an actionable reason. */
export async function artifactDriftReason(filePath: string, expected: PipelineArtifactSnapshot): Promise<string | null> {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return 'The reviewed pack archive is no longer available';
  }
  if (!stats.isFile()) return 'The reviewed pack archive is no longer a regular file';
  if (stats.size !== expected.sizeBytes) {
    return `The reviewed pack archive changed size (${expected.sizeBytes} → ${stats.size} bytes)`;
  }
  if (Math.round(stats.mtimeMs) !== expected.mtimeMs) {
    return 'The reviewed pack archive was modified after review (file timestamp changed)';
  }
  if (expected.sha256) {
    let current: string;
    try {
      current = await sha256File(filePath);
    } catch (error) {
      return `The reviewed pack archive could not be re-hashed (${(error as Error).message})`;
    }
    if (current !== expected.sha256) return 'The reviewed pack archive contents changed after review (SHA-256 mismatch)';
  }
  return null;
}

// ---- report helpers ----
function loaderPinOf(loader: { kind: string; minecraftVersion: string; loaderVersion: string | null }): PipelineLoaderPin {
  return {
    kind: REPORT_LOADER_KIND[loader.kind] ?? loader.kind,
    minecraftVersion: loader.minecraftVersion,
    loaderVersion: loader.loaderVersion,
  };
}

/** Persist the durable install report inside the server directory (best effort, temp+rename). */
export function writeInstallReport(dir: string, report: PipelineInstallReport): boolean {
  const target = path.join(dir, INSTALL_REPORT_FILE);
  const tmp = `${target}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2));
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    return false;
  }
}

export class Pipeline {
  private previews = new Map<string, HeldPreview>();

  constructor(private ctx: IpcContext, private jobs: Jobs) {}

  private cacheDir(): string { return effectiveCacheDir(this.ctx.dataRoot); }

  async preview(source: PipelineSourceRequest, jobId: string): Promise<PipelinePreviewDto> {
    const controller = jobId ? this.jobs.begin(jobId) : null;
    try {
      return await this.previewInner(source, jobId, controller?.signal);
    } finally {
      if (jobId) this.jobs.end(jobId);
    }
  }

  private async previewInner(source: PipelineSourceRequest, jobId: string, signal?: AbortSignal): Promise<PipelinePreviewDto> {
    const held: HeldPreview = {
      planId: randomUUID(),
      createdAt: new Date().toISOString(),
      source,
      sourceName: '',
      loader: { kind: 'vanilla', minecraftVersion: '', loaderVersion: null },
      sourcePin: { source: 'unknown', artifact: null },
      warnings: [],
      fileDecisions: [],
    };
    const warnings = held.warnings;
    const decisions = held.fileDecisions;

    if (source.kind === 'modrinthRemote' || source.kind === 'localMrpack') {
      this.jobs.progress(jobId, { progress: 20, stage: 'resolving pack' });
      // WP-4.8: local archives are validated before the resolver touches them (regular file/.mrpack/2 GiB).
      if (source.kind === 'localMrpack') assertLocalMrpackSource(source.sourceId);
      const resolved = await resolveMrpack(
        source.kind === 'modrinthRemote' ? { projectId: source.projectId, versionId: source.versionId } : { localPath: source.sourceId },
        this.cacheDir(),
        { signal },
      );
      held.mrpackPath = resolved.mrpackPath;
      held.artifactPath = resolved.mrpackPath;
      held.index = resolved.index;
      held.slug = resolved.slug;
      held.sourcePin = {
        source: source.kind === 'modrinthRemote' ? 'modrinth' : 'localMrpack',
        ...(source.kind === 'modrinthRemote'
          ? { projectId: source.projectId, versionId: source.versionId }
          : { sourceId: source.sourceId }),
        artifact: await snapshotArtifact(resolved.mrpackPath, source.kind === 'modrinthRemote' ? 'modrinthMrpack' : 'localMrpack'),
      };
      const { kind, ver, mc } = splitDeps(resolved.index);
      if (!kind) throw appError('validation', `Unsupported loader in pack dependencies: ${JSON.stringify(resolved.index.dependencies)}`);
      // WP-4.8: Quilt is a disabled/planned placeholder for new installs (ADR-0005).
      assertSupportedNewInstallLoader(kind);
      held.loader = { kind, minecraftVersion: mc, loaderVersion: ver };
      held.sourceName = resolved.index.name;
      const curated = makeCuratedResolver({ platform: 'modrinth', packSlug: resolved.slug, presentPaths: resolved.index.files.map(file => file.path) });
      for (const file of resolved.index.files) {
        const mapped = mapFilePolicy({
          path: file.path,
          serverEnv: file.env?.server ?? null,
          clientEnv: file.env?.client ?? null,
          curated: curated.resolve(file.path, file.env?.server ?? 'required'),
        });
        warnings.push(...mapped.warnings);
        decisions.push(mapped.decision);
      }
    } else if (source.kind === 'curseForgeServerZip') {
      const zipPath = path.join(this.ctx.dataRoot, 'curseforge-import', source.zipName);
      if (!fs.existsSync(zipPath)) throw appError('not-found', `Staged ZIP "${source.zipName}" not found.`);
      assertRegularArchiveFile(zipPath, 'staged server ZIP');
      const insp = await inspectStagedZip(zipPath);
      if (insp.classification !== 'supportedServerPack' && insp.classification !== 'clientExport') {
        throw appError('validation', `${source.zipName}: ${insp.reason}`);
      }
      // WP-4.8: Quilt is a disabled/planned placeholder for new installs (ADR-0005).
      if ((insp.loader ?? '').trim().toLowerCase() === 'quilt') throw appError('validation', QUILT_REJECTION_MESSAGE);
      if (insp.classification === 'clientExport' && (!insp.loader || !insp.minecraftVersion)) {
        throw appError('validation', `${source.zipName}: the manifest does not declare a loader and Minecraft version.`);
      }
      held.zipPath = zipPath;
      held.artifactPath = zipPath;
      held.sourceName = insp.name.replace(/\.zip$/i, '');
      held.loader = { kind: (insp.loader ?? '').toLowerCase(), minecraftVersion: insp.minecraftVersion ?? '', loaderVersion: insp.loaderVersion };
      held.sourcePin = { source: 'curseforge', zipName: source.zipName, artifact: await snapshotArtifact(zipPath, 'curseforgeZip') };
      warnings.push(insp.reason);
    } else if (source.kind === 'curseforgeProject') {
      this.jobs.progress(jobId, { progress: 15, stage: 'resolving CurseForge project' });
      const meta = await inspectCurseForgeProject(Number(source.projectId), this.ctx.dataRoot);
      if (!meta.loader || !meta.minecraftVersion) {
        throw appError('validation', `CurseForge project ${source.projectId} does not declare a loader and Minecraft version.`);
      }
      assertSupportedNewInstallLoader(meta.loader);
      held.sourceName = meta.name;
      held.loader = { kind: meta.loader, minecraftVersion: meta.minecraftVersion, loaderVersion: meta.loaderVersion };
      // The key-mode artifact is only downloaded during install; the project/file pin is recorded here.
      held.sourcePin = { source: 'curseforge', projectId: Number(source.projectId), artifact: null };
      warnings.push(meta.hasServerPack
        ? 'Official API key mode: the latest server pack (serverPackFileId) will be installed.'
        : 'Official API key mode: no server pack on the latest file; the client pack is resolved from manifest.json.');
    }

    const previewId = randomUUID();
    this.previews.set(previewId, held);
    this.jobs.progress(jobId, { progress: 100, stage: 'preview ready' });
    const plan: PipelineInstallPlan = {
      schemaVersion: PIPELINE_REPORT_SCHEMA_VERSION,
      planId: held.planId,
      createdAt: held.createdAt,
      // Preview is not yet bound to a server row: the staged id is reserved at install time.
      target: { serverId: '', serverName: '', directory: '' },
      sourcePin: held.sourcePin,
      loader: loaderPinOf(held.loader),
      fileDecisions: decisions,
    };
    return { previewId, sourceName: held.sourceName, warnings, plan };
  }

  discardPreview(previewId: string): boolean { return this.previews.delete(previewId); }

  async install(previewId: string, input: PipelineCreateInput, choices: PipelineInstallChoices, jobId: string): Promise<PipelineInstallResult> {
    // WP-4.1: the job's AbortController is shared with the publish transaction (boot verification and
    // the cancellation checkpoints inside publishStagedServer).
    const controller = jobId ? this.jobs.begin(jobId) : null;
    try {
      return await this.installInner(previewId, input, choices, jobId, controller?.signal);
    } finally {
      if (jobId) this.jobs.end(jobId);
    }
  }

  private async installInner(previewId: string, input: PipelineCreateInput, choices: PipelineInstallChoices, jobId: string, signal?: AbortSignal): Promise<PipelineInstallResult> {
    const held = this.previews.get(previewId);
    if (!held) {
      return this.finalizeFailure('failed', this.createReport(null), `Preview ${previewId} not found or already used; review the pack again.`);
    }
    // WP-4.5: previews are single-use — consume before any validation/mutation. A pre-mutation failure
    // below re-inserts it (the user may retry); anything after the staged transaction starts does not.
    this.previews.delete(previewId);

    const store = new Store(this.ctx.dataRoot);
    const report = this.createReport(held);
    let mutationStarted = false;
    let sidecarData: Record<string, unknown> | null = null;
    let createInput: CreateServerInput | null = null;

    try {
      // ---- pre-mutation validation (failure re-inserts the preview) ----
      assertServerNameAvailable(store, input.name);
      this.assertResolvedFileChoices(held, choices);
      this.assertInstallableSource(held);
      const port = await store.allocatePort(input.port ?? null);
      await this.assertNoSourceDrift(held);
      this.jobs.progress(jobId, { progress: 5, stage: 'preparing' });
      // WP-4.3/4.5: pin the exact Java runtime before the staged transaction (validated override or
      // provisioned Temurin) and never guess a JDK major for an unknown Minecraft version.
      let javaExe: string | null = null;
      if (held.loader.minecraftVersion.trim() !== '') {
        this.jobs.progress(jobId, { progress: 8, stage: 'resolving Java' });
        const requiredMajor = await requiredJavaMajor(held.loader.minecraftVersion);
        const installMajor = installMajorFor(requiredMajor) ?? requiredMajor;
        javaExe = input.javaPath
          ? (await validateJava(input.javaPath, requiredMajor)).path
          : (await ensureJava(installMajor, path.join(this.ctx.dataRoot, 'runtime'), this.cacheDir())).path;
      }

      const loaderName = LOADER_DTO[held.loader.kind] ?? 'Vanilla';
      createInput = {
        name: input.name,
        loader: loaderName,
        mcVersion: held.loader.minecraftVersion,
        loaderVersion: held.loader.loaderVersion ?? undefined,
        modpackId: held.source.kind === 'modrinthRemote' ? held.source.projectId : held.slug ?? undefined,
        port,
        ramMb: input.ramMb,
        javaPath: javaExe ?? input.javaPath,
        eulaAccepted: input.eulaAccepted,
      };
      const installInput = createInput;

      // ---- mutation boundary: staged install/publish (atomic, complete-or-nothing) ----
      mutationStarted = true;
      const installed = await publishStagedServer({
        dataRoot: this.ctx.dataRoot,
        store,
        // Pack loaders vary per route: validate the launch shape (launchCommand) rather than one
        // loader-specific artifact (the route-A inspection can only guess the loader).
        loaderKind: null,
        input: installInput,
        isCancelled: () => this.jobs.isCancelled(jobId),
        signal,
        enforceManagerConfig: { port, eulaAccepted: input.eulaAccepted ?? false },
        // WP-4.3 (M-10) verified install: the staged server must reach `Done (` once before it is
        // published as a success. The runtime is already pinned above (no guessed Java major); a
        // server cannot legally boot without explicit EULA consent, so verification is skipped then.
        bootVerify: { enabled: input.eulaAccepted === true && Boolean(javaExe), javaPath: javaExe },
        // Provisional id for failed report DTOs (Phase 1 contract: serverId is always populated).
        onStaging: ({ stagingId }) => { report.serverId = stagingId; },
        onProgress: event => this.jobs.progress(jobId, { progress: event.progress, stage: event.stage }),
        // WP-4.3: boot verification runs inside the transaction (before the record exists), so a
        // failed first boot rolls the staging tree back and surfaces as a failed report.
        install: async ({ stagingDir, log: installLog }) => {
          const onProgress = (p: { stage: string; pct?: number }): void => {
            installLog(`${p.stage}${p.pct != null ? ` ${p.pct}%` : ''}`);
            this.jobs.progress(jobId, { progress: p.pct ?? 10, stage: p.stage });
          };

          if (held.index && held.mrpackPath) {
            const res = await installModrinth({
              mrpackPath: held.mrpackPath, index: held.index, slug: held.slug ?? null,
              dir: stagingDir, cacheDir: this.cacheDir(), dataRoot: this.ctx.dataRoot,
              onProgress,
              signal,
              // WP-4.6: optional files are included by default; only an explicit Exclude removes them.
              includeOptional: filePath => choices.files[filePath] !== 'exclude',
            });
            report.files.push({ path: `${res.installed} files`, outcome: 'installed' });
            report.files.push({ path: `${res.skippedOptional} optional`, outcome: 'skipped-optional' });
            report.files.push({ path: `${res.skippedUnsupported} unsupported`, outcome: 'skipped-server-unsupported' });
            report.warnings.push(...res.warnings);
            report.stages.push({ stage: 'download', outcome: 'complete' });
            sidecarData = {
              platform: 'modrinth', slug: held.slug,
              files: held.index.files.map(file => file.path),
              loader: held.loader.kind, mc: held.loader.minecraftVersion,
            };
          } else if (held.zipPath || held.source.kind === 'curseForgeServerZip' || held.source.kind === 'curseforgeProject') {
            const zipPath = held.zipPath ?? (held.source.kind === 'curseForgeServerZip'
              ? path.join(this.ctx.dataRoot, 'curseforge-import', held.source.zipName)
              : undefined);
            const projectId = held.source.kind === 'curseforgeProject' ? Number(held.source.projectId) : undefined;
            const res = await installCurseforge({ zipPath, projectId, dir: stagingDir, dataRoot: this.ctx.dataRoot, cacheDir: this.cacheDir(), onProgress, signal });
            // WP-4.5: never publish blank route-A/B metadata; prefer the engine's inferred values.
            const inferred = this.applyCurseForgeMetadata(held, res, installInput, report);
            report.files.push({ path: `${res.installed} mods`, outcome: 'installed' });
            report.files.push({ path: `${res.skippedClientOnly} client-only`, outcome: 'skipped-client-only' });
            report.warnings.push(...res.warnings);
            for (const m of res.manuallyRequired) report.warnings.push(`manually required: ${m.pageUrl} (${m.reason})`);
            report.stages.push({ stage: `route-${res.route}`, outcome: 'complete' });
            sidecarData = {
              platform: 'curseforge', slug: projectId ? String(projectId) : null,
              files: [], loader: inferred.loader, mc: inferred.mc,
            };
            if (choices.autoDeleteCurseForgeZip && zipPath && zipPath.startsWith(path.join(this.ctx.dataRoot, 'curseforge-import'))) {
              fs.rmSync(zipPath, { force: true });
            }
          } else {
            throw appError('validation', 'Unsupported pipeline source.');
          }

          ensureServerProperties(stagingDir, port);
          if (input.eulaAccepted) writeEula(stagingDir);
          installLog('configuration written (server.properties/eula)');
          // WP-4.5: sidecar now carries the reviewed plan id + source pin snapshot (audit trail).
          this.writeSidecar(stagingDir, {
            ...(sidecarData ?? {}),
            planId: held.planId,
            sourcePin: held.sourcePin,
            plan: { schemaVersion: PIPELINE_REPORT_SCHEMA_VERSION, planId: held.planId, createdAt: held.createdAt },
          });
        },
        beforePublish: (server, { stagingDir }) => {
          report.serverId = server.id;
          report.status = 'complete';
          // Chronological stage evidence: install/download + route stages were recorded by the engine,
          // validation happened before boot verification, and publish is last.
          report.stages.push({ stage: 'validate', outcome: 'complete' });
          if (javaExe && input.eulaAccepted === true) report.stages.push({ stage: 'verify-boot', outcome: 'complete' });
          report.stages.push({ stage: 'publish', outcome: 'complete' });
          // Written into the staged tree, so install-report.json is published atomically with it.
          writeInstallReport(stagingDir, report);
        },
      });

      this.jobs.progress(jobId, { progress: 100, stage: 'install complete' });
      return { status: 'complete', server: installed.server, report, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = (err as { code?: string }).code === 'cancelled' ? 'cancelled' : 'failed';
      // Re-insert only a preview that failed before the staged transaction mutated anything.
      if (!mutationStarted) this.previews.set(previewId, held);
      return this.finalizeFailure(status, report, message);
    }
  }

  /** WP-4.6: re-derive decisions with the user's explicit choices; unresolved contradictions stop. */
  private assertResolvedFileChoices(held: HeldPreview, choices: PipelineInstallChoices): void {
    if (!held.index) return;
    const curated = makeCuratedResolver({ platform: 'modrinth', packSlug: held.slug, presentPaths: held.index.files.map(file => file.path) });
    const unresolved: string[] = [];
    for (const file of held.index.files) {
      const mapped = mapFilePolicy({
        path: file.path,
        serverEnv: file.env?.server ?? null,
        clientEnv: file.env?.client ?? null,
        curated: curated.resolve(file.path, file.env?.server ?? 'required'),
        choice: choices.files[file.path] ?? null,
      });
      if (mapped.decision.action === 'awaitingUserChoice') unresolved.push(file.path);
    }
    if (unresolved.length > 0) {
      const shown = unresolved.slice(0, 5).join(', ');
      throw appError('validation',
        `${unresolved.length} file(s) have conflicting server/client signals; choose Include or Exclude before installing (${shown}${unresolved.length > 5 ? ', …' : ''}).`);
    }
  }

  /** WP-4.8/WP-4.5: Quilt policy and CurseForge exact-metadata preconditions, before mutation. */
  private assertInstallableSource(held: HeldPreview): void {
    if (held.source.kind === 'curseForgeServerZip' || held.source.kind === 'curseforgeProject') {
      this.assertCurseForgeMetadata(held.loader.kind, held.loader.minecraftVersion);
      return;
    }
    assertSupportedNewInstallLoader(held.loader.kind);
  }

  private assertCurseForgeMetadata(kind: string, minecraftVersion: string): void {
    if (!kind.trim() || !minecraftVersion.trim()) {
      throw appError('validation',
        'The CurseForge server pack does not declare an exact Minecraft version and loader, so it cannot be installed safely. '
        + 'Use an author server pack with exact server metadata (or a Modrinth pack); blank metadata is never published.');
    }
    assertSupportedNewInstallLoader(kind);
  }

  /** Apply the CurseForge engine's inferred loader/Minecraft metadata to the record + report, or fail. */
  private applyCurseForgeMetadata(
    held: HeldPreview,
    result: InstallCfResult,
    input: CreateServerInput,
    report: PipelineInstallReport,
  ): { loader: string; mc: string } {
    const kind = (result.loader ?? held.loader.kind ?? '').trim().toLowerCase();
    const minecraftVersion = (result.mc ?? held.loader.minecraftVersion ?? '').trim();
    this.assertCurseForgeMetadata(kind, minecraftVersion);
    const loaderName = LOADER_DTO[kind];
    if (!loaderName) throw appError('validation', `Unsupported CurseForge pack loader: ${kind}.`);
    const loaderVersion = result.loaderVersion ?? held.loader.loaderVersion;
    input.loader = loaderName;
    input.mcVersion = minecraftVersion;
    input.loaderVersion = loaderVersion ?? undefined;
    report.loader = { kind: REPORT_LOADER_KIND[kind] ?? kind, minecraftVersion, loaderVersion };
    if (!held.loader.minecraftVersion || held.loader.kind !== kind) {
      log(`[pipeline] route-${result.route} engine metadata: ${loaderName} ${minecraftVersion}${loaderVersion ? ` (${loaderVersion})` : ''}`);
    }
    return { loader: loaderName, mc: minecraftVersion };
  }

  /** WP-4.5: reject when the reviewed archive no longer matches the preview snapshot. */
  private async assertNoSourceDrift(held: HeldPreview): Promise<void> {
    const expected = held.sourcePin.artifact;
    if (!expected || !held.artifactPath) return;
    const reason = await artifactDriftReason(held.artifactPath, expected);
    if (reason) {
      throw appError('validation', `${reason}. Review the pack again so the install matches exactly what was approved.`);
    }
  }

  /** Terminal failure/cancel result: the transaction has already removed staging and any record. */
  private finalizeFailure(status: 'failed' | 'cancelled', report: PipelineInstallReport, error: string | null): PipelineInstallResult {
    report.status = status;
    if (error) report.errors.push(error);
    log(`[pipeline] ${status}${error ? `: ${error}` : ''}`);
    return { status, server: null, report, error };
  }

  /** Full report skeleton shared by every terminal outcome (success/failure/cancel). */
  private createReport(held: HeldPreview | null): PipelineInstallReport {
    return {
      schemaVersion: PIPELINE_REPORT_SCHEMA_VERSION,
      planId: held?.planId ?? '',
      serverId: '',
      createdAt: new Date().toISOString(),
      status: 'preparing',
      sourcePin: held?.sourcePin ?? null,
      loader: held
        ? loaderPinOf(held.loader)
        : { kind: 'vanilla', minecraftVersion: '', loaderVersion: null },
      files: [],
      stages: [],
      warnings: [],
      errors: [],
    };
  }

  private writeSidecar(dir: string, data: Record<string, unknown>): void {
    try { fs.writeFileSync(path.join(dir, 'msm-install.json'), JSON.stringify({ ...data, at: new Date().toISOString() }, null, 2)); } catch { /* best effort */ }
  }

  handlers(): Record<string, Handler> {
    return {
      modpack_pipeline_pick_local_mrpack: async () => {
        const { dialog } = await import('electron');
        const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Modrinth modpack', extensions: ['mrpack'] }] });
        if (r.canceled || !r.filePaths[0]) return null;
        // WP-4.8: validate the picked path before handing it to the renderer/preview.
        assertLocalMrpackSource(r.filePaths[0]);
        return { sourceId: r.filePaths[0], fileName: path.basename(r.filePaths[0]) };
      },
      modpack_pipeline_preview: async a => this.preview(a.source as PipelineSourceRequest, String(a.jobId ?? '')),
      modpack_pipeline_install: async a => this.install(String(a.previewId), a.input as PipelineCreateInput, a.choices as PipelineInstallChoices, String(a.jobId ?? '')),
      modpack_pipeline_cancel: a => this.jobs.cancel(String(a.jobId)),
      modpack_pipeline_discard_preview: a => this.discardPreview(String(a.previewId)),
      modpack_pipeline_release_local_mrpack: () => true,
    };
  }
}
