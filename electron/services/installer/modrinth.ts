// Modrinth module — search/versions DTOs + .mrpack → server engine.
// TS port of the proven spike (modrinth.mjs); behavior identical.
import path from 'node:path';
import fs from 'node:fs';
import {
  downloadFirstAvailable, fetchTrusted, extractZip, listZip, readZipEntry, verifyCachedFile, ensureJava,
  installLoader, launchCommand, requiredJavaMajor, log, startWithAutoFix, writeEula, ensureServerProperties,
  MODRINTH_ALLOWED_HOSTS, type Cancelable, type LoaderKind, type AutoFixEntry,
} from './core';
import { makeCuratedResolver, appendLearned, type CuratedResolver } from './curated';

const API = 'https://api.modrinth.com/v2';

// ---- DTOs for the UI (shapes from src/tauri.ts) ----
export interface ModrinthModpackDto { id: string; name: string; author: string; downloads: number; gameVersions: string[]; loaders: string[]; iconUrl: string | null; summary: string }
export async function searchModpacks(query: string, gameVersion: string | null, loader: string | null, index: string, offset: number, limit: number, opts: Cancelable = {}): Promise<{ results: ModrinthModpackDto[]; offset: number; limit: number; totalHits: number }> {
  const facets: string[][] = [['project_type:modpack']];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  if (loader) facets.push([`categories:${loader}`]);
  const url = `${API}/search?query=${encodeURIComponent(query)}&index=${index}&offset=${offset}&limit=${limit}&facets=${encodeURIComponent(JSON.stringify(facets))}`;
  const j = await (await fetchTrusted(url, MODRINTH_ALLOWED_HOSTS, { signal: opts.signal })).json() as {
    hits: { project_id: string; title: string; author: string; downloads: number; versions: string[]; categories: string[]; icon_url?: string; description: string }[];
    offset: number; limit: number; total_hits: number;
  };
  return {
    results: j.hits.map(h => ({
      id: h.project_id, name: h.title, author: h.author, downloads: h.downloads,
      gameVersions: h.versions ?? [], loaders: (h.categories ?? []).filter(c => ['fabric', 'forge', 'neoforge', 'quilt'].includes(c)),
      iconUrl: h.icon_url ?? null, summary: h.description,
    })),
    offset: j.offset, limit: j.limit, totalHits: j.total_hits,
  };
}

export async function projectVersions(projectId: string, opts: Cancelable = {}): Promise<{ id: string; name: string; versionNumber: string; gameVersions: string[]; loaders: string[]; changelog: string; files: { url: string; filename: string; size: number; primary: boolean; hashes: { sha1: string; sha512: string } }[] }[]> {
  const j = await (await fetchTrusted(`${API}/project/${projectId}/version`, MODRINTH_ALLOWED_HOSTS, { signal: opts.signal })).json() as {
    id: string; name: string; version_number: string; game_versions: string[]; loaders: string[]; changelog: string;
    files: { url: string; filename: string; size: number; primary: boolean; hashes: Record<string, string> }[];
  }[];
  return j.map(v => ({
    id: v.id, name: v.name, versionNumber: v.version_number, gameVersions: v.game_versions, loaders: v.loaders, changelog: v.changelog,
    files: v.files.map(f => ({ url: f.url, filename: f.filename, size: f.size, primary: f.primary, hashes: { sha1: f.hashes.sha1 ?? '', sha512: f.hashes.sha512 ?? '' } })),
  }));
}

// ---- engine ----
export interface MrIndex {
  formatVersion: number; game: string; versionId: string; name: string;
  files: { path: string; hashes: Record<string, string>; env?: { client?: string; server?: string }; downloads: string[]; fileSize: number }[];
  dependencies: Record<string, string>;
}

interface ModrinthVersionFile { url: string; filename: string; primary?: boolean; size?: number; hashes?: { sha1?: string; sha512?: string } }

/** Ordered download candidates for one Modrinth file (WP-4.4: downloads[] failover). */
function mrFileCandidates(file: { downloads?: string[]; url?: string; size?: number; fileSize?: number; hashes?: { sha1?: string; sha512?: string }; sha1?: string; sha512?: string }): { url: string; size?: number; sha1?: string; sha512?: string }[] {
  const urls = (file.downloads ?? (file.url ? [file.url] : [])).filter((url): url is string => typeof url === 'string' && url.length > 0);
  return urls.map(url => ({
    url,
    size: file.fileSize ?? file.size,
    sha1: file.hashes?.sha1 ?? file.sha1,
    sha512: file.hashes?.sha512 ?? file.sha512,
  }));
}

export async function resolveMrpack(ref: { projectId?: string; versionId?: string; localPath?: string }, cacheDir: string, opts: Cancelable = {}): Promise<{ mrpackPath: string; index: MrIndex; slug: string | null }> {
  let mrpackPath: string;
  let slug: string | null = null;
  if (ref.localPath) {
    mrpackPath = ref.localPath;
  } else {
    const versionsUrl = ref.versionId ? `${API}/version/${ref.versionId}` : `${API}/project/${ref.projectId}/version`;
    const list = await (await fetchTrusted(versionsUrl, MODRINTH_ALLOWED_HOSTS, { signal: opts.signal })).json() as unknown as {
      files: ModrinthVersionFile[];
    }[] | { files: ModrinthVersionFile[] };
    const version = Array.isArray(list) ? list[0] : list;
    if (!version?.files?.length) throw new Error('no mrpack file on version');
    slug = ref.projectId ?? null;
    const files = version.files;
    const file = files.find(f => f.primary) ?? files[0];
    mrpackPath = path.join(cacheDir, 'mrpack', file.filename);
    // Cache re-verify (INST-010): a corrupt/truncated cached mrpack is re-downloaded, never parsed.
    await downloadFirstAvailable(mrFileCandidates(file), {
      dest: mrpackPath,
      allowedHosts: MODRINTH_ALLOWED_HOSTS,
      signal: opts.signal,
    });
  }
  const index = JSON.parse((await readZipEntry(mrpackPath, 'modrinth.index.json')).toString('utf8')) as MrIndex;
  if (index.formatVersion !== 1 || !index.dependencies?.minecraft) throw new Error('invalid modrinth.index.json');
  return { mrpackPath, index, slug };
}

const LOADER_OF: Record<string, LoaderKind> = { 'fabric-loader': 'fabric', 'quilt-loader': 'quilt', forge: 'forge', neoforge: 'neoforge' };

/** L3 dependency fetch: resolve a missing mod id/slug to a compatible Modrinth file and install it. */
export async function fetchModrinthDependency(opts: {
  mc: string; loader: string; modId: string; modsDir: string; signal?: AbortSignal;
}): Promise<string | null> {
  const loaderKey = opts.loader.trim().toLowerCase();
  if (!['fabric', 'forge', 'neoforge', 'quilt', 'paper', 'spigot', 'bukkit', 'purpur', 'folia'].includes(loaderKey)) return null;
  let projectId: string | null = null;
  try {
    const direct = await fetchTrusted(`${API}/project/${encodeURIComponent(opts.modId)}`, MODRINTH_ALLOWED_HOSTS, { signal: opts.signal });
    if (direct.ok) {
      const project = await direct.json() as { id?: string; project_type?: string };
      if (project.id && (project.project_type === undefined || project.project_type === 'mod')) projectId = project.id;
    }
  } catch {
    // A mod id is often not a slug; search handles that case below.
  }
  if (!projectId) {
    const facets = [['project_type:mod'], [`versions:${opts.mc}`], [`categories:${loaderKey}`]];
    const url = `${API}/search?query=${encodeURIComponent(opts.modId)}&limit=1&facets=${encodeURIComponent(JSON.stringify(facets))}`;
    const found = await (await fetchTrusted(url, MODRINTH_ALLOWED_HOSTS, { signal: opts.signal })).json() as { hits?: { project_id?: string }[] };
    projectId = found.hits?.[0]?.project_id ?? null;
  }
  if (!projectId) return null;
  const query = `?game_versions=${encodeURIComponent(JSON.stringify([opts.mc]))}&loaders=${encodeURIComponent(JSON.stringify([loaderKey]))}`;
  const versions = await (await fetchTrusted(`${API}/project/${projectId}/version${query}`, MODRINTH_ALLOWED_HOSTS, { signal: opts.signal })).json() as {
    files?: ModrinthVersionFile[];
  }[];
  const file = versions[0]?.files?.find((entry) => entry.primary) ?? versions[0]?.files?.[0];
  if (!file?.url) return null;
  const fileName = path.basename(file.filename);
  if (!/\.jar$/i.test(fileName)) return null;
  const dest = path.join(opts.modsDir, fileName);
  if (!(await verifyCachedFile(dest, { size: file.size, sha1: file.hashes?.sha1, sha512: file.hashes?.sha512 }))) {
    await downloadFirstAvailable(mrFileCandidates(file), { dest, allowedHosts: MODRINTH_ALLOWED_HOSTS, signal: opts.signal });
  }
  return dest;
}

export function splitDeps(index: MrIndex): { kind: LoaderKind | null; ver: string | null; mc: string } {
  const d = index.dependencies;
  let kind: LoaderKind | null = null, ver: string | null = null;
  for (const [k, v] of Object.entries(d)) if (LOADER_OF[k]) { kind = LOADER_OF[k]; ver = v; }
  return { kind, ver, mc: d.minecraft };
}

// ---- overrides (WP-4.6 / INST-005, INST-009) ----
export interface ModrinthOverridesOpts extends Cancelable {
  mrpackPath: string;
  dir: string;
  index: MrIndex;
  includeOptional?: (filePath: string) => boolean;
  /** Additional exclusion (e.g. curated/server-unsupported paths), applied to both override layers. */
  excludeFn?: (rel: string) => boolean;
}
export interface ModrinthOverridesResult { written: number; skippedExisting: number; warnings: string[] }

/** Manager-owned files that archive overrides must never install (EULA consent is explicit). */
export const PROTECTED_OVERRIDE_PATHS: readonly string[] = ['eula.txt', 'server.properties'];
const OVERRIDE_LAYERS = ['overrides/', 'server-overrides/', 'client-overrides/'] as const;

function normalizeArchiveRel(rel: string): string {
  return rel.replaceAll('\\', '/').replace(/^\.\/+/, '').toLowerCase();
}

/**
 * Apply mrpack override layers in the documented order:
 *   downloaded pack files (winners) > server-overrides/ > overrides/ ; client-overrides/ is ignored.
 * User-excluded optional mods and `excludeFn` matches are never re-added by an override; protected
 * manager files (eula.txt/server.properties) are never extracted and produce warnings instead.
 */
export async function applyModrinthOverrides(opts: ModrinthOverridesOpts): Promise<ModrinthOverridesResult> {
  const warnings: string[] = [];
  const protectedSet = new Set(PROTECTED_OVERRIDE_PATHS.map(normalizeArchiveRel));
  const excludeMatches = new Map<string, string>(); // normalized rel -> reason
  const addExclude = (rel: string, reason: string): void => {
    const key = normalizeArchiveRel(rel);
    if (key && !excludeMatches.has(key)) excludeMatches.set(key, reason);
  };

  // Pack files (from modrinth.index.json) win over every archive override layer.
  for (const file of opts.index.files ?? []) addExclude(file.path, 'pack file');
  // Optional mods the user chose to exclude must not come back through an override jar.
  for (const file of opts.index.files ?? []) {
    if (file.env?.server !== 'optional') continue;
    const wanted = opts.includeOptional?.(file.path) ?? false;
    if (!wanted) addExclude(file.path, 'user-excluded optional');
  }
  for (const rel of PROTECTED_OVERRIDE_PATHS) addExclude(rel, 'manager-owned');

  // client-overrides/ is client-only by contract.
  let hasClientOverrides = false;
  try {
    const entries = await listZip(opts.mrpackPath);
    hasClientOverrides = entries.some((entry) => entry.name.startsWith('client-overrides/') && !entry.isDir);
  } catch { /* unreadable -> extraction below fails with a clear error */ }
  if (hasClientOverrides) warnings.push('client-overrides/ ignored (client-only layer)');

  const excludedByLayer: string[] = [];
  const makeExcludeFn = (): ((rel: string) => boolean) => (rel: string): boolean => {
    const key = normalizeArchiveRel(rel);
    const reason = excludeMatches.get(key);
    if (reason) {
      if (reason === 'pack file') warnings.push(`archive override ignored (pack file wins): ${rel}`);
      else if (reason !== 'manager-owned') excludedByLayer.push(`${rel}: ${reason}`);
      return true;
    }
    if (opts.excludeFn?.(rel)) { excludedByLayer.push(`${rel}: excluded`); return true; }
    return false;
  };

  let written = 0;
  let skippedExisting = 0;
  await fs.promises.mkdir(opts.dir, { recursive: true });
  // Base overrides first; download files win because they already exist (skipExisting).
  const base = await extractZip(opts.mrpackPath, opts.dir, {
    root: 'overrides/', skipExisting: true, excludeFn: makeExcludeFn(), signal: opts.signal,
  });
  written += base.written.length;
  skippedExisting += base.skippedExisting.length;
  // Server overrides next: they overwrite base overrides, but never pack files / excluded mods.
  const server = await extractZip(opts.mrpackPath, opts.dir, {
    root: 'server-overrides/', skipExisting: false, excludeFn: makeExcludeFn(), signal: opts.signal,
  });
  written += server.written.length;

  // Manager-owned files encountered in the archive are reported, never written.
  for (const key of protectedSet) {
    const present = base.excluded.some((rel) => normalizeArchiveRel(rel) === key)
      || server.excluded.some((rel) => normalizeArchiveRel(rel) === key);
    if (present) warnings.push(`${key}: ignored from archive overrides (manager-owned)`);
  }
  warnings.push(...excludedByLayer);
  return { written, skippedExisting, warnings };
}

export interface ModrinthFilePolicyInput {
  /** L1 mrpack environment declared for the file. */
  declared: string;
  /** Resolved curated/L4 policy (`required`/`optional`/`unsupported`). */
  curated: string;
  /** True only when the reviewed plan explicitly chooses Include for this file. */
  userIncluded: boolean;
  why?: string | null;
}
export interface ModrinthFilePolicy { action: 'install' | 'skip-optional' | 'skip-unsupported'; warning: string | null }

/**
 * Resolve whether a pack file is installed (WP-4.5). An explicit Include from the reviewed plan
 * wins over a curated L4 unsupported/exclude verdict — otherwise the reviewed plan would lie —
 * while curated exclusions stay authoritative for files the user did not explicitly choose.
 */
export function resolveModrinthFilePolicy(input: ModrinthFilePolicyInput): ModrinthFilePolicy {
  const curated = input.curated === 'unsupported' || input.curated === 'optional' || input.curated === 'required'
    ? input.curated
    : input.declared;
  if (input.userIncluded && curated !== 'required') {
    return {
      action: 'install',
      warning: curated === 'unsupported'
        ? `included per reviewed plan despite curated exclusion${input.why ? ` (${input.why})` : ''}`
        : null,
    };
  }
  if (curated === 'unsupported') return { action: 'skip-unsupported', warning: null };
  if (curated === 'optional') return { action: 'skip-optional', warning: null };
  return { action: 'install', warning: null };
}

export interface InstallModrinthOpts extends Cancelable {
  mrpackPath: string; index: MrIndex; slug: string | null;
  dir: string; cacheDir: string; dataRoot: string;
  javaMajorOverride?: number;
  onProgress?: (p: { stage: string; pct?: number; file?: string }) => void;
  includeOptional?: (filePath: string) => boolean;
}
export interface InstallModrinthResult { installed: number; skippedOptional: number; skippedUnsupported: number; warnings: string[]; fixes: AutoFixEntry[]; launch: { exe: string; args: string[] } }

export async function installModrinth(o: InstallModrinthOpts): Promise<InstallModrinthResult> {
  const { signal } = o;
  const { kind, ver, mc } = splitDeps(o.index);
  if (!kind) throw new Error(`no supported loader in dependencies: ${JSON.stringify(o.index.dependencies)}`);
  const javaMajor = o.javaMajorOverride ?? await requiredJavaMajor(mc, { signal });
  o.onProgress?.({ stage: `resolving Java ${javaMajor}`, pct: 2 });
  const runtimeRoot = path.join(o.dataRoot, 'runtime');
  const rt = await ensureJava(javaMajor, runtimeRoot, o.cacheDir, undefined, { signal });

  if (fs.existsSync(o.dir)) throw new Error(`dir already exists: ${o.dir}`);
  fs.mkdirSync(o.dir, { recursive: true });
  o.onProgress?.({ stage: `installing ${kind} ${ver}`, pct: 5 });
  await installLoader(kind, o.dir, mc, ver ?? '', rt.javapath, o.cacheDir, { signal });

  const result: InstallModrinthResult = { installed: 0, skippedOptional: 0, skippedUnsupported: 0, warnings: [], fixes: [], launch: { exe: '', args: [] } };
  const curated: CuratedResolver = makeCuratedResolver({ platform: 'modrinth', packSlug: o.slug, presentPaths: o.index.files.map(f => f.path) });
  const total = o.index.files.length;
  const userIncludedPaths = new Set(
    o.index.files.filter(f => o.includeOptional?.(f.path) === true).map(f => f.path.replaceAll('\\', '/').toLowerCase()),
  );
  for (const f of o.index.files) {
    const declared = f.env?.server ?? 'required';
    const v = curated.resolve(f.path, declared);
    const policy = resolveModrinthFilePolicy({ declared, curated: v.env, userIncluded: userIncludedPaths.has(f.path.replaceAll('\\', '/').toLowerCase()), why: v.why });
    if (policy.warning) result.warnings.push(`${f.path}: ${policy.warning}`);
    if (policy.action === 'skip-unsupported') { result.skippedUnsupported++; if (v.why !== 'declared') result.warnings.push(`${f.path}: ${v.why}`); continue; }
    if (policy.action === 'skip-optional') { result.skippedOptional++; continue; }
    // Ordered downloads[] failover with per-candidate size+hash verification and cache re-verify.
    await downloadFirstAvailable(mrFileCandidates({ downloads: f.downloads, fileSize: f.fileSize, hashes: f.hashes }), {
      dest: path.join(o.dir, f.path),
      allowedHosts: MODRINTH_ALLOWED_HOSTS,
      signal,
    });
    result.installed++;
    if (result.installed % 25 === 0) o.onProgress?.({ stage: `downloading files ${result.installed}/${total}`, pct: 5 + Math.round(85 * result.installed / total) });
  }

  o.onProgress?.({ stage: 'applying overrides', pct: 92 });
  const overrides = await applyModrinthOverrides({
    mrpackPath: o.mrpackPath,
    dir: o.dir,
    index: o.index,
    includeOptional: o.includeOptional,
    // Curated excludes apply to overrides only for files the user did NOT explicitly choose.
    excludeFn: rel => {
      if (userIncludedPaths.has(rel.replaceAll('\\', '/').toLowerCase())) return false;
      return /^mods\/.*\.jar$/i.test(rel) && curated.resolve(rel, 'required').env === 'unsupported';
    },
    signal,
  });
  result.warnings.push(...overrides.warnings);

  result.launch = launchCommand(o.dir, rt.javapath);
  log(`[modrinth] ${o.index.name}: ${result.installed} files, ${result.skippedOptional} optional, ${result.skippedUnsupported} unsupported`);
  return result;
}
