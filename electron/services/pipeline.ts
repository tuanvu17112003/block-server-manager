// Modpack pipeline ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â preview/install/cancel mapped to the Rust DTO contract (src/tauri.ts).
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
import { log, ensureServerProperties, writeEula, startWithAutoFix, fetchTrusted, installLoader, LOADER_ALLOWED_HOSTS, type AutoFixEntry } from './installer/core';
import {
  classifyBootFailure, explainNoEscalation, logEscalation, nextLoaderBuild, planLoaderBuilds,
  type LoaderBuildPlan,
} from './installer/loader-build';
import { publishStagedServer, assertServerNameAvailable, validateStagedInstall } from './install-transaction';
import { installMajorFor, requiredJavaMajor, ensureJava, validateJava } from './java';
import { makeCuratedResolver, appendLearned } from './installer/curated';
import { resolveMrpack, splitDeps, installModrinth, fetchModrinthDependency, type MrIndex } from './installer/modrinth';
import { installCurseforge, inspectStagedZip, inspectCurseForgeProject, type InstallCfResult } from './installer/curseforge';
import { effectiveCacheDir } from './storage';
import {
  adapterRegistry, createAdapterIo, type DetectInput, type PackRecipe, type PlannedFile,
} from './adapters/index';
import { installRecipe } from './installer/recipe';
import { normalizeArchive } from './adapters/normalize';
import { downloadFirstAvailable } from './installer/core';

// ---- public source contract (renderer `PipelineSourceRequest`) ----
export type PipelineSourceRequest =
  | { kind: 'modrinthRemote'; projectId: string; versionId: string; loader?: PipelineLoaderPin; javaPath?: string }
  | { kind: 'localMrpack'; sourceId: string }
  | { kind: 'curseForgeServerZip'; zipName: string }
  | { kind: 'curseforgeProject'; projectId: number }
  // ---- P1b: format-agnostic inputs, resolved by the pack adapter layer ----
  /** An FTB pack resolved from the public API (no key). `versionId` omitted ÃƒÂ¢Ã¢â‚¬Â¡Ã¢â‚¬â„¢ latest. */
  | { kind: 'ftbProject'; packId: number; versionId?: number }
  /** A launcher archive handed to the adapter registry; the format is detected from its contents. */
  | { kind: 'packArchive'; sourceId: string };

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
  source: 'modrinth' | 'curseforge' | 'localMrpack' | 'ftb' | 'packArchive' | 'unknown';
  projectId?: string | number;
  versionId?: string;
  zipName?: string;
  sourceId?: string;
  artifact: PipelineArtifactSnapshot | null;
}

/** Preview plan ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â matches `PipelineInstallPlan` in src/tauri.ts. */
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
  /**
   * Evidence grade of the detected format (docs/audit/19 §2). 
ull when the source kind has no adapter
   * recipe (CurseForge key mode, cached zip) — absent means unknown, never an assumed grade.
   * Only ''E1''/''E2'' may be presented as supported; ''E3''/''E4'' must be shown as not yet proven.
   */
  evidence: { grade: string; note: string; formatId: string } | null;
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
  /** L1/L4 decisions derived at preview (optionalDefaultKeep/conflictingSignals/ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦). */
  fileDecisions: PipelineFileDecision[];
  mrpackPath?: string;
  index?: MrIndex;
  slug?: string | null;
  zipPath?: string;
  /** P1b: canonical recipe produced by the pack adapter layer (FTB / detected archives). */
  recipe?: PackRecipe;
  /** P1b/C2: the archive that actually holds the pack after normalization (may be an unwrapped inner zip). */
  normalizedArtifactPath?: string;
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

/** Full durable install report ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â matches `PipelineInstallReport` in src/tauri.ts. */
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
  /** True for community force-includes: authoritative required, never a user conflict. */
  curatedProtect?: boolean;
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

  // Community force-includes (`simplytooltips`, `s-lib`, ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦) are evidence-backed corrections: the
  // server needs them even when the pack declares `unsupported`. They are required, not a conflict,
  // and must never be offered as a user choice (excluding them breaks their dependents).
  if (input.curatedProtect) {
    if (choice === 'exclude') {
      throw appError('validation', `The force-included dependency "${input.path}" is required by the pack and cannot be excluded.`);
    }
    return { decision: { path: input.path, side: sideFromClient(client, 'required'), action: 'include', reason: 'required' }, warnings };
  }

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

/**
 * WP-4.6 install-time include set. Only an **explicit** `include` choice may override a curated
 * unsupported verdict (the reviewed plan's promise), plus `optionalDefaultKeep` files the UI keeps by
 * default when a headless caller did not send a per-file choice. Everything else ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â most importantly
 * curated exclusions that were never offered as a conflict ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â must stay excluded. Passing a
 * "not excluded" predicate instead here makes every curated exclusion look user-approved, which is
 * how Prominence II shipped `drippyloadingscreen`/`welcomescreen` without their `fancymenu` dependency.
 */
export function resolveIncludedPaths(
  decisions: PipelineFileDecision[],
  choices: Record<string, PipelineFileChoice>,
): Set<string> {
  const included = new Set<string>();
  for (const decision of decisions) {
    const choice = choices[decision.path];
    if (choice === 'include') included.add(decision.path);
    else if (choice === undefined && decision.reason === 'optionalDefaultKeep') included.add(decision.path);
  }
  return included;
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
    return `The reviewed pack archive changed size (${expected.sizeBytes} ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ ${stats.size} bytes)`;
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

  /**
   * Where the boot-time learner persists what it discovered about mods (research Ã‚Â§7 gap 7).
   *
   * `server-process.ts:304` already reads and writes this file, so learning improved *subsequent server starts*
   * but never the *install-time* plan: every `makeCuratedResolver` call in this file omitted `learnedFile`, so a
   * mod already known to need disabling was still downloaded on the next install. Fixing only one side of that
   * pair is what made the gap invisible Ã¢â‚¬â€ the learner looked implemented because it was, on one path.
   */
  private learnedOverridesPath(): string {
    return path.join(this.ctx.dataRoot, 'state', 'env-overrides-learned.json');
  }

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
      const curated = makeCuratedResolver({ platform: 'modrinth', packSlug: resolved.slug, presentPaths: resolved.index.files.map(file => file.path), learnedFile: this.learnedOverridesPath() });
      for (const file of resolved.index.files) {
        const verdict = curated.resolve(file.path, file.env?.server ?? 'required');
        const mapped = mapFilePolicy({
          path: file.path,
          serverEnv: file.env?.server ?? null,
          clientEnv: file.env?.client ?? null,
          curated: verdict,
          curatedProtect: verdict.protect,
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
      // ---- acquisition shape B (provider API), NOT shape A ----
      // This branch is the CurseForge *provider* path: it asks the official API for the latest file and its
      // server-pack id. The `curseforge.client` / `curseforge.serverpack` adapters declare `shapes: ['archive']`
      // only, so key-mode traffic deliberately does NOT flow through them â€” they are not two implementations of
      // one thing, they serve different acquisition shapes (docs/audit/23 Â§4.1).
      //
      // Recorded because the Lead's own first proposal ("route the CurseForge pipeline through the adapter
      // layer") was wrong in exactly this way: it would have pushed a working E2 path through new code to
      // satisfy a symmetry that does not exist, risking the 12/12 matrix for tidiness. Invariant I1 says cover
      // the working path first. What is genuinely missing is a `curseforge.provider` adapter for shape B â€” see
      // docs/audit/26 Item 2 and DV-33.
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
    } else if (source.kind === 'ftbProject' || source.kind === 'packArchive') {
      // ---- P1b: format detected by the adapter layer, not by the UI source kind ----
      this.jobs.progress(jobId, { progress: 15, stage: 'detecting pack format' });
      const adapterIo = createAdapterIo(message => log(message));
      // Acquisition shape (docs/audit/23 Ãƒâ€šÃ‚Â§4.1): the registry only routes an input to adapters that declare it.
      let detectInput: DetectInput;
      if (source.kind === 'ftbProject') {
        detectInput = { shape: 'provider', kind: 'ftb', ids: { packId: source.packId, versionId: source.versionId }, cacheDir: this.cacheDir() };
      } else {
        const archivePath = assertRegularArchiveFile(source.sourceId, 'modpack archive');
        held.artifactPath = source.sourceId;
        // Normalize before detection (research Ãƒâ€šÃ‚Â§6 step 2): unwrap one nested zip, detect a wrapper dir.
        const normalized = await normalizeArchive(source.sourceId, { log: message => log(message) });
        held.normalizedArtifactPath = normalized.effectivePath;
        detectInput = { shape: 'archive', index: normalized.index, path: normalized.effectivePath };
        if (normalized.unwrapped) {
          warnings.push(`unwrapped a nested zip "${normalized.nestedZip}" before detection (${normalized.outerEntryCount} outer entries)`);
        }
      }

      const recipe = await adapterRegistry.resolve(detectInput, adapterIo);
      held.recipe = recipe;
      held.sourceName = recipe.name;
      held.loader = { kind: recipe.loader, minecraftVersion: recipe.mc, loaderVersion: recipe.loaderVersion };
      held.sourcePin = source.kind === 'ftbProject'
        ? { source: 'ftb', projectId: source.packId, ...(source.versionId === undefined ? {} : { versionId: String(source.versionId) }), artifact: null }
        : { source: 'packArchive', sourceId: source.sourceId, artifact: null };
      log(`[adapters] ${recipe.formatId}: "${recipe.name}" ${recipe.loader} ${recipe.loaderVersion ?? '(unpinned)'} MC ${recipe.mc}, ${recipe.files.length} files`);
      for (const entry of recipe.resolution) log(`[adapters]   ${entry.field} ÃƒÂ¢Ã¢â‚¬Â Ã‚Â ${entry.source}`);
      for (const warning of recipe.warnings) {
        warnings.push(`${warning.rule}${warning.path ? ` (${warning.path})` : ''}: ${warning.message}`);
      }

      // Canonical side resolution (L1). The boot-time L2/L3 layer still has the final say, which is the
      // whole point: `unknown` stays a normal server candidate here instead of being silently excluded.
      const curated = makeCuratedResolver({
        platform: recipe.formatId.startsWith('curseforge') ? 'curseforge' : 'modrinth',
        packSlug: null,
        presentPaths: recipe.files.map(file => file.path),
        learnedFile: this.learnedOverridesPath(),
      });
      for (const file of recipe.files) {
        const declared = file.side === 'unknown' ? 'required' : file.side;
        const verdict = curated.resolve(file.path, declared);
        const mapped = mapFilePolicy({
          path: file.path,
          serverEnv: file.side === 'unknown' ? null : file.side,
          clientEnv: null,
          curated: verdict,
          curatedProtect: verdict.protect,
        });
        warnings.push(...mapped.warnings);
        decisions.push(mapped.decision);
      }
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
    // docs/audit/26 Item 4: carry the format's evidence grade to the UI. The grade already exists on every
    // recipe and is enforced by `validateRecipe`, but it was invisible to the user â€” so a format that is merely
    // schema-derived (E3) looked identical to one with a real verified install (E2). Only the code knowing that
    // difference does not complete the "no unsupported claim" principle. Key-mode/legacy paths have no recipe,
    // hence null rather than a guessed grade.
    const evidence = held.recipe
      ? { grade: held.recipe.evidenceGrade, note: held.recipe.evidenceNote, formatId: held.recipe.formatId }
      : null;
    return { previewId, sourceName: held.sourceName, warnings, plan, evidence };
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
    // WP-4.5: previews are single-use ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â consume before any validation/mutation. A pre-mutation failure
    // below re-inserts it (the user may retry); anything after the staged transaction starts does not.
    this.previews.delete(previewId);

    const store = new Store(this.ctx.dataRoot);
    const report = this.createReport(held);
    let mutationStarted = false;
    let sidecarData: Record<string, unknown> | null = null;
    let createInput: CreateServerInput | null = null;
    // D9 install-time defense context: populated by the install callback, consumed by bootCheck.
    let autoFixContext: {
      platform: 'modrinth' | 'curseforge';
      mc: string;
      loader: string;
      protectBasenames: Set<string>;
      fetchDependency: ((modId: string) => Promise<string | null>) | null;
    } | null = null;
    let autoFixFixes: AutoFixEntry[] = [];
    let autoFixRounds = 0;
    // Loader-build policy: computed from the recipe, consumed by bootCheck. Only packs that declare no build
    // may escalate, and only on a loader-level boot failure (see installer/loader-build.ts).
    let loaderPlan: LoaderBuildPlan | null = null;
    let loaderEscalations = 0;

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
        // WP-4.3 / D9 verified install: the staged server must reach `Done (` before publication.
        // The reference install path runs L2 (jar self-declaration scan) then the L3 boot-decides
        // loop (crash attribution, reversible `mods-disabled/`, Modrinth dependency fetch) and only
        // publishes after that succeeds; a single un-assisted boot rejects exactly the packs the
        // 4-layer pipeline was built to accept (Prominence II: `fancymenu` absent while
        // drippyloadingscreen/welcomescreen require it).
        bootVerify: { enabled: input.eulaAccepted === true && Boolean(javaExe), javaPath: javaExe },
        // D9: the verification boot is the L3 authority, not a single bare start. L2 self-declared
        // client jars are moved to `mods-disabled/` first, then crash/log attribution may disable
        // offending jars and (Modrinth only) fetch a missing hard dependency, retrying until `Done (`.
        bootCheck: async (stagingDir, launch, javaPath) => {
          const result = await startWithAutoFix(
            stagingDir,
            javaPath ? { exe: javaPath, args: launch.args } : launch,
            {
              timeoutMs: 8 * 60_000,
              maxRounds: 6,
              ...(autoFixContext ? { l2Protect: autoFixContext.protectBasenames } : {}),
              ...(autoFixContext?.fetchDependency ? { fetchDep: autoFixContext.fetchDependency } : {}),
            },
          );
          autoFixFixes = result.fixes;
          autoFixRounds = result.rounds;

          // ---- loader-build escalation (see installer/loader-build.ts) ----
          // The pack's L2/L3 loop could not make it boot. If ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â and only if ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the pack declared no loader build
          // and the failure is provably at the loader level, try the next provider build, within a hard budget.
          if (!result.ok && loaderPlan && !loaderPlan.declared) {
            const failure = classifyBootFailure(result.tail);
            const next = nextLoaderBuild(loaderPlan, loaderEscalations, failure);
            if (next) {
              loaderEscalations += 1;
              logEscalation(loaderPlan.candidates[loaderEscalations - 1] ?? '?', next.build, next.rule, loaderEscalations - 1, loaderPlan.maxEscalations);
              report.warnings.push(`loader build escalated to ${next.build} after a loader-level boot failure (${next.rule})`);
              await installLoader(
                held.loader.kind as never, stagingDir, held.loader.minecraftVersion, next.build, javaPath ?? 'java', this.cacheDir(),
              );
              // The loader artifact name derives from its build (e.g. forge-1.12.2-<build>.jar), so the launch
              // shape computed before the reinstall now points at a file that is gone. Re-resolve it.
              let retryLaunch = launch;
              try {
                retryLaunch = validateStagedInstall({ stagingDir, loaderKind: held.loader.kind as never, log: () => {} });
              } catch (error) {
                log(`[loader] could not re-resolve launch shape after escalation: ${(error as Error).message}`);
              }
              const retry = await startWithAutoFix(
                stagingDir,
                javaPath ? { exe: javaPath, args: retryLaunch.args } : retryLaunch,
                {
                  timeoutMs: 8 * 60_000,
                  maxRounds: 6,
                  ...(autoFixContext ? { l2Protect: autoFixContext.protectBasenames } : {}),
                },
              );
              autoFixFixes = [...autoFixFixes, ...retry.fixes];
              autoFixRounds += retry.rounds;
              if (retry.ok) return { ok: true, reason: retry.reason, tail: retry.tail };
              return { ok: false, reason: `${retry.reason} (after loader build ${next.build})`, tail: retry.tail };
            }
            if (!result.ok) {
              report.warnings.push(`loader build not escalated: ${explainNoEscalation(loaderPlan, failure)}`);
            }
          }
          return { ok: result.ok, reason: result.reason, tail: result.tail };
        },
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
            // Re-derive the plan with the user's actual choices: held decisions were captured at
            // preview time, before optional Exclude/conflict resolutions existed.
            const resolvedDecisions = held.fileDecisions.map(decision => {
              const choice = choices.files[decision.path];
              return choice ? { ...decision, action: choice, reason: 'userChoice' as const } : decision;
            });
            const excludedPaths = new Set(
              resolvedDecisions
                // Server-unsupported files already skip through the curated policy; only explicit
                // plan/user exclusions (optional Exclude, resolved conflicts) are passed as choices.
                .filter(d => d.action === 'exclude' && d.reason !== 'serverUnsupported')
                .map(d => d.path),
            );
            const includeFiles = resolveIncludedPaths(resolvedDecisions, choices.files);
            // Belt-and-braces: an explicit plan Exclude must never reach the engine include set.
            for (const path of excludedPaths) includeFiles.delete(path);
            const res = await installModrinth({
              mrpackPath: held.mrpackPath, index: held.index, slug: held.slug ?? null,
              dir: stagingDir, cacheDir: this.cacheDir(), dataRoot: this.ctx.dataRoot,
              onProgress,
              signal,
              // WP-4.6: only explicit/optional-default files are user-approved; curated exclusions
              // stay excluded unless the reviewed plan explicitly chose Include for that exact file.
              includeFiles,
              excludeFiles: excludedPaths,
            });
            report.files.push({ path: `${res.installed} files`, outcome: 'installed' });
            report.files.push({ path: `${res.skippedOptional} optional`, outcome: 'skipped-optional' });
            report.files.push({ path: `${res.skippedUnsupported} unsupported`, outcome: 'skipped-server-unsupported' });
            if (res.skippedUserExcluded > 0) report.files.push({ path: `${res.skippedUserExcluded} plan-excluded`, outcome: 'skipped-user-choice' });
            report.warnings.push(...res.warnings);
            report.stages.push({ stage: 'download', outcome: 'complete' });
            autoFixContext = {
              platform: 'modrinth',
              mc: held.loader.minecraftVersion,
              loader: held.loader.kind,
              protectBasenames: makeCuratedResolver({
                platform: 'modrinth', packSlug: held.slug,
                presentPaths: held.index.files.map(file => file.path),
                learnedFile: this.learnedOverridesPath(),
              }).protectBasenames,
              fetchDependency: (modId) => fetchModrinthDependency({
                mc: held.loader.minecraftVersion,
                loader: held.loader.kind,
                modId,
                modsDir: path.join(stagingDir, 'mods'),
                signal,
              }),
            };
            sidecarData = {
              platform: 'modrinth', slug: held.slug,
              // gap9: record hashes/sizes, not just paths, so a reinstall can DIFF against this manifest instead
              // of re-downloading everything blind. `PlannedFile` already carried sha1/sha512/size; the sidecar
              // simply never wrote them, which is why research Â§7 gap 9 was invisible â€” the data was there.
              files: held.index.files.map(file => ({
                path: file.path,
                side: file.env?.server ?? null,
                // A .mrpack index declares a `hashes` record (sha1/sha512/murmur2 as present) and `fileSize`.
                sha1: file.hashes.sha1 ?? null,
                sha512: file.hashes.sha512 ?? null,
                size: file.fileSize ?? null,
              })),
              loader: held.loader.kind, mc: held.loader.minecraftVersion,
            };
          } else if (held.recipe) {
            // ---- P1b: install from the canonical recipe produced by a pack adapter ----
            // Loader-build policy: a declared build is authoritative; otherwise resolve the provider's
            // recommended/latest builds so a loader-level boot failure can escalate once, within budget.
            if ((held.recipe.loader === 'forge' || held.recipe.loader === 'neoforge')) {
              const promotions = await this.fetchPromotions(held.recipe.loader, signal);
              loaderPlan = planLoaderBuilds({
                loader: held.recipe.loader,
                mc: held.recipe.mc,
                declaredVersion: held.recipe.loaderVersion,
                promotions,
              });
              log(`[loader] ${held.recipe.loader} ${held.recipe.mc}: ${loaderPlan.declared
                ? `using declared build ${loaderPlan.candidates[0]}`
                : `no declared build; candidates ${loaderPlan.candidates.join(' -> ')} (source: ${loaderPlan.source})`}`);
              if (!loaderPlan.declared) {
                report.warnings.push(
                  `the pack does not declare a ${held.recipe.loader} build; using ${loaderPlan.candidates[0]} (${loaderPlan.source})`,
                );
              }
              // The primary candidate is what actually gets installed, so pin it on the recipe.
              if (!held.recipe.loaderVersion) held.recipe.loaderVersion = loaderPlan.candidates[0]!;
            }
            const resolvedDecisions = held.fileDecisions.map(decision => {
              const choice = choices.files[decision.path];
              return choice ? { ...decision, action: choice, reason: 'userChoice' as const } : decision;
            });
            const excludeFiles = new Set(
              resolvedDecisions.filter(d => d.action === 'exclude').map(d => d.path),
            );
            const includeFiles = new Set(
              resolvedDecisions
                .filter(d => d.action === 'include' && (d.reason === 'userChoice' || d.reason === 'optionalDefaultKeep'))
                .map(d => d.path),
            );
            const res = await installRecipe({
              recipe: held.recipe,
              dir: stagingDir,
              javaExe: input.javaPath?.trim() || 'java',
              cacheDir: this.cacheDir(),
              excludeFiles,
              includeFiles,
              // Formats like packwiz/Prism/ATLauncher ship payload inside the archive instead of a download
              // list; the recipe's override layers can only be applied with the archive in hand.
              ...(held.artifactPath && held.source.kind === 'packArchive' ? { archivePath: held.artifactPath } : {}),
              onProgress,
              ...(signal ? { signal } : {}),
            });
            report.files.push({ path: `${res.installed} files`, outcome: 'installed' });
            if (res.skippedUnsupported > 0) report.files.push({ path: `${res.skippedUnsupported} client-only`, outcome: 'skipped-client-only' });
            if (res.skippedOptional > 0) report.files.push({ path: `${res.skippedOptional} optional`, outcome: 'skipped-optional' });
            if (res.skippedUserExcluded > 0) report.files.push({ path: `${res.skippedUserExcluded} plan-excluded`, outcome: 'skipped-user-choice' });
            report.warnings.push(...res.warnings);
            report.stages.push({ stage: 'download', outcome: 'complete' });

            // The recipe declares the loader exactly, so record it before publish.
            const loaderName = LOADER_DTO[held.recipe.loader] ?? held.recipe.loader;
            installInput.loader = loaderName;
            installInput.mcVersion = held.recipe.mc;
            if (held.recipe.loaderVersion) installInput.loaderVersion = held.recipe.loaderVersion;
            report.loader = {
              kind: REPORT_LOADER_KIND[held.recipe.loader] ?? held.recipe.loader,
              minecraftVersion: held.recipe.mc,
              loaderVersion: held.recipe.loaderVersion,
            };

            // Keep the L2/L3 defense active for adapter installs too: a pack that lies about sidedness
            // must still be caught by the jar scan and the boot-decides auto-fix loop.
            autoFixContext = {
              platform: held.recipe.formatId.startsWith('curseforge') ? 'curseforge' : 'modrinth',
              mc: held.recipe.mc,
              loader: held.recipe.loader,
              protectBasenames: makeCuratedResolver({
                platform: held.recipe.formatId.startsWith('curseforge') ? 'curseforge' : 'modrinth',
                packSlug: null,
                presentPaths: held.recipe.files.map(file => file.path),
                learnedFile: this.learnedOverridesPath(),
              }).protectBasenames,
              fetchDependency: null,
            };
            sidecarData = {
              platform: held.recipe.formatId,
              // gap9: same as the modrinth branch â€” a diffable manifest, not a bare path list.
              files: held.recipe.files.map(file => ({
                path: file.path,
                side: file.side,
                sha1: file.sha1 ?? null,
                sha512: file.sha512 ?? null,
                size: file.size ?? null,
              })),
              loader: held.recipe.loader,
              mc: held.recipe.mc,
            };
          } else if (held.zipPath || held.source.kind === 'curseForgeServerZip' || held.source.kind === 'curseforgeProject') {
            const zipPath = held.zipPath ?? (held.source.kind === 'curseForgeServerZip'
              ? path.join(this.ctx.dataRoot, 'curseforge-import', held.source.zipName)
              : undefined);
            const projectId = held.source.kind === 'curseforgeProject' ? Number(held.source.projectId) : undefined;
            const res = await installCurseforge({
              zipPath, projectId, dir: stagingDir, dataRoot: this.ctx.dataRoot, cacheDir: this.cacheDir(), onProgress, signal,
              // The preview already resolved exact metadata (API key mode / archive inference); hand it
              // to the engine so a bare ServerPackCreator archive is not rejected for lacking its own.
              knownLoader: (held.loader.kind || null) as never,
              knownMc: held.loader.minecraftVersion || null,
              knownLoaderVersion: held.loader.loaderVersion ?? null,
            });
            // WP-4.5: never publish blank route-A/B metadata; prefer the engine's inferred values.
            const inferred = this.applyCurseForgeMetadata(held, res, installInput, report);
            // Route A prebuilt packs ship mods *inside the archive*, so the engine's manifest counters
            // are 0/0 even though the tree is full. Report the tree that actually exists instead of
            // publishing "0 mods" next to 300+ jars (misleading audit record).
            const shippedJars = Pipeline.stagedJarCount(stagingDir);
            report.files.push({
              path: res.installed > 0 ? `${res.installed} mods` : `${shippedJars} mods (bundled in pack)`,
              outcome: 'installed',
            });
            report.files.push({ path: `${res.skippedClientOnly} client-only`, outcome: 'skipped-client-only' });
            if (res.skippedOptional > 0) report.files.push({ path: `${res.skippedOptional} optional`, outcome: 'skipped-optional' });
            report.warnings.push(...res.warnings);
            for (const m of res.manuallyRequired) report.warnings.push(`manually required: ${m.pageUrl} (${m.reason})`);
            report.stages.push({ stage: `route-${res.route}`, outcome: 'complete' });
            // CurseForge dependency fetch is prune-only (D9): the L3 loop may disable attributed
            // jars but must not pull arbitrary Modrinth projects into a CF pack.
            autoFixContext = {
              platform: 'curseforge',
              mc: inferred.mc,
              loader: inferred.loader,
              protectBasenames: new Set<string>(),
              fetchDependency: null,
            };
            sidecarData = {
              platform: 'curseforge', slug: projectId ? String(projectId) : null,
              // gap9: a CF author server pack has no per-file manifest to plan from (the archive IS the payload),
              // so a per-file hash list cannot be fabricated at plan time. What CAN be recorded â€” and is what a
              // reinstall actually needs to diff â€” is the archive's own identity plus the provider coords.
              files: [],
              archive: zipPath && fs.existsSync(zipPath)
                ? {
                  size: fs.statSync(zipPath).size,
                  sha256: createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex'),
                }
                : null,
              provider: projectId ? { kind: 'curseforge', projectId: Number(projectId) } : null,
              loader: inferred.loader, mc: inferred.mc,
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
          if (javaExe && input.eulaAccepted === true) {
            // D9: report the L3 loop's outcome, including every jar it had to change.
            for (const fix of autoFixFixes) {
              report.files.push({
                path: `mods/${fix.jar ?? fix.mod}`,
                outcome: fix.action === 'disabled' ? 'disabled-by-autofix' : 'added-by-autofix',
                detail: `round ${fix.round}: ${fix.action} ${fix.mod}`,
              });
            }
            if (autoFixFixes.length > 0) {
              report.warnings.push(`auto-fix applied ${autoFixFixes.length} change(s) across ${autoFixRounds} boot round(s) before verification passed`);
              // Learn disabled jars globally (SPC `-clientsideapply`): future packs skip the crash.
              try {
                appendLearned(
                  autoFixFixes
                    .filter(fix => fix.action === 'disabled')
                    .map(fix => ({ match: fix.mod, why: `auto: ${held.sourceName} crashed with this mod loaded (${fix.jar ?? 'unknown jar'})` })),
                  path.join(this.ctx.dataRoot, 'state', 'env-overrides-learned.json'),
                );
              } catch (error) {
                log(`[autofix] could not persist learned entries: ${(error as Error).message}`);
              }
            }
            report.stages.push({
              stage: 'verify-boot',
              outcome: 'complete',
              detail: autoFixFixes.length > 0 ? `${autoFixFixes.length} auto-fix(es) in ${autoFixRounds} round(s)` : 'first boot',
            });
          }
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
      return this.finalizeFailure(status, report, message, { fixes: autoFixFixes, rounds: autoFixRounds });
    }
  }

  /** WP-4.6: re-derive decisions with the user's explicit choices; unresolved contradictions stop. */
  private assertResolvedFileChoices(held: HeldPreview, choices: PipelineInstallChoices): void {
    if (!held.index) return;
    const curated = makeCuratedResolver({ platform: 'modrinth', packSlug: held.slug, presentPaths: held.index.files.map(file => file.path), learnedFile: this.learnedOverridesPath() });
    const unresolved: string[] = [];
    for (const file of held.index.files) {
      const verdict = curated.resolve(file.path, file.env?.server ?? 'required');
      const mapped = mapFilePolicy({
        path: file.path,
        serverEnv: file.env?.server ?? null,
        clientEnv: file.env?.client ?? null,
        curated: verdict,
        curatedProtect: verdict.protect,
        choice: choices.files[file.path] ?? null,
      });
      if (mapped.decision.action === 'awaitingUserChoice') unresolved.push(file.path);
    }
    if (unresolved.length > 0) {
      const shown = unresolved.slice(0, 5).join(', ');
      throw appError('validation',
        `${unresolved.length} file(s) have conflicting server/client signals; choose Include or Exclude before installing (${shown}${unresolved.length > 5 ? ', ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦' : ''}).`);
    }
  }

  /** WP-4.8/WP-4.5: Quilt policy and CurseForge exact-metadata preconditions, before mutation. */
  private assertInstallableSource(held: HeldPreview): void {
    if (held.source.kind === 'curseForgeServerZip' || held.source.kind === 'curseforgeProject') {
      this.assertCurseForgeMetadata(held.loader.kind, held.loader.minecraftVersion);
      return;
    }
    if (held.recipe) {
      // A recipe already passed `validateRecipe` (exact MC, safe paths, resolvable sources) at preview.
      // This adds the install-time policy gate that applies to every source kind.
      if (!held.recipe.mc.trim() || !held.recipe.loader.trim()) {
        throw appError('validation',
          `The ${held.recipe.formatId} adapter did not resolve an exact Minecraft version and loader, so the pack `
          + 'cannot be installed safely. Blank metadata is never published.');
      }
      assertSupportedNewInstallLoader(held.recipe.loader);
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

  /**
   * Fetch the loader's own recommended/latest build feed for one Minecraft version.
   * Returns null when no trustworthy feed exists or it is unreachable ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â an unreachable feed must never block
   * an install that declares its build, and inventing candidates would be a guess.
   *
   * Forge publishes `promotions_slim.json` with explicit `recommended`/`latest` per MC line, which is exactly
   * the answer needed. NeoForge publishes only a flat version list with no MC-line mapping, so it has no
   * equivalent: we return null and NeoForge packs simply require a declared build.
   */
  private async fetchPromotions(loader: string, signal?: AbortSignal): Promise<{ promos?: Record<string, string> } | null> {
    if (loader !== 'forge') {
      log(`[loader] ${loader} has no recommended/latest promotion feed; a declared build is required`);
      return null;
    }
    try {
      const response = await fetchTrusted(
        'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
        LOADER_ALLOWED_HOSTS,
        signal ? { signal } : {},
      );
      if (!response.ok) {
        log(`[loader] forge promotions feed returned HTTP ${response.status}; not escalating`);
        return null;
      }
      return await response.json() as { promos?: Record<string, string> };
    } catch (error) {
      log(`[loader] forge promotions feed unavailable: ${(error as Error).message}`);
      return null;
    }
  }

  /** WP-4.5: reject when the reviewed archive no longer matches the preview snapshot. */
  private async assertNoSourceDrift(held: HeldPreview): Promise<void> {    const expected = held.sourcePin.artifact;
    if (!expected || !held.artifactPath) return;
    const reason = await artifactDriftReason(held.artifactPath, expected);
    if (reason) {
      throw appError('validation', `${reason}. Review the pack again so the install matches exactly what was approved.`);
    }
  }

  /** Terminal failure/cancel result: the transaction has already removed staging and any record. */
  private finalizeFailure(
    status: 'failed' | 'cancelled',
    report: PipelineInstallReport,
    error: string | null,
    autoFix?: { fixes: AutoFixEntry[]; rounds: number },
  ): PipelineInstallResult {
    report.status = status;
    // A failed verification must still say what the auto-fix loop tried: otherwise an intermittent
    // boot crash (seen on SkyFactory 5) leaves an unattributable "did not reach Done (" with nothing
    // recorded about the rounds that already ran and the jars they moved.
    const fixes = autoFix?.fixes ?? [];
    const rounds = autoFix?.rounds ?? 0;
    if (fixes.length > 0 || rounds > 0) {
      for (const fix of fixes) {
        report.files.push({
          path: `mods/${fix.jar ?? fix.mod}`,
          outcome: fix.action === 'disabled' ? 'disabled-by-autofix' : 'added-by-autofix',
          detail: `round ${fix.round}: ${fix.action} ${fix.mod}`,
        });
      }
      report.stages.push({
        stage: 'verify-boot',
        outcome: 'failed',
        detail: `${fixes.length} auto-fix(es) in ${rounds} round(s) before giving up`,
      });
    }
    if (error) report.errors.push(error);
    log(`[pipeline] ${status}${error ? `: ${error}` : ''}`);
    return { status, server: null, report, error };
  }

  /** Count the `.jar` files a staged install actually produced (archive-bundled mods are not counted
   *  by the engine's manifest loop). Best effort: a read failure reports 0 rather than failing a build. */
  private static stagedJarCount(dir: string): number {
    try {
      return fs.readdirSync(path.join(dir, 'mods')).filter(name => /\.jar$/i.test(name)).length;
    } catch {
      return 0;
    }
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







