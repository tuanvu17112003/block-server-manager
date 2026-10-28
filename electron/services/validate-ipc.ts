// Runtime IPC argument validation (Phase 7 WP-7.1).
//
// Lightweight, hand-written per-command validators applied ONLY at the `ipcMain` boundary
// (`ipc.ts:registerIpc`) — never inside `handlersMap`, so direct handler-map access used by the
// service/contract/selftest gates is unchanged. Validators reject wrong types, NaN/out-of-range
// numbers, unknown enums, missing required objects and path-unsafe ids/names with
// `{ code: 'validation', message: '<command>: <detail>' }`; unknown commands are `not-found`.
//
// Canonical command list + DTOs live in `shared/contracts.ts`. `electron/tsconfig.json`'s rootDir
// cannot compile that path yet (Lead build-wiring follow-up), so this module carries the runtime
// `COMMAND_NAMES` copy and `electron/test/contract-runner.ts` asserts it equals both the shared
// `COMMANDS` tuple and the renderer command list.
import { appError } from './store';
import { normalizeCreateServerInput } from './validate-args';

type Args = Record<string, unknown>;

/** Runtime mirror of `shared/contracts.ts` `COMMANDS` (same 72 names, sorted). */
export const COMMAND_NAMES = [
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

export type KnownCommand = (typeof COMMAND_NAMES)[number];

const COMMAND_SET: ReadonlySet<string> = new Set(COMMAND_NAMES);

export function isKnownCommand(name: string): name is KnownCommand {
  return COMMAND_SET.has(name);
}

// ------------------------------------------------------------------------------------------------
// Primitive helpers (all throw `validation` with a command-prefixed message)
// ------------------------------------------------------------------------------------------------

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Job ids / preview ids / transfer ids (randomUUID, `install-<uuid>`, `java-<ts>-<rand>`, …). */
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PLAYER_NAME_PATTERN = /^[A-Za-z0-9_]{1,16}$/;
/** Permissive version shape; the stronger Mojang syntax check lives in `validate-args.ts`. */
const MC_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f]/;

const PLAYER_ACTIONS = [
  'kick', 'ban', 'unban', 'op', 'deop', 'whitelistAdd', 'whitelistRemove', 'gamemode', 'teleport', 'heal',
] as const;
const BACKUP_KINDS = ['Manual', 'Auto', 'Pre-install', 'Pre-restore', 'World-delete'] as const;
const BACKUP_INTERVALS = ['Hourly', 'Daily', 'Weekly'] as const;
const BACKUP_RESTORE_MODES = ['in-place', 'reset'] as const;
const MODRINTH_INDEXES = ['relevance', 'downloads', 'follows', 'newest', 'updated'] as const;
const PIPELINE_LOADER_KINDS = ['vanilla', 'fabric', 'forge', 'neoForge', 'quilt'] as const;
const PIPELINE_FILE_CHOICES = ['include', 'exclude'] as const;
const PIPELINE_SOURCE_KINDS = ['modrinthRemote', 'localMrpack', 'curseForgeServerZip', 'curseforgeProject'] as const;

function fail(command: string, detail: string): never {
  throw appError('validation', `${command}: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function present(args: Args, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(args, key) && args[key] !== undefined;
}

function requireString(
  command: string,
  args: Args,
  key: string,
  options: { maxLength?: number; allowEmpty?: boolean; pattern?: RegExp; patternDetail?: string } = {},
): string {
  const value = args[key];
  if (typeof value !== 'string') fail(command, `"${key}" must be a string.`);
  if (!options.allowEmpty && value.trim() === '') fail(command, `"${key}" must not be empty.`);
  if (value.length > (options.maxLength ?? 512)) {
    fail(command, `"${key}" must be at most ${options.maxLength ?? 512} characters.`);
  }
  if (CONTROL_CHAR_PATTERN.test(value)) fail(command, `"${key}" contains invalid control characters.`);
  if (options.pattern && !options.pattern.test(value)) {
    fail(command, options.patternDetail ?? `"${key}" has an invalid format.`);
  }
  return value;
}

function optionalString(
  command: string,
  args: Args,
  key: string,
  options: { maxLength?: number; allowEmpty?: boolean; pattern?: RegExp; patternDetail?: string } = {},
): string | undefined {
  if (!present(args, key)) return undefined;
  return requireString(command, args, key, options);
}

function requireNullableString(
  command: string,
  args: Args,
  key: string,
  options: { maxLength?: number; allowEmpty?: boolean } = {},
): string | null {
  if (args[key] === null) return null;
  return requireString(command, args, key, options);
}

function optionalNullableString(
  command: string,
  args: Args,
  key: string,
  options: { maxLength?: number; allowEmpty?: boolean } = {},
): string | null | undefined {
  if (!present(args, key)) return undefined;
  return requireNullableString(command, args, key, options);
}

function requireInt(
  command: string,
  args: Args,
  key: string,
  options: { min?: number; max?: number } = {},
): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(command, `"${key}" must be an integer.`);
  }
  if (options.min !== undefined && value < options.min) fail(command, `"${key}" must be at least ${options.min}.`);
  if (options.max !== undefined && value > options.max) fail(command, `"${key}" must be at most ${options.max}.`);
  return value;
}

function optionalInt(
  command: string,
  args: Args,
  key: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  if (!present(args, key)) return undefined;
  return requireInt(command, args, key, options);
}

function requireBool(command: string, args: Args, key: string): boolean {
  const value = args[key];
  if (typeof value !== 'boolean') fail(command, `"${key}" must be a boolean.`);
  return value;
}

function optionalBool(command: string, args: Args, key: string): boolean | undefined {
  if (!present(args, key)) return undefined;
  return requireBool(command, args, key);
}

function requireEnum<T extends readonly string[]>(command: string, args: Args, key: string, values: T): T[number] {
  const value = args[key];
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    fail(command, `"${key}" must be one of: ${values.join(', ')}.`);
  }
  return value as T[number];
}

function optionalEnum<T extends readonly string[]>(command: string, args: Args, key: string, values: T): T[number] | undefined {
  if (!present(args, key)) return undefined;
  return requireEnum(command, args, key, values);
}

function requireObject(command: string, args: Args, key: string): Record<string, unknown> {
  const value = args[key];
  if (!isRecord(value)) fail(command, `"${key}" must be an object.`);
  return value;
}

function requireStringArray(command: string, args: Args, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value)) fail(command, `"${key}" must be an array of strings.`);
  for (const entry of value) {
    if (typeof entry !== 'string') {
      fail(command, `"${key}" must be an array of strings.`);
    }
    if (entry.length > 1024) fail(command, `"${key}" entries must be at most 1024 characters.`);
  }
  return value as string[];
}

function optionalStringArray(command: string, args: Args, key: string): string[] | undefined {
  if (!present(args, key)) return undefined;
  return requireStringArray(command, args, key);
}

function requireId(command: string, args: Args, key = 'id'): string {
  return requireString(command, args, key, {
    maxLength: 64,
    pattern: ID_PATTERN,
    patternDetail: `"${key}" must be a path-safe id (letters, digits, '.', '_' or '-' only).`,
  });
}

function requireToken(command: string, args: Args, key: string): string {
  return requireString(command, args, key, {
    maxLength: 128,
    pattern: TOKEN_PATTERN,
    patternDetail: `"${key}" must be a job/preview token (letters, digits, '.', '_', ':' or '-' only).`,
  });
}

function optionalToken(command: string, args: Args, key: string): string | undefined {
  if (!present(args, key)) return undefined;
  return requireToken(command, args, key);
}

/** Single path segment used for worlds/backups/content files and staged ZIP names. */
function requirePathSafeName(command: string, args: Args, key: string, options: { maxLength?: number; allowEmpty?: boolean } = {}): string {
  const maxLength = options.maxLength ?? 255;
  const value = requireString(command, args, key, { maxLength, allowEmpty: options.allowEmpty });
  if (!options.allowEmpty && value.trim() === '') fail(command, `"${key}" must not be empty.`);
  if (value === '.' || value === '..') fail(command, `"${key}" must be a plain file/folder name.`);
  if (/[\\/:*?"<>|]/.test(value)) {
    fail(command, `"${key}" must not contain path separators or reserved characters.`);
  }
  return value;
}

function optionalPathSafeName(command: string, args: Args, key: string): string | undefined {
  if (!present(args, key)) return undefined;
  return requirePathSafeName(command, args, key, { allowEmpty: true });
}

/** Arbitrary local path (absolute Windows paths allowed); rejects NUL/newlines only. */
function requirePathString(command: string, args: Args, key: string, options: { allowEmpty?: boolean } = {}): string {
  return requireString(command, args, key, { maxLength: 1024, allowEmpty: options.allowEmpty });
}

function optionalPathString(command: string, args: Args, key: string, options: { allowEmpty?: boolean } = {}): string | undefined {
  if (!present(args, key)) return undefined;
  return requirePathString(command, args, key, options);
}

function optionalNullablePathString(command: string, args: Args, key: string): string | null | undefined {
  if (!present(args, key)) return undefined;
  if (args[key] === null) return null;
  return requirePathString(command, args, key, { allowEmpty: true });
}

function requireMcVersion(command: string, args: Args): string {
  return requireString(command, args, 'mcVersion', {
    maxLength: 32,
    pattern: MC_VERSION_PATTERN,
    patternDetail: '"mcVersion" has an invalid Minecraft version format.',
  });
}

function requireCreateServerInput(command: string, args: Args, key = 'input'): void {
  const input = requireObject(command, args, key);
  try {
    normalizeCreateServerInput(input);
  } catch (error) {
    if ((error as { code?: string }).code === 'validation') {
      fail(command, (error as Error).message);
    }
    throw error;
  }
}

function requireSettingsValues(command: string, args: Args): void {
  const values = requireObject(command, args, 'values');
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string') {
      fail(command, `"values.${key}" must be a string (server.properties values are strings).`);
    }
    if (key.length > 128 || /[\u0000\r\n]/.test(key)) fail(command, `"values" has an invalid property key "${key}".`);
  }
}

function requirePipelineCreateInput(command: string, args: Args): void {
  const input = requireObject(command, args, 'input');
  requireStringIn(command, input, 'name', { maxLength: 64, pattern: /^[^=\r\n]+$/, patternDetail: '"name" must not contain newlines or "=".' });
  optionalIntIn(command, input, 'port', { min: 1024, max: 65535 });
  requireIntIn(command, input, 'ramMb', { min: 512, max: 65536 });
  optionalPathStringIn(command, input, 'javaPath', { allowEmpty: false });
  optionalBoolIn(command, input, 'eulaAccepted');
}

function requirePipelineChoices(command: string, args: Args): void {
  const choices = requireObject(command, args, 'choices');
  const files = requireObjectIn(command, choices, 'files');
  for (const [path, choice] of Object.entries(files)) {
    if (choice !== 'include' && choice !== 'exclude') {
      fail(command, `"choices.files.${path}" must be "include" or "exclude".`);
    }
  }
  requireStringArrayIn(command, choices, 'approvedReplacements');
  requireBoolIn(command, choices, 'autoDeleteCurseForgeZip');
}

// Nested-object helper variants (errors reference the nested key path).
function requireStringIn(
  command: string,
  target: Args,
  key: string,
  options: { maxLength?: number; allowEmpty?: boolean; pattern?: RegExp; patternDetail?: string } = {},
): string {
  if (!present(target, key)) fail(command, `"${key}" is required.`);
  return requireString(command, target, key, options);
}
function optionalIntIn(command: string, target: Args, key: string, options: { min?: number; max?: number } = {}): void {
  if (!present(target, key)) return;
  requireInt(command, target, key, options);
}
function requireIntIn(command: string, target: Args, key: string, options: { min?: number; max?: number } = {}): void {
  if (!present(target, key)) fail(command, `"${key}" is required.`);
  requireInt(command, target, key, options);
}
function optionalPathStringIn(command: string, target: Args, key: string, options: { allowEmpty?: boolean } = {}): void {
  if (!present(target, key)) return;
  requireString(command, target, key, { maxLength: 1024, allowEmpty: options.allowEmpty });
}
function optionalBoolIn(command: string, target: Args, key: string): void {
  if (!present(target, key)) return;
  requireBool(command, target, key);
}
function requireBoolIn(command: string, target: Args, key: string): void {
  if (!present(target, key)) fail(command, `"${key}" is required.`);
  requireBool(command, target, key);
}
function requireObjectIn(command: string, target: Args, key: string): Record<string, unknown> {
  const value = target[key];
  if (!isRecord(value)) fail(command, `"${key}" must be an object.`);
  return value;
}
function requireStringArrayIn(command: string, target: Args, key: string): void {
  const value = target[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    fail(command, `"${key}" must be an array of strings.`);
  }
}

// ------------------------------------------------------------------------------------------------
// Per-command validators
// ------------------------------------------------------------------------------------------------

export type CommandValidator = (command: KnownCommand, args: Args) => void;

const noArgs: CommandValidator = () => { /* no renderer arguments */ };
const idOnly: CommandValidator = (command, args) => { requireId(command, args); };

function validatePipelineSource(command: KnownCommand, args: Args): void {
  const source = requireObject(command, args, 'source');
  const kind = requireEnum(command, source, 'kind', PIPELINE_SOURCE_KINDS);
  switch (kind) {
    case 'modrinthRemote': {
      requireStringIn(command, source, 'projectId', { maxLength: 128 });
      requireStringIn(command, source, 'versionId', { maxLength: 128 });
      const loader = requireObjectIn(command, source, 'loader');
      requireEnum(command, loader, 'kind', PIPELINE_LOADER_KINDS);
      requireStringIn(command, loader, 'minecraftVersion', { maxLength: 32 });
      if (present(loader, 'loaderVersion')) requireNullableString(command, loader, 'loaderVersion', { maxLength: 64, allowEmpty: true });
      if (present(source, 'javaPath')) requireString(command, source, 'javaPath', { maxLength: 1024, allowEmpty: true });
      return;
    }
    case 'localMrpack':
      requirePathString(command, source, 'sourceId');
      return;
    case 'curseForgeServerZip':
      requirePathSafeName(command, source, 'zipName');
      return;
    case 'curseforgeProject':
      requireInt(command, source, 'projectId', { min: 1 });
      return;
    default:
      fail(command, '"source.kind" is not a supported pipeline source.');
  }
}

const VALIDATORS: Record<KnownCommand, CommandValidator> = {
  // ---- shell / versions ----
  ping: noArgs,
  servers_list: noArgs,
  system_disk: noArgs,
  versions_vanilla: noArgs,
  versions_paper: noArgs,
  loaders_resolve: (command, args) => { requireMcVersion(command, args); },

  // ---- servers / settings ----
  server_get: idOnly,
  servers_delete: idOnly,
  servers_create: (command, args) => { requireCreateServerInput(command, args); },
  servers_set_java_path: (command, args) => {
    requireId(command, args);
    optionalNullablePathString(command, args, 'path');
  },
  server_settings_get: idOnly,
  server_settings_update: (command, args) => {
    requireId(command, args);
    requireSettingsValues(command, args);
    if (present(args, 'name')) {
      requireString(command, args, 'name', {
        maxLength: 64,
        pattern: /^[^=\r\n]+$/,
        patternDetail: '"name" must not contain newlines or "=".',
      });
    }
    optionalInt(command, args, 'ramMb', { min: 512, max: 65536 });
    optionalBool(command, args, 'eulaAccepted');
  },
  server_open_folder: (command, args) => {
    requireId(command, args);
    optionalPathString(command, args, 'sub', { allowEmpty: true });
  },
  port_check: (command, args) => { requireInt(command, args, 'port', { min: 1024, max: 65535 }); },

  // ---- lifecycle / console ----
  server_start: idOnly,
  server_stop: idOnly,
  server_kill: idOnly,
  server_restart: idOnly,
  server_send_command: (command, args) => {
    requireId(command, args);
    requireString(command, args, 'cmd', { maxLength: 4096 });
  },
  logs_tail: (command, args) => {
    requireId(command, args);
    optionalInt(command, args, 'lines', { min: 1, max: 10_000 });
  },
  server_command_history: idOnly,
  server_install: (command, args) => {
    requireCreateServerInput(command, args);
    optionalToken(command, args, 'jobId');
  },
  server_install_cancel: (command, args) => { requireToken(command, args, 'jobId'); },

  // ---- java ----
  java_detect: (command, args) => { requireMcVersion(command, args); },
  java_validate: (command, args) => {
    requireMcVersion(command, args);
    requirePathString(command, args, 'path');
  },
  java_ensure: (command, args) => {
    requireInt(command, args, 'major', { min: 1, max: 99 });
    optionalToken(command, args, 'jobId');
  },

  // ---- players ----
  players_list: idOnly,
  player_action: (command, args) => {
    requireId(command, args);
    requireEnum(command, args, 'action', PLAYER_ACTIONS);
    requireString(command, args, 'name', {
      maxLength: 64,
      pattern: PLAYER_NAME_PATTERN,
      patternDetail: '"name" must be a Minecraft player name (letters, digits, underscore).',
    });
    optionalString(command, args, 'value', { maxLength: 512, allowEmpty: true });
  },
  players_add_offline: (command, args) => {
    requireId(command, args);
    requireString(command, args, 'name', {
      maxLength: 64,
      pattern: PLAYER_NAME_PATTERN,
      patternDetail: '"name" must be a Minecraft player name (letters, digits, underscore).',
    });
  },

  // ---- worlds ----
  worlds_list: idOnly,
  world_activate: (command, args) => {
    requireId(command, args);
    requirePathSafeName(command, args, 'name');
  },
  world_create: (command, args) => {
    requireId(command, args);
    requirePathSafeName(command, args, 'name');
    optionalString(command, args, 'seed', { maxLength: 256, allowEmpty: true });
    optionalString(command, args, 'levelType', { maxLength: 64 });
  },
  world_duplicate: (command, args) => {
    requireId(command, args);
    requirePathSafeName(command, args, 'name');
    optionalToken(command, args, 'jobId');
  },
  world_delete: (command, args) => {
    requireId(command, args);
    requirePathSafeName(command, args, 'name');
  },
  world_export: (command, args) => {
    requireId(command, args);
    requirePathSafeName(command, args, 'name');
    optionalToken(command, args, 'jobId');
  },
  world_import: (command, args) => {
    requireId(command, args);
    optionalToken(command, args, 'jobId');
  },

  // ---- backups ----
  backups_list: idOnly,
  backup_create: (command, args) => {
    requireId(command, args);
    optionalPathSafeName(command, args, 'name');
    optionalEnum(command, args, 'kind', BACKUP_KINDS);
    optionalToken(command, args, 'jobId');
    optionalBool(command, args, 'shutdownDuring');
  },
  backup_restore: (command, args) => {
    requireId(command, args);
    requireToken(command, args, 'backupId');
    optionalEnum(command, args, 'mode', BACKUP_RESTORE_MODES);
    optionalToken(command, args, 'jobId');
  },
  backup_delete: (command, args) => { requireToken(command, args, 'backupId'); },
  backup_export: (command, args) => { requireToken(command, args, 'backupId'); },
  backup_schedule_get: idOnly,
  backup_schedule_set: (command, args) => {
    requireId(command, args);
    optionalBool(command, args, 'auto');
    optionalEnum(command, args, 'interval', BACKUP_INTERVALS);
    optionalInt(command, args, 'maxKept', { min: 1, max: 365 });
    optionalNullableString(command, args, 'lastRunAt', { maxLength: 64, allowEmpty: true });
  },

  // ---- metrics ----
  metrics_get: (command, args) => {
    requireId(command, args);
    optionalInt(command, args, 'hours', { min: 1, max: 168 });
  },

  // ---- content ----
  content_list: idOnly,
  content_toggle: (command, args) => {
    requireId(command, args);
    requirePathSafeName(command, args, 'fileName');
    requireBool(command, args, 'enabled');
  },
  content_remove: (command, args) => {
    requireId(command, args);
    requirePathSafeName(command, args, 'fileName');
  },
  content_search: (command, args) => {
    requireId(command, args);
    optionalString(command, args, 'query', { maxLength: 512, allowEmpty: true });
    optionalInt(command, args, 'offset', { min: 0, max: 1_000_000 });
    optionalInt(command, args, 'limit', { min: 1, max: 100 });
  },
  content_versions: (command, args) => {
    requireId(command, args);
    requireString(command, args, 'projectId', { maxLength: 128 });
  },
  content_install: (command, args) => {
    requireId(command, args);
    requireString(command, args, 'projectId', { maxLength: 128 });
    optionalNullableString(command, args, 'versionId', { maxLength: 128, allowEmpty: true });
    optionalNullableString(command, args, 'title', { maxLength: 256, allowEmpty: true });
    optionalToken(command, args, 'jobId');
  },
  content_install_cancel: (command, args) => { requireToken(command, args, 'jobId'); },

  // ---- modrinth ----
  modrinth_search_modpacks: (command, args) => {
    optionalString(command, args, 'query', { maxLength: 512, allowEmpty: true });
    optionalNullableString(command, args, 'gameVersion', { maxLength: 32, allowEmpty: true });
    optionalNullableString(command, args, 'loader', { maxLength: 32, allowEmpty: true });
    optionalEnum(command, args, 'index', MODRINTH_INDEXES);
    optionalInt(command, args, 'offset', { min: 0, max: 1_000_000 });
    optionalInt(command, args, 'limit', { min: 1, max: 100 });
  },
  modrinth_project_versions: (command, args) => {
    requireString(command, args, 'projectId', { maxLength: 128 });
    optionalNullableString(command, args, 'gameVersion', { maxLength: 32, allowEmpty: true });
    optionalNullableString(command, args, 'loader', { maxLength: 32, allowEmpty: true });
  },

  // ---- modpack pipeline ----
  modpack_pipeline_pick_local_mrpack: noArgs,
  modpack_pipeline_preview: (command, args) => {
    validatePipelineSource(command, args);
    optionalToken(command, args, 'jobId');
  },
  modpack_pipeline_install: (command, args) => {
    requireToken(command, args, 'previewId');
    requirePipelineCreateInput(command, args);
    requirePipelineChoices(command, args);
    optionalToken(command, args, 'jobId');
  },
  modpack_pipeline_cancel: (command, args) => { requireToken(command, args, 'jobId'); },
  modpack_pipeline_discard_preview: (command, args) => { requireToken(command, args, 'previewId'); },
  modpack_pipeline_release_local_mrpack: (command, args) => { requirePathString(command, args, 'sourceId'); },

  // ---- curseforge staging ----
  curseforge_open_browser: noArgs,
  curseforge_open_external_browser: noArgs,
  curseforge_list_zips: noArgs,
  curseforge_pick_zip: noArgs,
  curseforge_inspect_zip: (command, args) => { requirePathSafeName(command, args, 'name'); },
  curseforge_inspect_project: (command, args) => {
    const value = args.project;
    if (typeof value === 'number') {
      if (!Number.isInteger(value) || value <= 0) fail(command, '"project" must be a positive project id.');
      return;
    }
    if (typeof value === 'string' && value.trim() !== '' && value.length <= 128) return;
    fail(command, '"project" must be a CurseForge project id (number) or slug/url (string).');
  },
  curseforge_cancel_download: (command, args) => { requireToken(command, args, 'transferId'); },
  curseforge_search_modpacks: (command, args) => {
    optionalString(command, args, 'query', { maxLength: 200, allowEmpty: true });
    optionalIntIn(command, args, 'offset', { min: 0, max: 100_000 });
    optionalIntIn(command, args, 'limit', { min: 1, max: 50 });
    optionalEnum(command, args, 'sort', ['popularity', 'recent', 'name', 'downloads'] as const);
  },

  // ---- secrets / diagnostics (Phase 7) ----
  curseforge_key_status: noArgs,
  curseforge_key_set: (command, args) => {
    const key = args.key;
    if (typeof key !== 'string') fail(command, '"key" must be a string.');
    const trimmed = key.trim();
    if (trimmed.length < 16 || trimmed.length > 512) fail(command, '"key" must be 16-512 characters.');
    if (/\s/.test(trimmed)) fail(command, '"key" must not contain whitespace.');
    if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) fail(command, '"key" contains unsupported characters.');
  },
  curseforge_key_clear: noArgs,
  diagnostics_bundle: noArgs,
  diagnostics_recent: (command, args) => { optionalIntIn(command, args, 'limit', { min: 1, max: 500 }); },
};

// ------------------------------------------------------------------------------------------------
// Minimal valid arguments (contract gate: every command must have a passing minimal payload)
// ------------------------------------------------------------------------------------------------

const MINIMAL_SERVER_INPUT = { name: 'Contract Server', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 2048 };

export const MINIMAL_VALID_ARGS: Record<KnownCommand, Args> = {
  ping: {},
  servers_list: {},
  system_disk: {},
  versions_vanilla: {},
  versions_paper: {},
  loaders_resolve: { mcVersion: '1.21.1' },
  server_get: { id: 'server-1' },
  servers_delete: { id: 'server-1' },
  servers_create: { input: MINIMAL_SERVER_INPUT },
  servers_set_java_path: { id: 'server-1', path: null },
  server_settings_get: { id: 'server-1' },
  server_settings_update: { id: 'server-1', values: {} },
  server_open_folder: { id: 'server-1' },
  port_check: { port: 25565 },
  server_start: { id: 'server-1' },
  server_stop: { id: 'server-1' },
  server_kill: { id: 'server-1' },
  server_restart: { id: 'server-1' },
  server_send_command: { id: 'server-1', cmd: 'list' },
  logs_tail: { id: 'server-1', lines: 200 },
  server_command_history: { id: 'server-1' },
  server_install: { input: MINIMAL_SERVER_INPUT, jobId: 'job-1' },
  server_install_cancel: { jobId: 'job-1' },
  java_detect: { mcVersion: '1.21.1' },
  java_validate: { mcVersion: '1.21.1', path: 'C:\\Java\\bin\\java.exe' },
  java_ensure: { major: 21, jobId: 'job-java-1' },
  players_list: { id: 'server-1' },
  player_action: { id: 'server-1', action: 'op', name: 'Steve' },
  players_add_offline: { id: 'server-1', name: 'Steve' },
  worlds_list: { id: 'server-1' },
  world_activate: { id: 'server-1', name: 'world' },
  world_create: { id: 'server-1', name: 'world2', seed: '', levelType: 'minecraft:normal' },
  world_duplicate: { id: 'server-1', name: 'world', jobId: 'job-1' },
  world_delete: { id: 'server-1', name: 'world' },
  world_export: { id: 'server-1', name: 'world' },
  world_import: { id: 'server-1' },
  backups_list: { id: 'server-1' },
  backup_create: { id: 'server-1', name: 'backup-1' },
  backup_restore: { id: 'server-1', backupId: 'backup-1', mode: 'in-place' },
  backup_delete: { backupId: 'backup-1' },
  backup_export: { backupId: 'backup-1' },
  backup_schedule_get: { id: 'server-1' },
  backup_schedule_set: { id: 'server-1', auto: true, interval: 'Daily', maxKept: 10 },
  metrics_get: { id: 'server-1', hours: 1 },
  content_list: { id: 'server-1' },
  content_toggle: { id: 'server-1', fileName: 'example.jar', enabled: true },
  content_remove: { id: 'server-1', fileName: 'example.jar' },
  content_search: { id: 'server-1', query: 'sodium', offset: 0, limit: 20 },
  content_versions: { id: 'server-1', projectId: 'project-1' },
  content_install: { id: 'server-1', projectId: 'project-1', versionId: null, title: null, jobId: 'job-1' },
  content_install_cancel: { jobId: 'job-1' },
  curseforge_search_modpacks: { query: 'skyfactory', offset: 0, limit: 20, sort: 'popularity' },
  curseforge_key_status: {},
  curseforge_key_set: { key: '0123456789abcdef0123456789abcdef' },
  curseforge_key_clear: {},
  diagnostics_bundle: {},
  diagnostics_recent: { limit: 100 },
  modrinth_search_modpacks: { query: '', gameVersion: null, loader: null, index: 'relevance', offset: 0, limit: 20 },
  modrinth_project_versions: { projectId: 'project-1' },
  modpack_pipeline_pick_local_mrpack: {},
  modpack_pipeline_preview: { source: { kind: 'localMrpack', sourceId: 'C:\\packs\\pack.mrpack' }, jobId: 'job-1' },
  modpack_pipeline_install: {
    previewId: 'preview-1',
    input: { name: 'Contract Pack', ramMb: 4096 },
    choices: { files: {}, approvedReplacements: [], autoDeleteCurseForgeZip: false },
    jobId: 'job-1',
  },
  modpack_pipeline_cancel: { jobId: 'job-1' },
  modpack_pipeline_discard_preview: { previewId: 'preview-1' },
  modpack_pipeline_release_local_mrpack: { sourceId: 'C:\\packs\\pack.mrpack' },
  curseforge_open_browser: {},
  curseforge_open_external_browser: {},
  curseforge_list_zips: {},
  curseforge_pick_zip: {},
  curseforge_inspect_zip: { name: 'pack.zip' },
  curseforge_inspect_project: { project: 123456 },
  curseforge_cancel_download: { transferId: 'transfer-1' },
};

// ------------------------------------------------------------------------------------------------
// Entry point
// ------------------------------------------------------------------------------------------------

function normalizeArgs(command: string, args: unknown): Args {
  if (args === undefined || args === null) return {};
  if (!isRecord(args)) throw appError('validation', `${command}: arguments must be an object.`);
  return args;
}

/**
 * Validate renderer-supplied arguments for `command`.
 *
 * @throws `not-found` for an unknown command name; `validation` with a `<command>: <detail>`
 *         message for a malformed argument shape. Handlers keep their deeper domain validation.
 */
export function validateCommandArgs(command: string, args?: unknown): void {
  const normalized = normalizeArgs(command, args);
  if (!isKnownCommand(command)) throw appError('not-found', `Unknown IPC command "${command}".`);
  VALIDATORS[command](command, normalized);
}
