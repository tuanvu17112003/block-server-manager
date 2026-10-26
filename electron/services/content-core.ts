// Pure content-planning helpers (Phase 5 WP-5.1: M-01/M-07/F-13).
//
// Kept free of Electron, network and filesystem access so `node:test` can pin the tricky rules:
//  - replace-by-project update plans (overwrite same-name file, remove old/disabled copies, never
//    clobber another project's file),
//  - content metadata merge/prune (written only for published files),
//  - required-dependency split/de-dupe (never reinstall a disabled copy),
//  - loader/kind compatibility and version selection (Paper plugin dependency resolution).
import path from 'node:path';

export type ContentKind = 'mod' | 'plugin';

/** One file currently on disk (active or disabled folder), with its persisted project metadata. */
export interface ContentFileRef {
  fileName: string;
  enabled: boolean;
  projectId?: string | null;
  versionId?: string | null;
}

export interface ContentMetaEntry {
  projectId?: string;
  versionId?: string;
  versionNumber?: string;
  title?: string;
}

export interface ContentUpdatePlan {
  /** Basename of the newly resolved project file. */
  targetFileName: string;
  /** Same-project active file with the exact target name: publish replaces it atomically. */
  overwrite: ContentFileRef | null;
  /** Same-project files that become stale after publish (other versions, disabled copies). */
  stale: ContentFileRef[];
  /** Target name is held by a different project (or an unmanaged jar): refuse to overwrite it. */
  conflict: ContentFileRef | null;
  warnings: string[];
}

export const PLUGIN_LOADERS = ['paper', 'spigot', 'bukkit', 'purpur', 'folia'] as const;
const PLUGIN_LOADER_SET = new Set<string>(PLUGIN_LOADERS);

/** `x.jar.disabled` (legacy disabled copy) -> `x.jar`. */
export function stripDisabledSuffix(fileName: string): string {
  return fileName.replace(/\.disabled$/i, '');
}

/** Basename of a provider file name; content files must be `.jar` (Modrinth mods/plugins). */
export function contentFileName(raw: string): string {
  const base = path.basename(String(raw ?? '').trim());
  if (!base || base === '.' || base === '..') throw new Error('content file name is empty');
  if (!/\.jar$/i.test(base)) throw new Error(`content file is not a .jar: ${base}`);
  return base;
}

export function isJarName(fileName: string): boolean {
  return /\.jar(\.disabled)?$/i.test(fileName);
}

function sameName(a: string, b: string): boolean {
  return stripDisabledSuffix(a).toLowerCase() === stripDisabledSuffix(b).toLowerCase();
}

/**
 * Decide what an install of `projectId` (new file `targetFileName`) must do with the files that are
 * already on disk.
 *
 * - exact target name owned by the same project -> `overwrite` (published in place; no stale row),
 * - other same-project files (active or disabled) -> `stale` (removed/moved after the new file is
 *   published, so a failed download never loses the old version),
 * - exact target name owned by another project / no metadata -> `conflict` (never clobber),
 * - legacy `*.jar.disabled` copies of the target name -> `stale` (the new active file supersedes them).
 */
export function planContentUpdate(input: { files: ContentFileRef[]; projectId: string; targetFileName: string }): ContentUpdatePlan {
  const targetFileName = contentFileName(input.targetFileName);
  const projectId = String(input.projectId);
  const plan: ContentUpdatePlan = { targetFileName, overwrite: null, stale: [], conflict: null, warnings: [] };

  for (const file of input.files) {
    if (!isJarName(file.fileName)) continue;
    const same = sameName(file.fileName, targetFileName);
    const exact = file.fileName.toLowerCase() === targetFileName.toLowerCase();
    const owned = Boolean(file.projectId) && String(file.projectId) === projectId;
    if (same && !owned) {
      // Legacy disabled copies created before metadata existed are safe to supersede; an exact live
      // file belonging to something else is a real collision.
      if (exact && file.enabled) {
        plan.conflict = file;
      } else {
        plan.stale.push(file);
      }
      continue;
    }
    if (exact && owned && file.enabled) {
      if (!plan.overwrite) plan.overwrite = file;
      else plan.stale.push(file);
      continue;
    }
    if (owned) {
      plan.stale.push(file);
      continue;
    }
    if (same) plan.stale.push(file);
  }

  if (plan.stale.length > 0) {
    plan.warnings.push(`Replacing ${plan.stale.length} previous file(s) of this project after the new version is published.`);
  }
  if (plan.conflict) {
    plan.warnings.push(`"${plan.conflict.fileName}" already exists and belongs to a different project; refusing to overwrite it.`);
  }
  return plan;
}

/** Add/refresh metadata for published files only (stripping any legacy `.disabled` key first). */
export function mergeContentMeta(
  existing: Record<string, ContentMetaEntry>,
  updates: { fileName: string; entry: ContentMetaEntry }[],
): Record<string, ContentMetaEntry> {
  const merged: Record<string, ContentMetaEntry> = { ...existing };
  for (const update of updates) {
    const name = update.fileName;
    for (const key of Object.keys(merged)) {
      if (key.toLowerCase() === name.toLowerCase() || sameName(key, name)) delete merged[key];
    }
    merged[name] = { ...merged[name], ...update.entry };
    delete merged[`${name}.disabled`];
  }
  return merged;
}

/** Drop metadata for files that were removed/renamed away (accepts exact and `.disabled` keys). */
export function pruneContentMeta(
  existing: Record<string, ContentMetaEntry>,
  removedFileNames: string[],
): Record<string, ContentMetaEntry> {
  const removed = new Set(removedFileNames.map(stripDisabledSuffix).map((name) => name.toLowerCase()));
  const pruned: Record<string, ContentMetaEntry> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (removed.has(stripDisabledSuffix(key).toLowerCase())) continue;
    pruned[key] = value;
  }
  return pruned;
}

export interface ContentDependencyInput {
  projectId?: string | null;
  versionId?: string | null;
  type?: string | null;
}

/**
 * Required Modrinth dependencies as install candidates: deduped by project id, self-references and
 * already-present projects (active or disabled) excluded, then resolved in declaration order.
 */
export function requiredDependencies(
  dependencies: ContentDependencyInput[] | undefined,
  opts: { excludeProjectIds?: Iterable<string>; selfProjectId?: string } = {},
): { projectId: string; versionId: string | null }[] {
  const excluded = new Set<string>();
  for (const id of opts.excludeProjectIds ?? []) {
    if (id) excluded.add(String(id));
  }
  if (opts.selfProjectId) excluded.add(String(opts.selfProjectId));
  const seen = new Set<string>();
  const out: { projectId: string; versionId: string | null }[] = [];
  for (const dep of dependencies ?? []) {
    const type = (dep.type ?? 'required').toLowerCase();
    if (type !== 'required') continue;
    const projectId = dep.projectId ? String(dep.projectId) : '';
    if (!projectId || seen.has(projectId) || excluded.has(projectId)) continue;
    seen.add(projectId);
    out.push({ projectId, versionId: dep.versionId ? String(dep.versionId) : null });
  }
  return out;
}

/** A dependency already present under either folder (including a disabled copy) must not reinstall. */
export function presentProjectIds(files: ContentFileRef[]): Set<string> {
  const ids = new Set<string>();
  for (const file of files) if (file.projectId) ids.add(String(file.projectId));
  return ids;
}

export function normalizeLoader(loader: string | null | undefined): string {
  return String(loader ?? '').trim().toLowerCase();
}

/** Modrinth `loaders` compatibility: mods match the exact loader; Paper accepts any plugin loader. */
export function loaderMatches(versionLoaders: string[] | undefined, kind: ContentKind, loader: string): boolean {
  const expected = normalizeLoader(loader);
  const declared = (versionLoaders ?? []).map(normalizeLoader).filter(Boolean);
  if (declared.length === 0) return false;
  if (kind === 'plugin') {
    const allowed = expected === 'paper' ? PLUGIN_LOADER_SET : new Set([expected, ...PLUGIN_LOADER_SET]);
    return declared.some((entry) => allowed.has(entry));
  }
  return declared.includes(expected);
}

/** Modrinth project `server_side: "unsupported"` marks client-only projects (never install). */
export function isClientOnlyProject(project: { server_side?: string | null } | null | undefined): boolean {
  return String(project?.server_side ?? '').trim().toLowerCase() === 'unsupported';
}

/** A dependency must match the target folder kind (plugin endpoint for Paper, mod otherwise). */
export function acceptsProjectType(projectType: string | null | undefined, kind: ContentKind): boolean {
  const declared = String(projectType ?? '').trim().toLowerCase();
  if (!declared) return true; // older/partial payloads: do not reject blindly
  return declared === kind;
}

export interface VersionFileLike {
  filename?: string;
  url?: string;
  size?: number;
  hashes?: { sha1?: string; sha512?: string };
  primary?: boolean;
}

export interface VersionLike {
  id?: string;
  version_number?: string;
  name?: string;
  game_versions?: string[];
  loaders?: string[];
  files?: VersionFileLike[];
}

/** Primary (or first) file of a Modrinth version; null when it has no downloadable `.jar`. */
export function primaryJarFile<T extends VersionFileLike>(files: T[] | undefined): T | null {
  const list = files ?? [];
  const file = list.find((entry) => entry.primary) ?? list[0];
  if (!file?.url) return null;
  if (!/\.jar$/i.test(path.basename(String(file.filename ?? '')))) return null;
  return file;
}

/**
 * Newest compatible version (Modrinth returns newest first): exact Minecraft game version and a
 * compatible loader. Versions without a downloadable `.jar` are skipped.
 */
export function selectCompatibleVersion<T extends VersionLike>(
  versions: T[] | undefined,
  opts: { mcVersion: string; kind: ContentKind; loader: string },
): T | null {
  const mc = String(opts.mcVersion ?? '').trim();
  for (const version of versions ?? []) {
    if (mc && !(version.game_versions ?? []).includes(mc)) continue;
    if (!loaderMatches(version.loaders, opts.kind, opts.loader)) continue;
    if (!primaryJarFile(version.files)) continue;
    return version;
  }
  return null;
}

/** Human-readable reason a dependency project could not be used (warnings only). */
export function dependencySkipReason(kind: ContentKind, loader: string): string {
  return kind === 'plugin'
    ? `no compatible Paper plugin build for loader ${normalizeLoader(loader)}`
    : `no compatible build for loader ${normalizeLoader(loader)}`;
}
