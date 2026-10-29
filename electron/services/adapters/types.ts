// Pack adapter layer — the generality core.
//
// Goal: stop special-casing individual packs and instead accept a *format*. Every adapter is a pure
// module with two responsibilities:
//   1. `detect()`  — decide, from archive/provider evidence only, whether this input is its format.
//                    Detection is by CONTENT SIGNATURE with validated keys, never by file extension:
//                    `manifest.json` and `instance.json` are each claimed by several formats.
//   2. `resolve()` — normalize the input into one canonical `PackRecipe`, so the shared install
//                    pipeline never needs to know which launcher produced the pack.
//
// Design rules taken from the online research (docs/research/2026-10-29-universal-modpack-install.md):
//  - `unknown` is a first-class side value and must never silently become `unsupported`.
//  - Metadata is a hint, not an authority; boot verification remains the final arbiter (L3).
//  - Every exclusion/warning carries the rule id that produced it, so it is auditable and revocable.
//  - Adapters that cannot resolve a required field fail closed with a specific reason.

/** Where a pack came from. Adapters declare which inputs they can handle. */
export type AdapterInputKind = 'archive' | 'providerApi' | 'directory';

/** Pack format identifiers. These are stable: they appear in reports and evidence files. */
export type PackFormatId =
  | 'modrinth.mrpack'
  | 'curseforge.client'
  | 'curseforge.serverpack'
  | 'ftb.app'
  | 'packwiz'
  | 'prism.multimc'
  | 'atlauncher'
  | 'gdlauncher'
  | 'technic'
  | 'mcbbs'
  | 'hmcl.server'
  | 'serverpackcreator'
  | 'plain.serverzip';

/**
 * Canonical server-side verdict for one file. `unknown` exists because CurseForge has no
 * per-file side data at all and several formats (ATLauncher, Technic, Prism, bare zips) carry none
 * either — collapsing that into `unsupported` would silently drop server-required mods.
 */
export type FileSide = 'required' | 'optional' | 'unsupported' | 'unknown';

export type LoaderFamily = 'vanilla' | 'paper' | 'fabric' | 'quilt' | 'forge' | 'neoforge' | 'hybrid';

/** Where a planned file's bytes come from. */
export interface FileSource {
  /** Direct HTTPS URLs, tried in order (mirrors allowed). */
  urls?: string[];
  /** Provider coordinates when the file must be resolved through an API later. */
  provider?: { kind: 'curseforge'; projectId: number; fileId: number };
}

export interface PlannedFile {
  /** Destination path relative to the server directory, always forward-slashed. */
  path: string;
  source: FileSource;
  sha1?: string | null;
  sha512?: string | null;
  size?: number | null;
  side: FileSide;
  /** Which adapter/rule decided `side`, for auditability. */
  sideProvenance: string;
}

export interface OverrideLayer {
  /** Directory prefix inside the archive, e.g. `overrides/`, `server-overrides/`. */
  prefix: string;
  /** Applied in ascending order; later layers win. `client-overrides` must never be listed. */
  order: number;
}

export interface RecipeWarning {
  /** Stable rule id, e.g. `side.metadata-missing`, `format.nested-zip`. */
  rule: string;
  message: string;
  path?: string;
}

/**
 * The one shape the install pipeline consumes. Everything format-specific has been resolved by here.
 */
export interface PackRecipe {
  /** Stable id of the adapter that produced this recipe. */
  formatId: PackFormatId;
  name: string;
  /** Exact Minecraft version; never guessed. Empty string means "not declared" → fail closed. */
  mc: string;
  loader: LoaderFamily;
  /** Exact loader build, or null when it must be resolved from provider metadata. */
  loaderVersion: string | null;
  /** Java major, or null to resolve from Mojang metadata by `mc`. */
  javaMajor: number | null;
  files: PlannedFile[];
  overrides: OverrideLayer[];
  /** How the server is launched once installed. */
  launchShape: 'generated-args' | 'launch-jar' | 'runnable-jar' | 'server-jar' | 'vendor-script';
  /** Paths the manager owns and a pack must never overwrite (world, eula, properties, ops, …). */
  managerOwned: string[];
  warnings: RecipeWarning[];
  /** Provenance of the resolution steps, in order (which source supplied which field). */
  resolution: { field: string; source: string }[];
}

/** One entry of an archive listing; adapters never need to re-read the zip. */
export interface ArchiveEntry {
  name: string;
  size: number;
  isDir: boolean;
}

export interface ArchiveIndex {
  /** Flat entry list, forward-slashed. */
  entries: ArchiveEntry[];
  names: Set<string>;
  /** Read one entry as UTF-8 JSON, tolerating a BOM; null when absent or unparseable. */
  readJson<T = unknown>(name: string): Promise<T | null>;
  /** Read one entry as UTF-8 text; null when absent. */
  readText(name: string): Promise<string | null>;
  /** Directory entries under a prefix, e.g. all `mods/*.jar` names. */
  under(prefix: string): string[];
}

/**
 * The acquisition shapes — the axis that actually varies between formats.
 *
 * Derived from evidence (docs/audit/21 §2, docs/audit/23 §4.1). The earlier `DetectContext` modelled only
 * `archive` ∪ `provider`, which structurally excluded the two shapes that failed in the Phase-A audit:
 * packwiz (an HTTP tree) and Prism/ATLauncher (a local launcher instance).
 *
 * | shape      | formats                                        |
 * |------------|------------------------------------------------|
 * | archive    | Modrinth .mrpack, CurseForge client pack, author server pack, bare dump |
 * | provider   | FTB (api.modpacks.ch), Modrinth/CurseForge by id |
 * | httpTree   | packwiz (pack.toml → index.toml → *.pw.toml over HTTP) |
 * | instance   | Prism mmc-pack.json, ATLauncher instance.json (payload already local) |
 */
export type AdapterShape = 'archive' | 'provider' | 'httpTree' | 'instance';

/**
 * A discriminated input. An adapter declaring `shapes: ['httpTree']` can never be handed an archive —
 * that is enforced by the registry, not by convention.
 */
export type DetectInput =
  | { shape: 'archive'; index: ArchiveIndex; path?: string }
  | { shape: 'provider'; kind: string; ids: Record<string, string | number | undefined>; cacheDir?: string }
  | { shape: 'httpTree'; baseUrl: string; fetchText?: (url: string) => Promise<string | null> }
  | { shape: 'instance'; index: ArchiveIndex; dir?: string };

/**
 * Legacy detection context kept for the adapters that still take it (ftb/prism/atlauncher/packwiz/serverzip).
 * New code should prefer `DetectInput`. `toDetectInput` in registry.ts bridges the two so the migration can be
 * incremental instead of a flag day.
 */
export interface DetectContext {
  /** Present for archive inputs. */
  archive?: ArchiveIndex;
  /** Free-form provider hints (project id, api key presence) for provider-API inputs. */
  provider?: { kind: string; ids?: Record<string, string | number | undefined> };
}

export interface AdapterIo {
  fetchJson<T = unknown>(url: string, allowedHosts: readonly string[]): Promise<T>;
  log(message: string): void;
}

/**
 * An adapter. `detect` must be cheap and side-effect free; `resolve` may perform provider calls.
 *
 * `shapes` is the primary contract: the registry only offers an input whose shape the adapter declares.
 * `detect`/`resolve` accept the discriminated `DetectInput`.
 */
export interface PackAdapter {
  readonly id: PackFormatId;
  readonly displayName: string;
  /** Acquisition shapes this adapter accepts. The registry refuses to route any other shape to it. */
  readonly shapes: readonly AdapterShape[];
  /** Legacy capability list, kept while adapters migrate to `shapes`. */
  readonly inputs?: readonly AdapterInputKind[];
  /** Higher priority is evaluated first when several formats could match. */
  readonly priority: number;
  /** Cheap content-signature test with key validation. Only called for a declared shape. */
  detect(input: DetectInput): boolean | Promise<boolean>;
  /** Normalize to the canonical recipe. Throws `AppError('validation', …)` on unresolvable input. */
  resolve(input: DetectInput, io: AdapterIo): Promise<PackRecipe>;
}

/** Paths a pack must never own, regardless of format. */
export const MANAGER_OWNED_PATHS: readonly string[] = [
  'eula.txt',
  'server.properties',
  'ops.json',
  'whitelist.json',
  'banned-players.json',
  'banned-ips.json',
  'usercache.json',
];

/** True when `path` escapes the destination (zip-slip guard shared by every adapter). */
export function isSafeRelativePath(path: string): boolean {
  if (path.trim() === '') return false;
  if (path.startsWith('/') || path.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  const norm = path.replaceAll('\\', '/');
  return !norm.split('/').some((segment) => segment === '..');
}

/** Normalize an archive path the way every adapter compares paths. */
export function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/^\/+/, '').toLowerCase();
}
