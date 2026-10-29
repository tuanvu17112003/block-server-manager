// Canonical IPC contracts shared by the Electron main process and the React renderer
// (Phase 7 WP-7.1). Single source of truth for the 66 renderer-invokable command names and the
// camelCase DTOs they exchange.
//
// This file is intentionally dependency-free at runtime except for the tiny `COMMANDS` tuple and
// `isKnownCommand` (needed by tooling/tests). Types mirror `src/tauri.ts` + the actual handler
// outputs; see the Phase 7 audit note for the documented drift list (player_action, server_get,
// MinecraftVersionDto.support, content_install.skipped).
//
// NOTE (build wiring): `shared/` sits outside `electron/tsconfig.json`'s rootDir today, so the
// Electron project cannot `import` this file yet without a tsconfig/project-reference change.
// The Electron-side runtime copy of the command list lives in `electron/services/validate-ipc.ts`
// and `electron/test/contract-runner.ts` parses this file's `COMMANDS` tuple to enforce equality.
// Renderer wiring (`include: ["src", "shared"]` + imports from `src/tauri.ts`) is a Lead follow-up.

// ------------------------------------------------------------------------------------------------
// Command names
// ------------------------------------------------------------------------------------------------

/**
 * Every command the renderer may invoke through `window.electronAPI.invoke(command, args)`
 * (Electron → `ipcMain.handle('cmd:' + command)`). Keep in sync with the handler map and the
 * renderer adapter; the contract gate enforces all three lists are identical.
 */
export const COMMANDS = [
  'backup_create',
  'backup_delete',
  'backup_export',
  'backup_restore',
  'backup_schedule_get',
  'backup_schedule_set',
  'backups_list',
  'content_install',
  'content_install_cancel',
  'content_list',
  'content_remove',
  'content_search',
  'content_toggle',
  'content_versions',
  'curseforge_cancel_download',
  'curseforge_inspect_project',
  'curseforge_inspect_zip',
  'curseforge_key_clear',
  'curseforge_key_set',
  'curseforge_key_status',
  'curseforge_list_zips',
  'curseforge_open_browser',
  'curseforge_open_external_browser',
  'curseforge_pick_zip',
  'curseforge_search_modpacks',
  'diagnostics_bundle',
  'diagnostics_recent',
  'java_detect',
  'java_ensure',
  'java_validate',
  'loaders_resolve',
  'logs_tail',
  'metrics_get',
  'modpack_pipeline_cancel',
  'modpack_pipeline_discard_preview',
  'modpack_pipeline_install',
  'modpack_pipeline_pick_local_mrpack',
  'modpack_pipeline_preview',
  'modpack_pipeline_release_local_mrpack',
  'modrinth_project_versions',
  'modrinth_search_modpacks',
  'ping',
  'player_action',
  'players_add_offline',
  'players_list',
  'port_check',
  'server_command_history',
  'server_get',
  'server_install',
  'server_install_cancel',
  'server_kill',
  'server_open_folder',
  'server_restart',
  'server_send_command',
  'server_settings_get',
  'server_settings_update',
  'server_start',
  'server_stop',
  'servers_create',
  'servers_delete',
  'servers_list',
  'servers_set_java_path',
  'storage_get',
  'storage_open_folder',
  'storage_pick_folder',
  'storage_set',
  'system_disk',
  'versions_paper',
  'versions_vanilla',
  'world_activate',
  'world_create',
  'world_delete',
  'world_duplicate',
  'world_export',
  'world_import',
  'worlds_list',
] as const;

export type CommandName = (typeof COMMANDS)[number];

/** Runtime guard for CLI/tooling; the Electron boundary uses its own generated validator map. */
export function isKnownCommand(name: string): name is CommandName {
  return (COMMANDS as readonly string[]).includes(name);
}

// ------------------------------------------------------------------------------------------------
// JSON helpers / error contract
// ------------------------------------------------------------------------------------------------

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Toastable backend error shape carried in the `{__ipc}` envelope. */
export interface AppErrorDto {
  code: 'validation' | 'not-found' | 'conflict' | 'io' | 'db' | 'internal' | 'cancelled' | 'forbidden' | string;
  message: string;
}

// ------------------------------------------------------------------------------------------------
// Servers / settings
// ------------------------------------------------------------------------------------------------

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

/** `server_get` resolves `null` for an unknown id (handler behavior; renderer type was non-null). */
export type ServerGetResult = ServerDto | null;

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

export interface PortCheckDto {
  port: number;
  available: boolean;
  suggested: number;
}

// ------------------------------------------------------------------------------------------------
// Players
// ------------------------------------------------------------------------------------------------

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

export const PLAYER_ACTIONS = [
  'kick',
  'ban',
  'unban',
  'op',
  'deop',
  'whitelistAdd',
  'whitelistRemove',
  'gamemode',
  'teleport',
  'heal',
] as const;
export type PlayerAction = (typeof PLAYER_ACTIONS)[number];

/** `player_action` returns `true` for live-console actions and a DTO for offline file edits. */
export type PlayerActionResult = boolean | PlayerDto;

// ------------------------------------------------------------------------------------------------
// Worlds
// ------------------------------------------------------------------------------------------------

export interface WorldDto {
  name: string;
  sizeBytes: number;
  lastModified: string;
  active: boolean;
  pending?: boolean;
  seed?: string | null;
  warning?: string | null;
}

export interface WorldActivateResult {
  backupId: string;
}

export type WorldExportResult = { path: string } | { cancelled: true };
export type WorldImportResult = { name: string } | { cancelled: true };

// ------------------------------------------------------------------------------------------------
// Backups
// ------------------------------------------------------------------------------------------------

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

export type BackupExportResult = { path: string } | { cancelled: true };

// ------------------------------------------------------------------------------------------------
// Metrics
// ------------------------------------------------------------------------------------------------

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

export interface DiskUsageDto {
  freeBytes: number;
  totalBytes: number;
}

export interface MetricsHistoryDto {
  samples: MetricsBucketDto[];
  disk: DiskUsageDto;
  current: MetricsBucketDto | null;
}

// ------------------------------------------------------------------------------------------------
// Content (mods/plugins)
// ------------------------------------------------------------------------------------------------

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

export interface ContentSearchResultDto {
  hits: ContentSearchHitDto[];
  totalHits: number;
}

export interface ContentDependencyDto {
  projectId: string | null;
  versionId: string | null;
  type: string;
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
  dependencies: ContentDependencyDto[];
}

export interface ContentInstallResultDto {
  installed: number;
  files: string[];
  warnings: string[];
  /** Dependencies deliberately not installed (already present / client-only / no compatible build). */
  skipped: number;
}

// ------------------------------------------------------------------------------------------------
// Java / version catalogue
// ------------------------------------------------------------------------------------------------

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
  /** Additive: Paper support status (`SUPPORTED`/`DEPRECATED`/…); null/absent for non-Paper. */
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
  hashes: { sha1: string; sha512: string };
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

// ------------------------------------------------------------------------------------------------
// Modpack pipeline
// ------------------------------------------------------------------------------------------------

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
  sourcePin: JsonValue | unknown;
  loader: PipelineLoaderPin;
  fileDecisions: PipelineFileDecision[];
}

export interface PipelinePreviewDto {
  previewId: string;
  sourceName: string;
  plan: PipelineInstallPlan;
  warnings: string[];
  /** Evidence grade of the detected format (docs/audit/19 §2); null when the source has no adapter recipe. */
  evidence: EvidenceGradeDto | null;
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
  | { kind: 'curseforgeProject'; projectId: number };

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
  sourcePin: JsonValue | unknown;
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

// ------------------------------------------------------------------------------------------------
// CurseForge staging / events
// ------------------------------------------------------------------------------------------------

export interface CurseForgeStagedZip {
  name: string;
  size: number;
  modifiedAt: number | null;
}

export type CurseForgeArchiveClassification = 'supportedServerPack' | 'clientExport' | 'unsupported';

export interface CurseForgeArchiveInspection {
  name: string;
  classification: CurseForgeArchiveClassification;
  reason: string;
  minecraftVersion: string | null;
  loader: string | null;
  loaderVersion: string | null;
}

export interface CurseForgeProjectMetaDto {
  projectId: number;
  name: string;
  minecraftVersion: string | null;
  loader: string | null;
  loaderVersion: string | null;
  hasServerPack: boolean;
}

export interface CurseForgeDownloadUpdate {
  id: string;
  name: string;
  status: 'starting' | 'downloading' | 'canceling' | 'completed' | 'cancelled' | 'failed';
  bytesReceived: number;
  totalBytes: number | null;
  message: string;
}

// ------------------------------------------------------------------------------------------------
// Events
// ------------------------------------------------------------------------------------------------

export interface JobProgressPayload {
  progress: number;
  stage?: string;
  log?: string;
  bytesDownloaded?: number;
  bytesTotal?: number;
}

export interface ServerStatusPayload {
  status: string;
}

export interface ServerReadinessPayload {
  serverId: string;
  phase: 'preparing' | 'spawning' | 'spawned' | 'retrying' | 'ready' | 'stopped' | 'failed';
  attempt?: number;
  pid?: number | null;
  message?: string;
  at?: string;
}

/** Evidence grade of a detected pack format, for display (docs/audit/26 Item 4). */
export interface EvidenceGradeDto {
  /** E1 whole real population · E2 installed+verified · E3 schema-derived (NOT proof) · E4 design only. */
  grade: string;
  note: string;
  formatId: string;
  /**
   * True when the recipe plans downloadable files of its own. A Prism/MultiMC instance is E2 (a real artefact was
   * recognised) yet legitimately plans ZERO files, because it ships launcher metadata and an updater jar rather
   * than mods — so E2 alone must not be rendered as "verified and ready to install".
   */
  selfContained: boolean;
  /** How many files the plan will download; 0 for launcher-instance formats. */
  plannedFileCount: number;
}

