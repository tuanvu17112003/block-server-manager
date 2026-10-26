// Modrinth module — search/versions DTOs + .mrpack → server engine.
// TS port of the proven spike (modrinth.mjs); behavior identical.
import path from 'node:path';
import fs from 'node:fs';
import { download, fetchOk, extractZip, readZipEntry, listZip, ensureJava, installLoader, launchCommand, requiredJavaMajor, log, startWithAutoFix, writeEula, ensureServerProperties, UA, type LoaderKind, type AutoFixEntry } from './core';
import { makeCuratedResolver, appendLearned, type CuratedResolver } from './curated';

const API = 'https://api.modrinth.com/v2';

// ---- DTOs for the UI (shapes from src/tauri.ts) ----
export interface ModrinthModpackDto { id: string; name: string; author: string; downloads: number; gameVersions: string[]; loaders: string[]; iconUrl: string | null; summary: string }
export async function searchModpacks(query: string, gameVersion: string | null, loader: string | null, index: string, offset: number, limit: number): Promise<{ results: ModrinthModpackDto[]; offset: number; limit: number; totalHits: number }> {
  const facets: string[][] = [['project_type:modpack']];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  if (loader) facets.push([`categories:${loader}`]);
  const url = `${API}/search?query=${encodeURIComponent(query)}&index=${index}&offset=${offset}&limit=${limit}&facets=${encodeURIComponent(JSON.stringify(facets))}`;
  const j = await (await fetch(url, { headers: { 'User-Agent': UA } })).json() as {
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

export async function projectVersions(projectId: string): Promise<{ id: string; name: string; versionNumber: string; gameVersions: string[]; loaders: string[]; changelog: string; files: { url: string; filename: string; size: number; primary: boolean; hashes: { sha1: string; sha512: string } }[] }[]> {
  const j = await (await fetch(`${API}/project/${projectId}/version`, { headers: { 'User-Agent': UA } })).json() as {
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

export async function resolveMrpack(ref: { projectId?: string; versionId?: string; localPath?: string }, cacheDir: string): Promise<{ mrpackPath: string; index: MrIndex; slug: string | null }> {
  let mrpackPath: string;
  let slug: string | null = null;
  if (ref.localPath) {
    mrpackPath = ref.localPath;
  } else {
    const versionsUrl = ref.versionId ? `${API}/version/${ref.versionId}` : `${API}/project/${ref.projectId}/version`;
    const list = await (await fetch(versionsUrl, { headers: { 'User-Agent': UA } })).json() as unknown as {
      files: { url: string; filename: string; hashes?: { sha1?: string; sha512?: string }; size?: number }[];
    }[] | { files: { url: string; filename: string; hashes?: { sha1?: string; sha512?: string }; size?: number }[] };
    const version = Array.isArray(list) ? list[0] : list;
    if (!version?.files?.length) throw new Error('no mrpack file on version');
    slug = ref.projectId ?? null;
    const files = version.files as { url: string; filename: string; hashes?: { sha1?: string; sha512?: string }; size?: number; primary?: boolean }[];
    const file = files.find(f => f.primary) ?? files[0];
    mrpackPath = path.join(cacheDir, 'mrpack', file.filename);
    if (!fs.existsSync(mrpackPath)) await download(file.url, mrpackPath, { sha1: file.hashes?.sha1, sha512: file.hashes?.sha512, size: file.size });
  }
  const index = JSON.parse((await readZipEntry(mrpackPath, 'modrinth.index.json')).toString('utf8')) as MrIndex;
  if (index.formatVersion !== 1 || !index.dependencies?.minecraft) throw new Error('invalid modrinth.index.json');
  return { mrpackPath, index, slug };
}

const LOADER_OF: Record<string, LoaderKind> = { 'fabric-loader': 'fabric', 'quilt-loader': 'quilt', forge: 'forge', neoforge: 'neoforge' };

/** L3 dependency fetch: resolve a missing mod id/slug to a compatible Modrinth file and install it. */
export async function fetchModrinthDependency(opts: {
  mc: string; loader: string; modId: string; modsDir: string;
}): Promise<string | null> {
  const loaderKey = opts.loader.trim().toLowerCase();
  if (!['fabric', 'forge', 'neoforge', 'quilt', 'paper', 'spigot', 'bukkit', 'purpur', 'folia'].includes(loaderKey)) return null;
  let projectId: string | null = null;
  try {
    const direct = await fetchOk(`${API}/project/${encodeURIComponent(opts.modId)}`, { headers: { 'User-Agent': UA } });
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
    const found = await (await fetchOk(url, { headers: { 'User-Agent': UA } })).json() as { hits?: { project_id?: string }[] };
    projectId = found.hits?.[0]?.project_id ?? null;
  }
  if (!projectId) return null;
  const query = `?game_versions=${encodeURIComponent(JSON.stringify([opts.mc]))}&loaders=${encodeURIComponent(JSON.stringify([loaderKey]))}`;
  const versions = await (await fetchOk(`${API}/project/${projectId}/version${query}`, { headers: { 'User-Agent': UA } })).json() as {
    files?: { url: string; filename: string; primary?: boolean; size?: number; hashes?: { sha1?: string; sha512?: string } }[];
  }[];
  const file = versions[0]?.files?.find((entry) => entry.primary) ?? versions[0]?.files?.[0];
  if (!file?.url) return null;
  const fileName = path.basename(file.filename);
  if (!/\.jar$/i.test(fileName)) return null;
  const dest = path.join(opts.modsDir, fileName);
  if (!fs.existsSync(dest)) {
    await download(file.url, dest, { sha1: file.hashes?.sha1, sha512: file.hashes?.sha512, size: file.size });
  }
  return dest;
}

export function splitDeps(index: MrIndex): { kind: LoaderKind | null; ver: string | null; mc: string } {
  const d = index.dependencies;
  let kind: LoaderKind | null = null, ver: string | null = null;
  for (const [k, v] of Object.entries(d)) if (LOADER_OF[k]) { kind = LOADER_OF[k]; ver = v; }
  return { kind, ver, mc: d.minecraft };
}

export interface InstallModrinthOpts {
  mrpackPath: string; index: MrIndex; slug: string | null;
  dir: string; cacheDir: string; dataRoot: string;
  javaMajorOverride?: number;
  onProgress?: (p: { stage: string; pct?: number; file?: string }) => void;
  includeOptional?: (filePath: string) => boolean;
}
export interface InstallModrinthResult { installed: number; skippedOptional: number; skippedUnsupported: number; warnings: string[]; fixes: AutoFixEntry[]; launch: { exe: string; args: string[] } }

export async function installModrinth(o: InstallModrinthOpts): Promise<InstallModrinthResult> {
  const { kind, ver, mc } = splitDeps(o.index);
  if (!kind) throw new Error(`no supported loader in dependencies: ${JSON.stringify(o.index.dependencies)}`);
  const javaMajor = o.javaMajorOverride ?? await requiredJavaMajor(mc);
  o.onProgress?.({ stage: `resolving Java ${javaMajor}`, pct: 2 });
  const runtimeRoot = path.join(o.dataRoot, 'runtime');
  const rt = await ensureJava(javaMajor, runtimeRoot, o.cacheDir);

  if (fs.existsSync(o.dir)) throw new Error(`dir already exists: ${o.dir}`);
  fs.mkdirSync(o.dir, { recursive: true });
  o.onProgress?.({ stage: `installing ${kind} ${ver}`, pct: 5 });
  await installLoader(kind, o.dir, mc, ver ?? '', rt.javapath, o.cacheDir);

  const result: InstallModrinthResult = { installed: 0, skippedOptional: 0, skippedUnsupported: 0, warnings: [], fixes: [], launch: { exe: '', args: [] } };
  const curated: CuratedResolver = makeCuratedResolver({ platform: 'modrinth', packSlug: o.slug, presentPaths: o.index.files.map(f => f.path) });
  const total = o.index.files.length;
  for (const f of o.index.files) {
    const declared = f.env?.server ?? 'required';
    const v = curated.resolve(f.path, declared);
    let env = v.env;
    if (env === 'optional') env = o.includeOptional?.(f.path) ? 'required' : 'optional';
    if (env === 'unsupported') { result.skippedUnsupported++; if (v.why !== 'declared') result.warnings.push(`${f.path}: ${v.why}`); continue; }
    if (env === 'optional') { result.skippedOptional++; continue; }
    await download(f.downloads[0], path.join(o.dir, f.path), { sha1: f.hashes?.sha1, sha512: f.hashes?.sha512, size: f.fileSize });
    result.installed++;
    if (result.installed % 25 === 0) o.onProgress?.({ stage: `downloading files ${result.installed}/${total}`, pct: 5 + Math.round(85 * result.installed / total) });
  }

  o.onProgress?.({ stage: 'applying overrides', pct: 92 });
  const ov = await extractZip(o.mrpackPath, o.dir, {
    root: 'overrides/', skipExisting: true,
    excludeFn: rel => /^mods\/.*\.jar$/i.test(rel) && curated.resolve(rel, 'required').env === 'unsupported',
  });
  result.warnings.push(...ov.excluded.map(e => `overrides excluded: ${e}`));

  result.launch = launchCommand(o.dir, rt.javapath);
  log(`[modrinth] ${o.index.name}: ${result.installed} files, ${result.skippedOptional} optional, ${result.skippedUnsupported} unsupported`);
  return result;
}
