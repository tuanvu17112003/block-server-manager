// Backend adapter (Electron | Tauri | HTTP | stub). Electron port: see docs/electron-port-plan.md —
// the exported surface is unchanged; isElectron() branches ahead of Tauri/HTTP.
import { invoke, isTauri as isTauriRuntime } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getBackendConfigError, isHttpBackendConfigured } from './backend/config';
import { invokeHttp, subscribeHttp, uploadHttp } from './backend/http';

interface ElectronApi {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  on(channel: string, cb: (payload: unknown) => void): () => void;
}
declare global {
  interface Window { electronAPI?: ElectronApi }
}

export function isElectron(): boolean {
  return typeof window !== 'undefined' && window.electronAPI !== undefined;
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

export function isTauri(): boolean {
  return isTauriRuntime();
}

/** Any desktop host (Electron or Tauri): native pickers instead of browser uploads. */
export function isDesktop(): boolean {
  return isElectron() || isTauri();
}

/** True when a desktop host (Electron/Tauri) or a runtime-configured HTTP backend is available. */
export function hasBackend(): boolean {
  return isElectron() || isTauri() || isHttpBackendConfigured();
}

export async function stubInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  // eslint-disable-next-line no-console
  console.debug(`[tauri-stub] invoke "${command}"`, args ?? {});
  return null;
}

/** Toastable backend error shape `{code, message}` (Rust AppError). */
export interface AppError {
  code: 'validation' | 'not-found' | 'conflict' | 'io' | 'db' | 'internal' | string;
  message: string;
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
  | { kind: 'curseForgeServerZip'; zipName: string };

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
  try {
    if (isElectron()) return await invokeElectron<T>(command, args);
    if (isTauri()) return await invoke<T>(command, args);
    return await invokeHttp<T>(command, args);
  } catch (err) {
    if (isElectron() || !isTauri()) throw err;
    // Command not registered yet (later phase) or backend error:
    // retain the legacy desktop fallback for commands that are not wired yet.
    // eslint-disable-next-line no-console
    console.debug(`[tauri] invoke "${command}" fell back to mock`, err);
    return null;
  }
}

// backend-wired (Phase 2 entry fix): on the Tauri path, backend AppError
// ({code, message}) rejects propagate to the store (toastable) instead of
// being swallowed to null. Browser fallback still returns null so web
// dev/build keeps the mocks.
async function invokeStrict<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!hasBackend()) return stubInvoke<T>(command, args);
  if (isElectron()) return invokeElectron<T>(command, args);
  return isTauri() ? invoke<T>(command, args) : invokeHttp<T>(command, args);
}

/** Strict backend calls never stub or swallow failures when a backend is configured. */
async function invokeRequired<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!hasBackend()) {
    const configError = getBackendConfigError();
    throw new Error(configError ?? `Backend command "${command}" requires Electron, Tauri or backend-config.json.`);
  }
  if (isElectron()) return invokeElectron<T>(command, args);
  return isTauri() ? invoke<T>(command, args) : invokeHttp<T>(command, args);
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
  remove: (id: string) => invokeOrStub<void>('servers_delete', { id }),
  setJavaPath: (id: string, path: string | null) =>
    invokeRequired<ServerDto>('servers_set_java_path', { id, path }),
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
    if (!isTauri()) {
      window.open('https://www.curseforge.com/minecraft/search?class=modpacks', '_blank', 'noopener,noreferrer');
      return Promise.resolve(false);
    }
    return invokeRequired<boolean>('curseforge_open_browser');
  },
  openExternalBrowser: () => {
    if (isElectron()) return invokeRequired<void>('curseforge_open_external_browser');
    if (!isTauri()) {
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
  cancelDownload: (transferId: string) =>
    invokeRequired<boolean>('curseforge_cancel_download', { transferId }),
};

export function onCurseForgeDownload(
  cb: (payload: CurseForgeDownloadUpdate) => void,
): Promise<UnlistenFn> {
  return listenOrNoop<CurseForgeDownloadUpdate>('curseforge://download', cb);
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

async function listenOrNoop<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  if (isElectron()) return window.electronAPI!.on(event, (p) => cb(p as T));
  if (isTauri()) return listen<T>(event, (e) => cb(e.payload));
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

/** Subscribe to `job://progress/{jobId}` (Tauri event or configured backend SSE). */
export function onJobProgress(
  jobId: string,
  cb: (payload: JobProgressPayload) => void,
): Promise<UnlistenFn> {
  return listenOrNoop<JobProgressPayload>(jobProgressEvent(jobId), cb);
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
  backupNow: (id: string, name: string) => invokeOrStub('backup_now', { id, name }),
  restoreBackup: (id: string, backupId: string) => invokeOrStub('backup_restore', { id, backupId }),
};
