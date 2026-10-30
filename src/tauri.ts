// Backend adapter (Electron | framework-neutral HTTP | explicit dev mocks).
// The dormant Tauri runtime is no longer part of the shipped renderer (ADR-0020): Electron is the
// sole desktop host; browser builds require a configured HTTP backend or the explicit mock flag.
import { getBackendConfigError, isHttpBackendConfigured } from './backend/config';
import { invokeHttp, subscribeHttp, uploadHttp } from './backend/http';

export type UnlistenFn = () => void;

interface ElectronApi {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  on(channel: string, cb: (payload: unknown) => void): () => void;
}
declare global {
  interface Window { electronAPI?: ElectronApi }
}

export function isElectronHost(): boolean {
  // The Electron renderer UA always contains "Electron/<version>", even when the preload failed
  // to expose window.electronAPI. Used to distinguish "desktop bridge missing" from a browser.
  return typeof navigator !== 'undefined' && /\bElectron\//.test(navigator.userAgent);
}

export function isElectron(): boolean {
  return isElectronHost() && typeof window !== 'undefined' && window.electronAPI !== undefined;
}

/** Mock data is a dev-only, explicit opt-in (`VITE_MOCK_BACKEND=1 npm run dev:web`), never implicit. */
export function mockBackendEnabled(): boolean {
  return import.meta.env.DEV && import.meta.env.VITE_MOCK_BACKEND === '1';
}

/** Electron invoke with the {code,message} JSON-in-message error contract rebuilt as AppError. */
async function invokeElectron<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return (await window.electronAPI!.invoke(command, args)) as T;
  } catch (err) {
    try {
      const parsed = JSON.parse(err instanceof Error ? err.message : String(err)) as { code?: string; message?: string };
      throw Object.assign(new Error(parsed.message ?? 'Backend error.'), { code: parsed.code ?? 'internal' });
    } catch (e) {
      if (e instanceof Error && 'code' in e) throw e;
      throw err;
    }
  }
}

/** True only for the Electron desktop host: native pickers instead of browser uploads. */
export function isDesktop(): boolean {
  return isElectron();
}

export type BackendHost = 'electron' | 'http' | 'browser';

export interface BackendEnvironment {
  host: BackendHost;
  /** False only for a desktop host whose preload bridge is missing (packaged-app failure). */
  bridgeAvailable: boolean;
  /** Human-readable explanation when the app must fail closed instead of using browser mocks. */
  unavailableReason: string | null;
}

/**
 * Classify the runtime the renderer is embedded in. A missing Electron preload must be detected
 * from the host UA: without it the app would otherwise silently fall back to browser mock data.
 */
export function backendEnvironment(): BackendEnvironment {
  if (isElectronHost()) {
    const bridgeAvailable = typeof window !== 'undefined' && window.electronAPI !== undefined;
    return {
      host: 'electron',
      bridgeAvailable,
      unavailableReason: bridgeAvailable
        ? null
        : 'The Electron preload bridge (window.electronAPI) is unavailable, so this window cannot reach the server backend. '
          + 'This usually means preload.js failed to load or the app build is incomplete. Restart the app; if it persists, reinstall. '
          + 'Browser mock data is disabled while running inside Electron.',
    };
  }
  if (isHttpBackendConfigured()) return { host: 'http', bridgeAvailable: true, unavailableReason: null };
  return { host: 'browser', bridgeAvailable: false, unavailableReason: null };
}

/** Non-null only when a desktop host is missing its preload bridge (F-11 fail-closed state). */
export function backendUnavailableReason(): string | null {
  return backendEnvironment().unavailableReason;
}

/** True when a desktop host (Electron) or a runtime-configured HTTP backend is available. */
export function hasBackend(): boolean {
  return isElectron() || isHttpBackendConfigured();
}

function noBackendError(command: string): Error {
  const configError = getBackendConfigError();
  return new Error(configError ?? `Backend command "${command}" requires the Electron desktop app or a backend-config.json HTTP backend.`);
}

export async function stubInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!mockBackendEnabled()) throw noBackendError(command);
  // eslint-disable-next-line no-console
  console.debug(`[mock-backend] invoke "${command}"`, args ?? {});
  return null;
}

/** Toastable backend error shape `{code, message}` (Rust AppError). */
export interface AppError {
  code: 'validation' | 'not-found' | 'conflict' | 'io' | 'db' | 'internal' | string;
  message: string;
}

/** Error codes that add no diagnostic value to a user-facing toast. */
const TRIVIAL_ERROR_CODES: ReadonlySet<string> = new Set([
  '', 'unknown', 'error', 'internal', 'backend-error', 'http-error', 'invalid-response',
]);

export interface NormalizedError {
  code: string;
  message: string;
  /** `[code] message` for informative codes, plain `message` otherwise. */
  display: string;
  informative: boolean;
}

export function isInformativeErrorCode(code: string | null | undefined): boolean {
  return code !== null && code !== undefined && !TRIVIAL_ERROR_CODES.has(code.toLowerCase());
}

/**
 * Single source of truth for turning an `unknown` rejection into the `{code,message}` contract.
 * Backend paths (Electron/Tauri/HTTP) preserve the AppError code; plain Errors get `unknown`.
 */
export function normalizeError(error: unknown, fallback = 'Backend request failed.'): NormalizedError {
  let code = 'unknown';
  let message = fallback;
  if (typeof error === 'string') {
    if (error.trim() !== '') message = error.trim();
  } else if (error instanceof Error) {
    if (error.message.trim() !== '') message = error.message;
    const candidate = (error as Error & { code?: unknown }).code;
    if (typeof candidate === 'string' && candidate.trim() !== '') code = candidate;
  } else if (error !== null && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown };
    if (typeof candidate.message === 'string' && candidate.message.trim() !== '') message = candidate.message;
    if (typeof candidate.code === 'string' && candidate.code.trim() !== '') code = candidate.code;
  }
  const informative = isInformativeErrorCode(code);
  return { code, message, informative, display: informative ? `[${code}] ${message}` : message };
}

/** Toast-friendly text that keeps `[code]` for actionable backend errors (F-19). */
export function formatErrorText(error: unknown, fallback = 'Backend request failed.'): string {
  return normalizeError(error, fallback).display;
}

export function appErrorMessage(error: unknown, fallback = 'Backend request failed.'): string {
  return normalizeError(error, fallback).message;
}

export function appErrorCode(error: unknown): string {
  return normalizeError(error).code;
}

/**
 * Monotonic "latest request wins" guard for tab loaders/search callbacks. Each `begin()` aborts the
 * previous lease; callers check `lease.isCurrent()` before committing state. No backend IPC call is
 * cancelled (the contract has no cancel), the stale response is simply ignored.
 */
export interface LatestRequestLease {
  readonly id: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

export interface LatestRequestController {
  begin(): LatestRequestLease;
  cancel(): void;
}

export function createLatestRequest(): LatestRequestController {
  let current = 0;
  let controller: AbortController | null = null;
  return {
    begin(): LatestRequestLease {
      current += 1;
      const id = current;
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      return { id, signal, isCurrent: () => current === id && !signal.aborted };
    },
    cancel(): void {
      current += 1;
      controller?.abort();
      controller = null;
    },
  };
}

/** Server row DTO (Rust ServerRecord, camelCase). */
export interface ServerDto {
  id: string;
  name: string;
  loader: string;
  mcVersion: string;
  loaderVersion?: string | null;
  modpackId?: string | null;
  port: number;
  ramMb: number;
  javaPath?: string | null;
  eulaAccepted: boolean;
  status: string;
  createdAt: string;
  motd?: string;
  maxPlayers?: number;
  difficulty?: string;
  gamemode?: string;
  onlineMode?: boolean;
  worldName?: string;
}

export interface ServerPropertyEntryDto {
  key: string;
  value: string;
  known: boolean;
  kind: 'int' | 'bool' | 'enum' | 'string';
  options?: string[];
  min?: number;
  max?: number;
}

export interface ServerSettingsDto {
  serverId: string;
  status: string;
  live: boolean;
  eulaAccepted: boolean;
  values: Record<string, string>;
  entries: ServerPropertyEntryDto[];
}

export interface PlayerDto {
  uuid: string;
  name: string;
  online: boolean;
  op: boolean;
  whitelisted: boolean;
  banned: boolean;
  lastSeen: string;
  playtimeHrs: number;
  gamemode: string;
}

export interface PlayerListDto {
  players: PlayerDto[];
  running: boolean;
  maxPlayers: number;
}

export interface WorldDto {
  name: string;
  sizeBytes: number;
  lastModified: string;
  active: boolean;
  pending?: boolean;
  /** Additive: parsed from level.dat (null when unreadable/not generated yet). */
  seed?: string | null;
  /** Additive: corrupt level.dat / scan warning. */
  warning?: string | null;
}

export type BackupKindDto = 'Manual' | 'Auto' | 'Pre-install' | 'Pre-restore' | 'World-delete';

export interface BackupDto {
  id: string;
  serverId: string;
  name: string;
  path: string;
  bytes: number;
  kind: BackupKindDto;
  note: string;
  createdAt: string;
}

export interface BackupScheduleDto {
  auto: boolean;
  interval: 'Hourly' | 'Daily' | 'Weekly';
  maxKept: number;
  lastRunAt: string | null;
}

export interface MetricsEventDto {
  id: string;
  cpuPct: number | null;
  memoryMb: number | null;
  ramPct: number | null;
  uptimeSec: number;
  playersOnline: number | null;
  maxPlayers: number | null;
  tps: number | null;
  mspt: number | null;
  at: string;
}

export interface MetricsBucketDto {
  at: string;
  cpuPct: number | null;
  memoryMb: number | null;
  ramPct: number | null;
  players: number | null;
  tps: number | null;
  mspt: number | null;
}

export interface MetricsHistoryDto {
  samples: MetricsBucketDto[];
  disk: { freeBytes: number; totalBytes: number };
  current: MetricsBucketDto | null;
}

export interface ContentItemDto {
  fileName: string;
  enabled: boolean;
  sizeBytes: number;
  kind: 'mod' | 'plugin';
  title?: string | null;
  projectId?: string | null;
  versionId?: string | null;
  versionNumber?: string | null;
}

export interface ContentSearchHitDto {
  id: string;
  slug: string;
  name: string;
  author: string;
  downloads: number;
  iconUrl: string | null;
  summary: string;
  versions: string[];
  loaders: string[];
}

export interface ContentVersionDto {
  id: string;
  name: string;
  versionNumber: string;
  gameVersions: string[];
  loaders: string[];
  downloads: number;
  fileName: string;
  fileSize: number;
  dependencies: { projectId: string | null; versionId: string | null; type: string }[];
}

/** Create input (Rust CreateServerInput). `port` omitted/0 = auto 25565+. */
export interface CreateServerInput {
  name: string;
  loader: string;
  mcVersion: string;
  loaderVersion?: string;
  modpackId?: string;
  port?: number;
  ramMb: number;
  javaPath?: string;
  eulaAccepted?: boolean;
}

export interface JavaCandidate {
  path: string;
  major: number;
  architectureBits: number;
  source: string;
}

export interface JavaDetection {
  mcVersion: string;
  requiredMajor: number;
  installMajor: number;
  candidates: JavaCandidate[];
}

export interface MinecraftVersionDto {
  id: string;
  releaseTime: string;
  versionType: string;
  /** Additive: Paper build status/support metadata when present. */
  support?: string | null;
}

export interface LoaderChoiceDto {
  loader: 'Vanilla' | 'Paper' | 'Fabric' | 'Forge' | 'NeoForge';
  version: string | null;
  label: string;
  stable?: boolean | null;
}

export type ModrinthSearchIndex = 'relevance' | 'downloads' | 'follows' | 'newest' | 'updated';

export interface ModrinthModpackDto {
  id: string;
  name: string;
  author: string;
  downloads: number;
  gameVersions: string[];
  loaders: string[];
  iconUrl: string | null;
  summary: string;
}

export interface ModrinthSearchResponseDto {
  results: ModrinthModpackDto[];
  offset: number;
  limit: number;
  totalHits: number;
}

export interface ModrinthProjectVersionFileDto {
  url: string;
  filename: string;
  size: number;
  primary: boolean;
  hashes: {
    sha1: string;
    sha512: string;
  };
}

export interface ModrinthProjectVersionDto {
  id: string;
  name: string;
  versionNumber: string;
  gameVersions: string[];
  loaders: string[];
  changelog: string;
  files: ModrinthProjectVersionFileDto[];
}

export type ModrinthInstallLoader = 'minecraft' | 'fabric' | 'forge' | 'neoforge';

export type PipelineLoaderKind = 'vanilla' | 'fabric' | 'forge' | 'neoForge' | 'quilt';

export interface PipelineLoaderPin {
  kind: PipelineLoaderKind;
  minecraftVersion: string;
  loaderVersion: string | null;
}

export type PipelineFileAction = 'include' | 'exclude' | 'awaitingUserChoice';
export type PipelineFileChoice = 'include' | 'exclude';
export type PipelineFileSide = 'server' | 'client' | 'both';

export interface PipelineFileDecision {
  path: string;
  side: PipelineFileSide | null;
  action: PipelineFileAction;
  reason:
    | 'required'
    | 'optionalDefaultKeep'
    | 'userChoice'
    | 'serverUnsupported'
    | 'missingEnvironmentRetained'
    | 'conflictingSignals';
}

export interface PipelineInstallTarget {
  serverId: string;
  serverName: string;
  directory: string;
}

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
  plan: PipelineInstallPlan;
  warnings: string[];
  /** Evidence grade of the detected format; null when the source has no adapter recipe. */
  evidence: {
    grade: string;
    note: string;
    formatId: string;
    /** DV-44: false when the recipe plans no files of its own (launcher-instance formats). */
    selfContained: boolean;
    plannedFileCount: number;
  } | null;
}

export interface LocalMrpackSelection {
  sourceId: string;
  fileName: string;
}

export type PipelineSourceRequest =
  | {
      kind: 'modrinthRemote';
      projectId: string;
      versionId: string;
      loader: PipelineLoaderPin;
      javaPath: string;
    }
  | { kind: 'localMrpack'; sourceId: string }
  | { kind: 'curseForgeServerZip'; zipName: string }
  /**
   * A CurseForge project, optionally pinned to one published file.
   *
   * `fileId` carries the user's version choice from the picker. Without it the engine resolves "newest", which is wrong
   * whenever the newest file has no server pack but an older one does.
   */
  | { kind: 'curseforgeProject'; projectId: number; fileId?: number };

export interface CurseForgeProjectMetaDto {
  projectId: number;
  name: string;
  minecraftVersion: string | null;
  loader: string | null;
  loaderVersion: string | null;
  hasServerPack: boolean;
}

/** One published version of a CurseForge project, as returned by curseforge_project_versions. */
export interface CurseForgeProjectVersionDto {
  fileId: number;
  displayName: string;
  fileName: string | null;
  publishedAt: string | null;
  minecraftVersion: string | null;
  loader: string | null;
  /** True when a server pack is published for this exact version — the preferred download for a server. */
  hasServerPack: boolean;
  serverPackFileId: number | null;
  fileLength: number | null;
}

export type CurseForgeModpackSort = 'popularity' | 'recent' | 'name' | 'downloads';

export interface CurseForgeModpackHit {
  projectId: number;
  name: string;
  slug: string;
  summary: string;
  author: string | null;
  downloads: number;
  updatedAt: string | null;
  iconUrl: string | null;
  websiteUrl: string | null;
}

export interface CurseForgeModpackSearchResult {
  hits: CurseForgeModpackHit[];
  totalHits: number;
  offset: number;
  limit: number;
}

export interface PipelineCreateInput {
  name: string;
  port?: number;
  ramMb: number;
  javaPath?: string;
  eulaAccepted?: boolean;
}

export interface PipelineInstallChoices {
  files: Record<string, PipelineFileChoice>;
  approvedReplacements: string[];
  autoDeleteCurseForgeZip: boolean;
}

export interface PipelineInstallReportFile {
  path: string;
  outcome: string;
  sizeBytes?: number | null;
  hashes?: { sha1: string; sha512: string } | null;
  sourceHost?: string | null;
  detail?: string | null;
}

export interface PipelineInstallReport {
  schemaVersion: number;
  planId: string;
  serverId: string;
  createdAt: string;
  status: 'preparing' | 'complete' | 'failed' | 'cancelled';
  sourcePin: unknown;
  loader: PipelineLoaderPin;
  files: PipelineInstallReportFile[];
  stages: { stage: string; outcome: string; detail?: string | null }[];
  warnings: string[];
  errors: string[];
}

export interface PipelineInstallResult {
  status: 'complete' | 'failed' | 'cancelled';
  server: ServerDto | null;
  report: PipelineInstallReport;
  error: string | null;
}

export interface JobProgressPayload {
  progress: number;
  stage?: string;
  log?: string;
  bytesDownloaded?: number;
  bytesTotal?: number;
}

export interface CurseForgeStagedZip {
  name: string;
  size: number;
  modifiedAt: number | null;
}

export type CurseForgeArchiveClassification =
  | 'supportedServerPack'
  | 'clientExport'
  | 'unsupported';

export interface CurseForgeArchiveInspection {
  name: string;
  classification: CurseForgeArchiveClassification;
  reason: string;
  minecraftVersion: string | null;
  loader: string | null;
  loaderVersion: string | null;
}

export interface CurseForgeDownloadUpdate {
  id: string;
  name: string;
  status: 'starting' | 'downloading' | 'canceling' | 'completed' | 'cancelled' | 'failed';
  bytesReceived: number;
  totalBytes: number | null;
  message: string;
}

async function invokeOrStub<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!hasBackend()) return stubInvoke<T>(command, args);
  if (isElectron()) return invokeElectron<T>(command, args);
  return invokeHttp<T>(command, args);
}

// Backend AppError ({code, message}) rejects propagate to the store (toastable); only the explicit
// dev mock mode returns null, so a broken backend can never masquerade as mock data.
async function invokeStrict<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!hasBackend()) return stubInvoke<T>(command, args);
  if (isElectron()) return invokeElectron<T>(command, args);
  return invokeHttp<T>(command, args);
}

/** Strict backend calls never stub or swallow failures when a backend is configured. */
async function invokeRequired<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!hasBackend()) {
    if (mockBackendEnabled()) {
      await stubInvoke(command, args);
      return undefined as T;
    }
    throw noBackendError(command);
  }
  if (isElectron()) return invokeElectron<T>(command, args);
  return invokeHttp<T>(command, args);
}

/** Phase 0 smoke command: UI→Rust→UI round-trip (`ping` → `"pong"`). */
export function ping(): Promise<string | null> {
  return invokeOrStub<string>('ping');
}

// backend-wired: persisted server records used by the Tauri store. Browser
// mode continues to use its in-memory mock records.
export const tauriServers = {
  list: () => invokeRequired<ServerDto[]>('servers_list'),
  get: (id: string) => invokeOrStub<ServerDto>('server_get', { id }),
  create: (input: CreateServerInput) => invokeRequired<ServerDto>('servers_create', { input }),
  remove: (id: string) => invokeRequired<void>('servers_delete', { id }),
  logsTail: (id: string, lines = 500) => invokeRequired<string[]>('logs_tail', { id, lines }),
  commandHistory: (id: string) => invokeRequired<string[]>('server_command_history', { id }),
  setJavaPath: (id: string, path: string | null) =>
    invokeRequired<ServerDto>('servers_set_java_path', { id, path }),
  settingsGet: (id: string) => invokeRequired<ServerSettingsDto>('server_settings_get', { id }),
  settingsUpdate: (
    id: string,
    values: Record<string, string>,
    extra?: { name?: string; ramMb?: number; eulaAccepted?: boolean },
  ) => invokeRequired<ServerDto>('server_settings_update', { id, values, ...extra }),
  openFolder: (id: string, sub?: string) => invokeRequired<boolean>('server_open_folder', { id, sub }),
  portCheck: (port: number) =>
    invokeRequired<{ port: number; available: boolean; suggested: number }>('port_check', { port }),
};

export const tauriPlayers = {
  list: (id: string) => invokeRequired<PlayerListDto>('players_list', { id }),
  action: (id: string, action: string, name: string, value?: string) =>
    invokeRequired<boolean | PlayerDto>('player_action', { id, action, name, value }),
  addOffline: (id: string, name: string) =>
    invokeRequired<PlayerDto>('players_add_offline', { id, name }),
};

export const tauriWorlds = {
  list: (id: string) => invokeRequired<WorldDto[]>('worlds_list', { id }),
  activate: (id: string, name: string) =>
    invokeRequired<{ backupId: string }>('world_activate', { id, name }),
  create: (id: string, name: string, seed: string, levelType: string) =>
    invokeRequired<WorldDto>('world_create', { id, name, seed, levelType }),
  duplicate: (id: string, name: string, jobId?: string) => invokeRequired<WorldDto>('world_duplicate', { id, name, jobId }),
  remove: (id: string, name: string) => invokeRequired<boolean>('world_delete', { id, name }),
  exportWorld: (id: string, name: string, jobId?: string) =>
    invokeRequired<{ path: string } | { cancelled: true }>('world_export', { id, name, jobId }),
  importWorld: (id: string, jobId?: string) =>
    invokeRequired<{ name: string } | { cancelled: true }>('world_import', { id, jobId }),
};

export const tauriBackups = {
  list: (id: string) => invokeRequired<BackupDto[]>('backups_list', { id }),
  create: (id: string, name: string, jobId?: string, options?: { shutdownDuring?: boolean }) =>
    invokeRequired<BackupDto>('backup_create', { id, name, jobId, shutdownDuring: options?.shutdownDuring }),
  restore: (id: string, backupId: string, mode: 'in-place' | 'reset', jobId?: string) =>
    invokeRequired<boolean>('backup_restore', { id, backupId, mode, jobId }),
  remove: (backupId: string) => invokeRequired<boolean>('backup_delete', { backupId }),
  exportBackup: (backupId: string) =>
    invokeRequired<{ path: string } | { cancelled: true }>('backup_export', { backupId }),
  scheduleGet: (id: string) => invokeRequired<BackupScheduleDto>('backup_schedule_get', { id }),
  scheduleSet: (id: string, patch: Partial<BackupScheduleDto>) =>
    invokeRequired<BackupScheduleDto>('backup_schedule_set', { id, ...patch }),
};

export const tauriMetrics = {
  get: (id: string, hours = 1) => invokeRequired<MetricsHistoryDto>('metrics_get', { id, hours }),
  disk: () => invokeRequired<{ freeBytes: number; totalBytes: number }>('system_disk'),
};

export const tauriContent = {
  list: (id: string) => invokeRequired<ContentItemDto[]>('content_list', { id }),
  toggle: (id: string, fileName: string, enabled: boolean) =>
    invokeRequired<ContentItemDto[]>('content_toggle', { id, fileName, enabled }),
  remove: (id: string, fileName: string) =>
    invokeRequired<ContentItemDto[]>('content_remove', { id, fileName }),
  search: (id: string, query: string, offset: number, limit: number) =>
    invokeRequired<{ hits: ContentSearchHitDto[]; totalHits: number }>('content_search', { id, query, offset, limit }),
  versions: (id: string, projectId: string) =>
    invokeRequired<ContentVersionDto[]>('content_versions', { id, projectId }),
  install: (id: string, projectId: string, versionId: string | null, title: string | null, jobId: string) =>
    invokeRequired<{ installed: number; files: string[]; warnings: string[]; skipped: number }>('content_install', {
      id, projectId, versionId, title, jobId,
    }),
  cancel: (jobId: string) => invokeRequired<boolean>('content_install_cancel', { jobId }),
};

/** CurseForge API-key management (D11): key material never comes back to the renderer. */
export const tauriCurseForgeKey = {
  status: () => invokeRequired<{ configured: boolean; source: 'safeStorage' | 'file' | null; encrypted: boolean; hint: string }>('curseforge_key_status'),
  set: (key: string) => invokeRequired<{ source: 'safeStorage' | 'file'; encrypted: boolean }>('curseforge_key_set', { key }),
  clear: () => invokeRequired<{ cleared: boolean }>('curseforge_key_clear'),
};

export interface StorageInfoDto {
  dataRoot: string;
  downloadsPath: string | null;
  effectiveDownloadsPath: string;
  defaultDownloadsPath: string;
  isDefault: boolean;
  overrideUnavailable: boolean;
}

/** Download location (Settings → Downloads & storage): cache/archives/installers/Java zips. */
export const tauriStorage = {
  get: () => invokeRequired<StorageInfoDto>('storage_get'),
  set: (path: string | null) => invokeRequired<StorageInfoDto>('storage_set', { path }),
  pickFolder: () => invokeRequired<string | null>('storage_pick_folder'),
  openFolder: (target: 'downloads' | 'data' = 'downloads') =>
    invokeRequired<boolean>('storage_open_folder', { target }),
};

/** Diagnostics: support bundle location + recent launcher log ring (no secrets). */
export const tauriDiagnostics = {
  bundle: () => invokeRequired<{ path: string; bytes: number; entries: string[]; createdAt: string }>('diagnostics_bundle'),
  recent: (limit = 200) => invokeRequired<string[]>('diagnostics_recent', { limit }),
};

export const tauriJava = {
  detect: (mcVersion: string) => invokeRequired<JavaDetection>('java_detect', { mcVersion }),
  validate: (mcVersion: string, path: string) =>
    invokeRequired<JavaCandidate>('java_validate', { mcVersion, path }),
  ensure: (major: number, jobId: string) =>
    invokeRequired<JavaCandidate>('java_ensure', { major, jobId }),
};

export const tauriVersions = {
  vanilla: () => invokeRequired<MinecraftVersionDto[]>('versions_vanilla'),
  paper: () => invokeRequired<MinecraftVersionDto[]>('versions_paper'),
  loaders: (mcVersion: string) =>
    invokeRequired<LoaderChoiceDto[]>('loaders_resolve', { mcVersion }),
};

export const tauriModrinth = {
  searchModpacks: (
    query: string,
    gameVersion: string | null,
    loader: string | null,
    index: ModrinthSearchIndex,
    offset: number,
    limit: number,
  ) => invokeRequired<ModrinthSearchResponseDto>('modrinth_search_modpacks', {
    query,
    gameVersion,
    loader,
    index,
    offset,
    limit,
  }),
  projectVersions: (projectId: string, gameVersion: string | null, loader: string | null) =>
    invokeRequired<ModrinthProjectVersionDto[]>('modrinth_project_versions', {
      projectId,
      gameVersion,
      loader,
    }),
};

export const tauriModpackPipeline = {
  pickLocalMrpack: () =>
    invokeRequired<LocalMrpackSelection | null>('modpack_pipeline_pick_local_mrpack'),
  uploadLocalMrpack: (file: File) =>
    uploadHttp<LocalMrpackSelection>('/uploads/modrinth-local', file),
  preview: (source: PipelineSourceRequest, jobId: string) =>
    invokeRequired<PipelinePreviewDto>('modpack_pipeline_preview', { source, jobId }),
  install: (
    previewId: string,
    input: PipelineCreateInput,
    choices: PipelineInstallChoices,
    jobId: string,
  ) => invokeRequired<PipelineInstallResult>('modpack_pipeline_install', {
    previewId,
    input,
    choices,
    jobId,
  }),
  cancel: (jobId: string) =>
    invokeRequired<boolean>('modpack_pipeline_cancel', { jobId }),
  discardPreview: (previewId: string) =>
    invokeRequired<boolean>('modpack_pipeline_discard_preview', { previewId }),
  releaseLocalMrpack: (sourceId: string) =>
    invokeRequired<boolean>('modpack_pipeline_release_local_mrpack', { sourceId }),
};

export const tauriCurseForge = {
  openBrowser: () => {
    if (isElectron()) return invokeRequired<boolean>('curseforge_open_browser');
    if (mockBackendEnabled()) {
      window.open('https://www.curseforge.com/minecraft/search?class=modpacks', '_blank', 'noopener,noreferrer');
      return Promise.resolve(false);
    }
    return invokeRequired<boolean>('curseforge_open_browser');
  },
  openExternalBrowser: () => {
    if (isElectron()) return invokeRequired<void>('curseforge_open_external_browser');
    if (mockBackendEnabled()) {
      window.open('https://www.curseforge.com/minecraft/search?class=modpacks', '_blank', 'noopener,noreferrer');
      return Promise.resolve();
    }
    return invokeRequired<void>('curseforge_open_external_browser');
  },
  listZips: () => invokeRequired<CurseForgeStagedZip[]>('curseforge_list_zips'),
  pickZip: () => invokeRequired<CurseForgeStagedZip | null>('curseforge_pick_zip'),
  uploadZip: (file: File) => uploadHttp<CurseForgeStagedZip>('/uploads/curseforge-server-zip', file),
  inspectZip: (name: string) =>
    invokeRequired<CurseForgeArchiveInspection>('curseforge_inspect_zip', { name }),
  inspectProject: (project: string | number) =>
    invokeRequired<CurseForgeProjectMetaDto>('curseforge_inspect_project', { project }),
  /** In-app modpack browsing through the official API (requires a key saved in Settings). */
  searchModpacks: (query: string, options: { offset?: number; limit?: number; sort?: CurseForgeModpackSort } = {}) =>
    invokeRequired<CurseForgeModpackSearchResult>('curseforge_search_modpacks', {
      query,
      offset: options.offset ?? 0,
      limit: options.limit ?? 20,
      sort: options.sort ?? 'popularity',
    }),
  /**
   * Published versions of a project, each flagged with whether it has a server pack.
   *
   * The flag is the point: authors publish an optional server pack beside the client pack, and the two are not
   * interchangeable — a server pack is ready to run, while a client pack is a manifest whose mods must be resolved and
   * which contains client-only mods. Without this list the installer could only take "latest", which installed the wrong
   * one whenever a server pack existed for a different version than the newest file.
   */
  projectVersions: (project: string | number, limit = 30) =>
    invokeRequired<CurseForgeProjectVersionDto[]>('curseforge_project_versions', { project: String(project), limit }),
  cancelDownload: (transferId: string) =>
    invokeRequired<boolean>('curseforge_cancel_download', { transferId }),
};

export function onCurseForgeDownload(
  cb: (payload: CurseForgeDownloadUpdate) => void,
): Promise<UnlistenFn> {
  return listenOrNoop<CurseForgeDownloadUpdate>('curseforge://download', cb);
}

/**
 * Subscribe to auto-update state changes pushed from the main process.
 *
 * The main process is the only place that knows about download progress, so the panel listens rather than polling. The
 * payload shape is defined in electron/services/updater.ts and duplicated here because the renderer cannot import from
 * electron/ — the two tsconfigs have different roots, so the mirrors are kept in step by a contract test instead.
 */
export interface UpdateStatePayload {
  supported: boolean;
  unsupportedReason?: string;
  stage: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'unsupported';
  currentVersion: string;
  availableVersion?: string;
  percent?: number;
  error?: string;
  releaseNotes?: string;
  lastCheckedAt?: string;
}

export function onUpdateState(cb: (payload: UpdateStatePayload) => void): Promise<UnlistenFn> {
  return listenOrNoop<UpdateStatePayload>('update:state', cb);
}

export const tauriInstall = {
  install: (input: CreateServerInput, jobId: string) =>
    invokeRequired<ServerDto>('server_install', { input, jobId }),
  cancel: (jobId: string) =>
    invokeRequired<boolean>('server_install_cancel', { jobId }),
};

/** `server://log/{id}` channel name (live stdout/stderr, Phase 2/6). */
export function serverLogEvent(id: string): string {
  return `server://log/${id}`;
}

/** `server://status/{id}` channel name (lifecycle, Phase 2). */
export function serverStatusEvent(id: string): string {
  return `server://status/${id}`;
}

/** `job://progress/{jobId}` channel name (install/backup, Phase 4/5/8). */
export function jobProgressEvent(jobId: string): string {
  return `job://progress/${jobId}`;
}

export interface ServerStatusPayload {
  status: string;
}

/** `server://readiness/{id}` channel name (boot/auto-fix progress, D8). */
export function serverReadinessEvent(id: string): string {
  return `server://readiness/${id}`;
}

export interface ServerReadinessPayload {
  serverId: string;
  phase: 'preparing' | 'spawning' | 'spawned' | 'retrying' | 'ready' | 'stopped' | 'failed';
  attempt?: number;
  pid?: number | null;
  message?: string;
  at?: string;
}

async function listenOrNoop<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  if (isElectron()) return window.electronAPI!.on(event, (p) => cb(p as T));
  if (isHttpBackendConfigured()) return subscribeHttp<T>(event, cb);
  return () => {};
}

/** Subscribe to `server://log/{id}` (Tauri event or configured backend SSE). */
export function onServerLog(id: string, cb: (line: string) => void): Promise<UnlistenFn> {
  return listenOrNoop<string>(serverLogEvent(id), cb);
}

/** Subscribe to `server://status/{id}` (Tauri event or configured backend SSE). */
export function onServerStatus(
  id: string,
  cb: (payload: ServerStatusPayload) => void,
): Promise<UnlistenFn> {
  return listenOrNoop<ServerStatusPayload>(serverStatusEvent(id), cb);
}

/** Subscribe to `server://readiness/{id}` (spawn/retry/ready/failed progress). */
export function onServerReadiness(
  id: string,
  cb: (payload: ServerReadinessPayload) => void,
): Promise<UnlistenFn> {
  return listenOrNoop<ServerReadinessPayload>(serverReadinessEvent(id), cb);
}

/** Subscribe to `job://progress/{jobId}` (Tauri event or configured backend SSE). */
export function onJobProgress(
  jobId: string,
  cb: (payload: JobProgressPayload) => void,
): Promise<UnlistenFn> {
  return listenOrNoop<JobProgressPayload>(jobProgressEvent(jobId), cb);
}

/** `metrics://{id}` channel name (live process samples). */
export function serverMetricsEvent(id: string): string {
  return `metrics://${id}`;
}

export function onServerMetrics(
  id: string,
  cb: (payload: MetricsEventDto) => void,
): Promise<UnlistenFn> {
  return listenOrNoop<MetricsEventDto>(serverMetricsEvent(id), cb);
}

export const tauriServer = {
  // backend-wired (Phase 2): real `invoke()` under Tauri with error
  // propagation (see invokeStrict), mock fallback in browser.
  // (backup_now/restore in Phase 8 — until then these fall back to mocks.)
  start: (id: string) => invokeStrict<void>('server_start', { id }),
  stop: (id: string) => invokeStrict<void>('server_stop', { id }),
  kill: (id: string) => invokeStrict<void>('server_kill', { id }),
  restart: (id: string) => invokeStrict<void>('server_restart', { id }),
  sendCommand: (id: string, cmd: string) => invokeStrict<void>('server_send_command', { id, cmd }),
  backupNow: (id: string, name: string) => invokeRequired<BackupDto>('backup_create', { id, name }),
  restoreBackup: (id: string, backupId: string, mode: 'in-place' | 'reset' = 'in-place') =>
    invokeRequired<boolean>('backup_restore', { id, backupId, mode }),
};

