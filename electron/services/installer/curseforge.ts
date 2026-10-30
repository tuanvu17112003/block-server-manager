// CurseForge module — keyless route A/B + official-API key mode (one-click serverPackFileId).
// TS port of the proven spike (curseforge.mjs). Policy: D-25 (official first when key configured,
// keyless 2 req/s cap in core, no enumeration, CDN fetch needs no key).
import path from 'node:path';
import fs from 'node:fs';
import {
  download, downloadFirstAvailable, fetchTrusted, extractZip, readZipEntry, listZip, ensureJava,
  installLoader, runInstaller, launchCommand, requiredJavaMajor, log, writeEula,
  CURSEFORGE_ALLOWED_HOSTS, UA, type Cancelable, type DownloadCandidate, type LoaderKind,
} from './core';
import { makeCuratedResolver } from './curated';
import { appError } from '../store';

const BASE = 'https://www.curseforge.com/api/v1';
const OFFICIAL = 'https://api.curseforge.com/v1';

let _key: string | null | undefined;
/**
 * CurseForge key resolution (D11): the Settings store keeps the key OS-encrypted via safeStorage with
 * a plaintext fallback. Lazy-required so unit tests (plain Node, no Electron) still load this module.
 */
export function cfKey(dataRoot: string): string | null {
  if (_key !== undefined) return _key;
  try {
    const { curseForgeKeySync } = require('../secrets') as typeof import('../secrets');
    _key = curseForgeKeySync(dataRoot);
  } catch {
    try { _key = fs.readFileSync(path.join(dataRoot, 'curseforge-key.txt'), 'utf8').trim() || null; } catch { _key = null; }
  }
  return _key;
}

/** The Settings UI can change the key at runtime; drop the per-process cache after a key change. */
export function resetCurseForgeKeyCache(): void { _key = undefined; }

async function official(dataRoot: string, pathname: string, opts: Cancelable = {}): Promise<unknown> {
  const key = cfKey(dataRoot);
  if (!key) return null;
  const r = await fetchTrusted(OFFICIAL + pathname, CURSEFORGE_ALLOWED_HOSTS, {
    signal: opts.signal,
    headers: { 'x-api-key': key, 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`official API HTTP ${r.status} for ${pathname}`);
  return r.json();
}

/**
 * The fields this module reads from a CurseForge file record.
 *
 * `fileDate` is declared rather than cast at the use site: it is what the version picker shows as the publication date, and
 * an undeclared optional field silently loses its type checking (a typo yields an empty date instead of a compile error).
 */
interface CfFileMeta {
  id: number;
  displayName?: string;
  fileName?: string;
  fileLength?: number;
  gameVersions?: string[];
  serverPackFileId?: number;
  fileDate?: string;
}
async function fileMetadata(projectId: number, fileId: number, opts: Cancelable = {}): Promise<CfFileMeta> {
  const r = await fetchTrusted(`${BASE}/mods/${projectId}/files/${fileId}`, CURSEFORGE_ALLOWED_HOSTS, {
    signal: opts.signal,
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`cf metadata HTTP ${r.status}`);
  const j = await r.json() as { data: CfFileMeta | null };
  if (!j.data) throw new Error(`cf metadata empty for ${fileId}`);
  return j.data;
}

/** Ordered keyless download candidates for one CF file (endpoint, then CDN mirrors). */
export function curseforgeDownloadCandidates(projectId: number, fileId: number, fileName?: string): DownloadCandidate[] {
  const candidates: DownloadCandidate[] = [{ url: `${BASE}/mods/${projectId}/files/${fileId}/download` }];
  if (fileName && Number.isInteger(fileId) && fileId > 0) {
    const folder = Math.floor(fileId / 1000);
    const remainder = fileId % 1000;
    candidates.push({ url: `https://edge.forgecdn.net/files/${folder}/${remainder}/${encodeURIComponent(fileName)}` });
    candidates.push({ url: `https://mediafilez.forgecdn.net/files/${folder}/${remainder}/${encodeURIComponent(fileName)}` });
  }
  return candidates;
}

async function downloadFile(projectId: number, fileId: number, dest: string, opts: { size?: number; fileName?: string; signal?: AbortSignal } = {}): Promise<void> {
  const candidates = curseforgeDownloadCandidates(projectId, fileId, opts.fileName).map(candidate => ({ ...candidate, size: opts.size }));
  await downloadFirstAvailable(candidates, { dest, allowedHosts: CURSEFORGE_ALLOWED_HOSTS, signal: opts.signal });
}
const isClientOnly = (gameVersions: string[] | undefined): boolean => !!gameVersions?.includes('Client') && !gameVersions.includes('Server');

// ---- official API key mode: project → latest file → serverPackFileId ----
export interface CfProjectMeta {
  projectId: number;
  name: string;
  minecraftVersion: string | null;
  loader: LoaderKind | null;
  loaderVersion: string | null;
  hasServerPack: boolean;
}

function loaderFromGameVersions(gameVersions: string[] | undefined): LoaderKind | null {
  const tags = gameVersions ?? [];
  if (tags.includes('NeoForge')) return 'neoforge';
  if (tags.includes('Fabric')) return 'fabric';
  if (tags.includes('Quilt')) return 'quilt';
  if (tags.includes('Forge')) return 'forge';
  return null;
}

/**
 * Pick the Minecraft version a CurseForge file targets.
 *
 * CF files often list several MC tags for one build (DawnCraft: `1.18.1, 1.18, Forge, 1.18.2,
 * 1.18-Snapshot`). Taking the first numeric tag gave `1.18.1` and installed the 1.18.1 Forge
 * loader for a 1.18.2 pack — Forge then died with `ClassNotFoundException:
 * JarInJarDependencyLocator` during boot. The author's *target* is the most specific stable
 * release tag: prefer the highest non-snapshot `x.y.z`, and only fall back to a bare `x.y`.
 */
export function pickMinecraftVersion(tags: string[] | undefined): string | null {
  const versions = (tags ?? [])
    .filter((tag) => /^\d+\.\d+(?:\.\d+)?$/.test(tag))
    .map((tag) => ({ raw: tag, parts: tag.split('.').map(Number) }));
  if (versions.length === 0) return null;
  const stable = versions.filter((v) => !(tags ?? []).some((t) => /snapshot/i.test(t) && t.startsWith(v.raw)));
  const pool = stable.length > 0 ? stable : versions;
  pool.sort((a, b) => {
    for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i += 1) {
      const diff = (b.parts[i] ?? 0) - (a.parts[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
  return pool[0]!.raw;
}

/**
 * Describe a CurseForge project, optionally for one specific published file.
 *
 * `fileId` matters for more than naming. This function supplies the loader, Minecraft version and source name used by the
 * preview, so resolving "newest" while the user pinned an older file made the review panel describe a different pack than
 * the one that would be installed — reported as "the review shows the latest version instead of the one I chose". The
 * install path already honoured fileId; the preview did not, so the two disagreed.
 *
 * When `fileId` is absent the newest file is used, preserving the previous behaviour for callers with no choice to express.
 */
export async function inspectCurseForgeProject(
  ref: number | string,
  dataRoot: string,
  fileId?: number,
): Promise<CfProjectMeta> {
  if (!cfKey(dataRoot)) throw appError('validation', 'A CurseForge API key is required for one-click installs. Add it in Settings → CurseForge API key (it is stored securely, no file editing needed).');
  const raw = String(ref).trim();
  let projectId = Number(raw);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    // Accept a project URL, a slug, or a raw id; the official search resolves the slug.
    const slug = (raw.match(/\/modpacks\/([^/?#]+)/i)?.[1] ?? raw).replace(/[^a-z0-9_-]/gi, '');
    if (slug === '') throw new Error('Enter a CurseForge project URL, slug or numeric id.');
    const found = await official(dataRoot, `/mods/search?gameId=432&classId=4471&slug=${encodeURIComponent(slug)}&pageSize=1`) as { data?: { id?: number }[] } | null;
    projectId = Number(found?.data?.[0]?.id ?? 0);
    if (!Number.isInteger(projectId) || projectId <= 0) throw new Error(`CurseForge project "${raw}" was not found.`);
  }

  // Resolve the file the caller asked for, or fall back to the newest one.
  let meta: CfFileMeta;
  if (fileId !== undefined) {
    const detail = await official(dataRoot, `/mods/${projectId}/files/${fileId}`) as { data?: CfFileMeta } | null;
    if (detail?.data === undefined) {
      throw new Error(`CurseForge file ${fileId} of project ${projectId} could not be read.`);
    }
    meta = detail.data;
  } else {
    const list = await official(dataRoot, `/mods/${projectId}/files?pageSize=1&index=0`) as { data?: CfFileMeta[] } | null;
    const latest = list?.data?.[0];
    if (!latest) throw new Error(`CurseForge project ${projectId} has no files.`);
    const detail = await official(dataRoot, `/mods/${projectId}/files/${latest.id}`) as { data?: CfFileMeta } | null;
    meta = detail?.data ?? latest;
  }
  const tags = meta.gameVersions ?? [];
  let loader: LoaderKind | null = loaderFromGameVersions(tags);

  // Publishers sometimes publish a file with an incomplete gameVersions list: RLCraft's newest file
  // (4612979) carries only ["1.12.2"] — no "Forge" tag — while the previous file has it. Rather than
  // guessing a loader, read the recent files of the *same project* and take the loader the author has
  // tagged on other files for the same Minecraft version. Still detection, not assumption: if no
  // sibling file agrees, `loader` stays null and the caller fails closed.
  if (!loader) {
    try {
      const siblings = await official(dataRoot, `/mods/${projectId}/files?pageSize=20&index=0`) as { data?: CfFileMeta[] } | null;
      const mc = pickMinecraftVersion(tags);
      const agreeing = (siblings?.data ?? [])
        .filter((file) => file.id !== meta.id)
        .map((file) => ({
          loader: loaderFromGameVersions(file.gameVersions),
          sameMc: mc !== null && (file.gameVersions ?? []).includes(mc),
        }))
        .filter((row): row is { loader: LoaderKind; sameMc: boolean } => row.loader !== null && row.sameMc);
      if (agreeing.length > 0) {
        loader = agreeing[0]!.loader;
        log(`[curseforge] project ${projectId}: newest file has no loader tag; using "${loader}" from ${agreeing.length} sibling file(s) on the same MC version`);
      }
    } catch { /* keep loader null and fail closed below */ }
  }

  return {
    projectId,
    name: meta.displayName ?? meta.fileName ?? `CurseForge ${projectId}`,
    minecraftVersion: pickMinecraftVersion(tags),
    loader,
    loaderVersion: null,
    hasServerPack: meta.serverPackFileId !== undefined && meta.serverPackFileId !== null,
  };
}

/**
 * One selectable version of a CurseForge project.
 *
 * `hasServerPack` is the field that matters for installs. CurseForge authors publish an optional server pack alongside a
 * client pack, and the two are NOT interchangeable:
 *
 *  - a server pack is a ready-to-run server (world config, run scripts, server-side mod set)
 *  - a client pack is a manifest whose mods have to be resolved, and it contains client-only mods that must not run on a
 *    server
 *
 * Downloading the client pack when a server pack exists produces a server that either fails to boot or silently loads
 * client-only mods. Downloading a server pack when none exists is impossible, so the choice has to be made per version —
 * which is why the installer now exposes the flag instead of always taking "latest file".
 */
export interface CfVersionChoice {
  fileId: number;
  displayName: string;
  fileName: string | null;
  publishedAt: string | null;
  minecraftVersion: string | null;
  loader: LoaderKind | null;
  /** True when this exact file has a server pack published alongside it. */
  hasServerPack: boolean;
  /** The id of that server pack file, when present. */
  serverPackFileId: number | null;
  /** Human-readable size of the download, when CurseForge reports one. */
  fileLength: number | null;
}

/**
 * List the published versions of a CurseForge project, newest first, each with its server-pack availability.
 *
 * Requires the API key: the keyless routes cannot enumerate files for a project. When no key is configured the caller is
 * told explicitly rather than silently falling back to "latest", because that fallback is exactly what installed client
 * packs where server packs existed.
 */
export async function listCurseForgeVersions(
  projectRef: number | string,
  dataRoot: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<CfVersionChoice[]> {
  if (!cfKey(dataRoot)) {
    throw appError(
      'validation',
      'Listing CurseForge versions needs an API key. Add one in Settings → CurseForge API key, or install from a '
      + 'project URL / server pack ZIP instead.',
    );
  }
  const limit = options.limit ?? 30;
  const raw = String(projectRef).trim();
  let projectId = Number(raw);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    const slug = (raw.match(/\/modpacks\/([^/?#]+)/i)?.[1] ?? raw).replace(/[^a-z0-9_-]/gi, '');
    if (slug === '') throw new Error('Enter a CurseForge project URL, slug or numeric id.');
    const found = await official(dataRoot, `/mods/search?gameId=432&classId=4471&slug=${encodeURIComponent(slug)}&pageSize=1`, options.signal ? { signal: options.signal } : {}) as { data?: { id?: number }[] } | null;
    projectId = Number(found?.data?.[0]?.id ?? 0);
    if (projectId <= 0) throw new Error(`CurseForge project "${raw}" was not found.`);
  }

  const list = await official(
    dataRoot,
    `/mods/${projectId}/files?pageSize=${limit}&index=0`,
    options.signal ? { signal: options.signal } : {},
  ) as { data?: CfFileMeta[] } | null;

  return (list?.data ?? []).map((file) => {
    const tags = file.gameVersions ?? [];
    const serverPackFileId = file.serverPackFileId !== undefined && file.serverPackFileId !== null
      ? Number(file.serverPackFileId)
      : null;
    return {
      fileId: Number(file.id),
      displayName: file.displayName ?? file.fileName ?? `File ${String(file.id)}`,
      fileName: file.fileName ?? null,
      publishedAt: file.fileDate ?? null,
      minecraftVersion: pickMinecraftVersion(tags),
      loader: loaderFromGameVersions(tags),
      hasServerPack: serverPackFileId !== null,
      serverPackFileId,
      fileLength: typeof file.fileLength === 'number' ? file.fileLength : null,
    };
  });
}

// ---- official API key mode: in-app modpack browsing ----
export interface CfModpackHit {
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

export interface CfModpackSearchResult {
  hits: CfModpackHit[];
  totalHits: number;
  offset: number;
  limit: number;
}

export type CfModpackSort = 'popularity' | 'recent' | 'name' | 'downloads';

const CF_SORT_FIELDS: Record<CfModpackSort, number> = {
  popularity: 2, // total downloads (popularity)
  recent: 3, // last updated
  name: 4,
  downloads: 6, // total downloads field
};

/** Pure mapping of the official `/mods/search` payload; tolerant of missing optional fields. */
export function mapCurseForgeSearchPayload(payload: unknown, offset: number, limit: number): CfModpackSearchResult {
  const body = (payload ?? {}) as {
    data?: unknown;
    pagination?: { totalCount?: unknown };
  };
  const rows = Array.isArray(body.data) ? body.data : [];
  const hits: CfModpackHit[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as {
      id?: unknown; name?: unknown; slug?: unknown; summary?: unknown;
      downloadCount?: unknown; dateModified?: unknown;
      logo?: { thumbnailUrl?: unknown } | null;
      links?: { websiteUrl?: unknown } | null;
      authors?: { name?: unknown }[] | null;
    };
    const projectId = Number(row.id);
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!Number.isInteger(projectId) || projectId <= 0 || name === '') continue;
    const authorRow = Array.isArray(row.authors) ? row.authors.find((entry) => typeof entry?.name === 'string') : undefined;
    hits.push({
      projectId,
      name,
      slug: typeof row.slug === 'string' ? row.slug : '',
      summary: typeof row.summary === 'string' ? row.summary : '',
      author: authorRow && typeof authorRow.name === 'string' ? authorRow.name : null,
      downloads: Number.isFinite(Number(row.downloadCount)) ? Number(row.downloadCount) : 0,
      updatedAt: typeof row.dateModified === 'string' ? row.dateModified : null,
      iconUrl: row.logo && typeof row.logo.thumbnailUrl === 'string' ? row.logo.thumbnailUrl : null,
      websiteUrl: row.links && typeof row.links.websiteUrl === 'string' ? row.links.websiteUrl : null,
    });
  }
  const total = Number(body.pagination?.totalCount);
  return { hits, totalHits: Number.isFinite(total) && total >= 0 ? total : hits.length, offset, limit };
}

/**
 * In-app CurseForge modpack browsing (official API; requires a user key stored by Settings).
 * `classId=4471` is the official "Modpacks" class; `gameId=432` is Minecraft.
 */
export async function searchCurseForgeModpacks(
  query: string,
  dataRoot: string,
  options: { offset?: number; limit?: number; sort?: CfModpackSort } = {},
): Promise<CfModpackSearchResult> {
  if (!cfKey(dataRoot)) {
    throw appError('validation', 'A CurseForge API key is required to browse modpacks in-app. Add it in Settings → CurseForge API key.');
  }
  const offset = Number.isFinite(Number(options.offset)) ? Math.max(0, Math.floor(Number(options.offset))) : 0;
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.min(50, Math.floor(Number(options.limit)))) : 20;
  const sort: CfModpackSort = options.sort && CF_SORT_FIELDS[options.sort] ? options.sort : 'popularity';
  const params = new URLSearchParams({
    gameId: '432',
    classId: '4471',
    searchFilter: String(query ?? '').trim(),
    index: String(offset),
    pageSize: String(limit),
    sortField: String(CF_SORT_FIELDS[sort]),
    sortOrder: 'desc',
  });
  const payload = await official(dataRoot, `/mods/search?${params.toString()}`);
  if (payload === null) {
    throw appError('validation', 'The CurseForge API rejected the request (check the key in Settings → CurseForge API key).');
  }
  return mapCurseForgeSearchPayload(payload, offset, limit);
}

// ---- staged ZIP inspection (route A classify → UI DTO) ----
export interface CfInspection { name: string; classification: 'supportedServerPack' | 'clientExport' | 'unsupported'; reason: string; minecraftVersion: string | null; loader: string | null; loaderVersion: string | null; /** Set when this ZIP is a thin wrapper around one nested server-pack ZIP. */ nestedZip?: string }

/** A ZIP is a wrapper when it has exactly one entry that is itself a `.zip` and carries no pack content. */
export function findNestedServerPackZip(entries: { name: string }[]): string | null {
  const files = entries.filter((e) => !e.name.endsWith('/'));
  const nested = files.filter((e) => /\.zip$/i.test(e.name));
  if (nested.length !== 1) return null;
  const rest = files.filter((e) => !/\.zip$/i.test(e.name));
  // Tolerate a readme/licence alongside the payload (Prominence II ships `readme.txt`).
  const harmless = rest.every((e) => /\.(txt|md|html?|url|json)$/i.test(e.name));
  return harmless ? nested[0]!.name : null;
}

export async function inspectStagedZip(zipPath: string): Promise<CfInspection> {
  const name = path.basename(zipPath);
  let entries: { name: string }[] = [];
  try { entries = await listZip(zipPath); } catch (e) { return { name, classification: 'unsupported', reason: `unreadable zip: ${(e as Error).message}`, minecraftVersion: null, loader: null, loaderVersion: null }; }
  const names = entries.map(e => e.name);

  // ADR-0013: a single nested-ZIP wrapper around a recognized format is supported. Unwrap it to a
  // sibling file and classify the real payload (Prominence II CF ships exactly this shape).
  if (!names.includes('manifest.json')) {
    const nested = findNestedServerPackZip(entries);
    if (nested) {
      const innerPath = `${zipPath}.inner-${Date.now()}.zip`;
      try {
        fs.writeFileSync(innerPath, await readZipEntry(zipPath, nested));
        const inner = await inspectStagedZip(innerPath);
        return {
          ...inner,
          name,
          reason: `${inner.reason} (unwrapped from nested ZIP "${nested}")`,
          nestedZip: nested,
        };
      } catch (e) {
        return { name, classification: 'unsupported', reason: `nested ZIP "${nested}" could not be read: ${(e as Error).message}`, minecraftVersion: null, loader: null, loaderVersion: null };
      } finally {
        try { fs.rmSync(innerPath, { force: true }); } catch { /* best effort */ }
      }
    }
  }

  const hasManifest = names.includes('manifest.json');
  if (hasManifest) {
    try {
      const m = JSON.parse((await readZipEntry(zipPath, 'manifest.json')).toString('utf8')) as { minecraft?: { version?: string; modLoaders?: { id?: string }[] } };
      // Only the real CurseForge schema counts. ServerPackCreator packs ship their own
      // `manifest.json` that is a flat list of file paths — reading `minecraft.modLoaders` off it
      // threw a TypeError and aborted the install instead of falling through to layout detection.
      if (m && typeof m === 'object' && m.minecraft && typeof m.minecraft === 'object' && Array.isArray(m.minecraft.modLoaders)) {
        const loaderId = m.minecraft.modLoaders.find(l => l.id)?.id ?? '';
        const [loader, ver] = loaderId.split('-');
        return { name, classification: 'clientExport', reason: 'CurseForge client pack (manifest.json) — mods are resolved keylessly from the manifest; client-only files are skipped.', minecraftVersion: m.minecraft.version ?? null, loader: loader ?? null, loaderVersion: ver ?? null };
      }
      // Not a CurseForge manifest: fall through to server-pack layout detection below.
    } catch { return { name, classification: 'unsupported', reason: 'manifest.json is not parseable.', minecraftVersion: null, loader: null, loaderVersion: null }; }
  }
  // server-pack heuristics (route A, spike-proven)
  const hasMods = names.some(n => /^mods\//.test(n));
  const prebuilt = names.some(n => /user_jvm_args\.txt/.test(n)) || names.some(n => /^libraries\//.test(n)) || names.some(n => /fabric-server-launch|quilt-server-launch/.test(n));
  const shippedInstaller = names.some(n => /^forge-.*-installer\.jar$/i.test(n) || /^neoforge-.*-installer\.jar$/i.test(n));
  if (hasMods || prebuilt || shippedInstaller) {
    let minecraftVersion: string | null = null, loader: string | null = null, loaderVersion: string | null = null;
    if (prebuilt) {
      loader = names.some(n => /fabric-server-launch/.test(n)) ? 'Fabric' : names.some(n => /quilt-server-launch/.test(n)) ? 'Quilt' : 'Forge';
      loaderVersion = null;
    } else if (shippedInstaller) {
      const jar = names.find(n => /^forge-.*-installer\.jar$/i.test(n)) ?? '';
      loader = 'Forge';
      loaderVersion = jar.replace(/^forge-/, '').replace(/-installer\.jar$/i, '');
      const mMatch = loaderVersion.match(/^(\d+\.\d+(?:\.\d+)?)-/);
      minecraftVersion = mMatch ? mMatch[1] : null;
    }
    // Prebuilt packs hide their exact metadata in `libraries/` (Forge `forge-<mc>-<ver>`,
    // `libraries/net/minecraft/server/<mc>/`) or in a shipped installer name. Without this a
    // perfectly runnable prebuilt pack was rejected as "blank metadata" and could never install.
    const inferred = inferServerPackMetadata(names);
    if (inferred) {
      loader = loader ?? inferred.loader;
      loaderVersion = loaderVersion ?? inferred.loaderVersion;
      minecraftVersion = minecraftVersion ?? inferred.mc;
    }
    return { name, classification: 'supportedServerPack', reason: prebuilt ? 'Prebuilt server pack (loader included).' : shippedInstaller ? 'Server pack with a bundled loader installer.' : 'Plain server pack (loader will be installed).', minecraftVersion, loader, loaderVersion };
  }
  return { name, classification: 'unsupported', reason: 'No mods/, loader artifacts, or installer recognized.', minecraftVersion: null, loader: null, loaderVersion: null };
}

// ---- install engine ----
/**
 * A server-pack folder that already contains a runnable server (prebuilt) needs no loader install.
 * Shapes verified against real packs (serverpack-tools.md §3): Forge/NeoForge `run.bat`/`libraries`,
 * Fabric/Quilt `*-server-launch*.jar`, old Forge universal jar, or a plain vanilla `server.jar`
 * without mod/plugin folders.
 */
export function packShipsRunnableServer(dir: string): boolean {
  try {
    const rootEntries = fs.readdirSync(dir);
    // Strong launch evidence only: a generated launch script alone (or a sample user_jvm_args.txt)
    // is not enough — Forge/NeoForge server packs may ship those next to the installer they still
    // need executed. `libraries/` plus a launch marker is what a completed install leaves behind.
    if (fs.existsSync(path.join(dir, 'libraries'))) return true;
    if (rootEntries.some((name) => /^(fabric|quilt)-server-launch.*\.jar$/i.test(name))) return true;
    if (rootEntries.some((name) => /^forge-\d+\.\d+(?:\.\d+)?-[\d.]+(?:-universal)?\.jar$/i.test(name))) return true;
    const hasLoaderInstaller = rootEntries.some((name) => /^(forge|neoforge)-.*-installer\.jar$/i.test(name));
    return !hasLoaderInstaller
      && fs.existsSync(path.join(dir, 'server.jar'))
      && !fs.existsSync(path.join(dir, 'mods'))
      && !fs.existsSync(path.join(dir, 'plugins'));
  } catch {
    return false;
  }
}

export interface InstallCfOpts extends Cancelable {
  projectId?: number; zipPath?: string; dir: string; dataRoot: string; cacheDir: string;
  /**
   * A specific published file to install, from the version picker.
   *
   * When present the engine downloads exactly this file instead of resolving "newest". It must still prefer that file's
   * server pack: a version chosen for its server pack is useless if the engine than fetches the client pack of the same
   * version and resolves its manifest.
   */
  fileId?: number;
  onProgress?: (p: { stage: string; pct?: number }) => void;
  /** Metadata already resolved from the official API (the archive itself may carry none). */
  knownLoader?: LoaderKind | null;
  knownMc?: string | null;
  knownLoaderVersion?: string | null;
}
export interface InstallCfResult { route: 'A' | 'B'; installed: number; skippedClientOnly: number; skippedOptional: number; manuallyRequired: { projectId: number; fileId: number; pageUrl: string; reason: string }[]; warnings: string[]; loader: LoaderKind | null; loaderVersion: string | null; mc: string | null }

interface CfManifest { manifestType: string; manifestVersion: number; minecraft: { version: string; modLoaders: { id: string; primary?: boolean }[] }; files?: { projectID: number; fileID: number; required?: boolean }[]; name?: string }

/** Infer loader/MC/version from server-pack archive contents when no manifest.json exists (WP-4.5). */
export function inferServerPackMetadata(entryNames: string[]): { loader: LoaderKind; mc: string; loaderVersion: string | null } | null {
  const names = entryNames.map((name) => name.replace(/\\/g, '/'));
  // `forge-<mc>-<forgeVer>-installer.jar` / `neoforge-<mc>-<ver>-installer.jar`
  for (const name of names) {
    const match = name.match(/(?:^|\/)(forge|neoforge)-(\d+\.\d+(?:\.\d+)?)-([\d.]+)-installer\.jar$/i);
    if (match) return { loader: match[1]!.toLowerCase() as LoaderKind, mc: match[2]!, loaderVersion: match[3]! };
  }
  // Legacy maven layout inside the pack: libraries/net/minecraftforge/forge/<mc>-<ver>/
  for (const name of names) {
    const legacy = name.match(/libraries\/net\/minecraftforge\/forge\/(\d+\.\d+(?:\.\d+)?)-([\d.]+)(?:\/|$)/i);
    if (legacy) return { loader: 'forge', mc: legacy[1]!, loaderVersion: legacy[2]! };
  }
  // Fabric/Quilt launch jar + vanilla server jar naming.
  const fabric = names.some((name) => /fabric-server-launch\.jar$/i.test(name));
  const quilt = names.some((name) => /quilt-server-launch\.jar$/i.test(name));
  for (const name of names) {
    const vanilla = name.match(/(?:^|\/)(?:server|minecraft_server)\.(\d+\.\d+(?:\.\d+)?)\.jar$/i)
      ?? name.match(/libraries\/net\/minecraft\/server\/(\d+\.\d+(?:\.\d+)?)\//i);
    if (vanilla) return { loader: quilt ? 'quilt' : fabric ? 'fabric' : 'vanilla', mc: vanilla[1]!, loaderVersion: null };
  }
  return null;
}

export async function installCurseforge(o: InstallCfOpts): Promise<InstallCfResult> {
  const { signal } = o;
  const result: InstallCfResult = { route: 'A', installed: 0, skippedClientOnly: 0, skippedOptional: 0, manuallyRequired: [], warnings: [], loader: null, loaderVersion: null, mc: null };
  let clientZip = o.zipPath ?? null;

  // Key-mode download. When the caller supplied a fileId, THAT file is resolved; otherwise the newest file is used.
  //
  // This is the difference between a version control that works and one that is cosmetic. Choosing a version in the UI and
  // then having the engine re-derive "newest" would install a different pack than the one on screen — and the whole reason
  // the picker exists is that the newest file often has no server pack while an older one does.
  if (!clientZip && o.projectId && cfKey(o.dataRoot)) {
    try {
      const chosen = o.fileId !== undefined
        ? await official(o.dataRoot, `/mods/${o.projectId}/files/${o.fileId}`, { signal }) as { data?: CfFileMeta } | null
        : null;
      let file: CfFileMeta | undefined = chosen?.data;
      if (file === undefined) {
        if (o.fileId !== undefined) {
          throw new Error(`the chosen version (file ${o.fileId}) could not be read from CurseForge`);
        }
        const list = await official(o.dataRoot, `/mods/${o.projectId}/files?pageSize=1&index=0`, { signal }) as { data?: CfFileMeta[] } | null;
        file = list?.data?.[0];
      }
      if (file) {
        // Prefer the server pack for the SAME version. A user who picked a version for its server pack must not receive the
        // client pack of that version instead.
        const sp = file.serverPackFileId;
        if (sp) {
          const du = await official(o.dataRoot, `/mods/${o.projectId}/files/${sp}/download-url`, { signal }) as { data?: unknown } | null;
          const url = typeof du?.data === 'string' ? du.data : (du?.data as { downloadUrl?: string } | undefined)?.downloadUrl;
          const meta = await official(o.dataRoot, `/mods/${o.projectId}/files/${sp}`, { signal }) as { data?: CfFileMeta } | null;
          if (url) {
            const dest = path.join(o.cacheDir, 'cfpack', `${o.projectId}-server-${sp}.zip`);
            await downloadFirstAvailable([{ url, size: meta?.data?.fileLength }], {
              dest, allowedHosts: CURSEFORGE_ALLOWED_HOSTS, signal,
            });
            clientZip = dest;
            log(`[curseforge] key mode: server pack "${meta?.data?.displayName}" via serverPackFileId`);
          }
        } else {
          log(
            o.fileId !== undefined
              ? `[curseforge] key mode: chosen file ${o.fileId} has no server pack — downloading it directly`
              : '[curseforge] key mode: no serverPackFileId — falling back to client pack',
          );
          // A chosen file with no server pack is still a legitimate install (the user saw "client pack only"). Download the
          // chosen file itself rather than silently switching to another version's server pack.
          if (o.fileId !== undefined) {
            const dest = path.join(o.cacheDir, 'cfpack', `${o.projectId}-${o.fileId}.zip`);
            await downloadFile(o.projectId, o.fileId, dest, { size: file.fileLength, fileName: file.fileName, signal });
            clientZip = dest;
          }
        }
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      log(`[curseforge] key mode unavailable (${(e as Error).message}) — falling back to keyless`);
    }
  }

  if (!clientZip && o.projectId) {
    // Keyless fallback. It honours fileId too: the keyless CDN route can fetch a specific file id, and ignoring the
    // user's choice here would make the picker behave differently depending on whether an API key happens to be saved.
    const targetId = o.fileId;
    const fileUrl = targetId !== undefined
      ? `${BASE}/mods/${o.projectId}/files/${targetId}`
      : `${BASE}/mods/${o.projectId}/files?pageSize=1&index=0`;
    const r = await fetchTrusted(fileUrl, CURSEFORGE_ALLOWED_HOSTS, {
      signal, headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`cf files HTTP ${r.status}`);
    const j = await r.json() as { data: CfFileMeta | CfFileMeta[] };
    const latest = Array.isArray(j.data) ? j.data[0] : j.data;
    if (!latest) throw new Error('no files');
    clientZip = path.join(o.cacheDir, 'cfpack', `${o.projectId}-${latest.id}.zip`);
    await downloadFile(o.projectId, latest.id, clientZip, { size: latest.fileLength, fileName: latest.fileName, signal });
  }
  if (!clientZip) throw new Error('no CurseForge archive provided');
  if (fs.existsSync(o.dir)) throw new Error(`dir already exists: ${o.dir}`);

  const entries = await listZip(clientZip);
  const names = entries.map(e => e.name);
  let hasManifest = names.includes('manifest.json');

  // ADR-0013: unwrap a single nested-ZIP wrapper (Prominence II CF ships one) so the engine sees the
  // real server pack. The unwrapped file lives beside the cache entry and is removed after install.
  let innerZipPath: string | null = null;
  if (!hasManifest) {
    const nested = findNestedServerPackZip(entries);
    if (nested) {
      innerZipPath = path.join(o.cacheDir, 'cfpack', `.inner-${Date.now()}-${path.basename(nested)}`);
      fs.mkdirSync(path.dirname(innerZipPath), { recursive: true });
      fs.writeFileSync(innerZipPath, await readZipEntry(clientZip, nested));
      log(`[curseforge] unwrapped nested server pack "${nested}" from ${path.basename(clientZip)}`);
      clientZip = innerZipPath;
      const innerEntries = await listZip(clientZip);
      names.length = 0;
      names.push(...innerEntries.map(e => e.name));
      hasManifest = names.includes('manifest.json');
    }
  }

  let manifest: CfManifest | null = null, kind: LoaderKind | null = null, ver: string | null = null, mc: string | null = null, packName = path.basename(clientZip, '.zip');
  if (hasManifest) {
    const parsed = JSON.parse((await readZipEntry(clientZip, 'manifest.json')).toString('utf8')) as CfManifest;
    // Distinguish the real CurseForge manifest from ServerPackCreator's flat file-list manifest.
    const isCurseForgeManifest = !!parsed && typeof parsed === 'object'
      && !!parsed.minecraft && typeof parsed.minecraft === 'object'
      && Array.isArray(parsed.minecraft.modLoaders);
    if (!isCurseForgeManifest) {
      // ServerPackCreator / generic manifest: treat as a plain server pack and detect from layout.
      hasManifest = false;
    } else {
      manifest = parsed;
      const primary = manifest.minecraft.modLoaders.find(l => l.primary) ?? manifest.minecraft.modLoaders[0];
      const idm = primary?.id?.match(/^(fabric|quilt|forge|neoforge)-(.+)$/);
      if (!idm) throw new Error(`unsupported modLoader id: ${primary?.id}`);
      kind = idm[1] as LoaderKind; ver = idm[2]; mc = manifest.minecraft.version; packName = manifest.name ?? packName;
      result.route = 'B';
    }
  }
  if (!hasManifest) {
    kind = names.some(n => /fabric-server-launch/.test(n)) ? 'fabric'
      : names.some(n => /quilt-server-launch/.test(n)) ? 'quilt' : 'forge';
    ver = null; mc = null;
    // WP-4.5: server packs without manifest.json still identify their loader/MC through the
    // shipped installer JAR name (e.g. forge-1.20.1-47.4.0-installer.jar) or the maven layout.
    const inferred = inferServerPackMetadata(names);
    if (inferred) {
      kind = inferred.loader; mc = inferred.mc; ver = inferred.loaderVersion;
      log(`[curseforge] inferred metadata from archive: ${kind} ${mc}${ver ? ` ${ver}` : ''}`);
    }
    // The archive may be a bare ServerPackCreator output (mods/ + config/ only). The official API
    // already told us the loader/MC for this project, so use that instead of failing closed on an
    // archive that legitimately carries no loader evidence of its own.
    if (!mc && o.knownMc) {
      mc = o.knownMc;
      if (!ver) ver = o.knownLoaderVersion ?? null;
      if (kind === 'forge' && o.knownLoader) kind = o.knownLoader;
      log(`[curseforge] archive carries no loader metadata; using official-API metadata: ${kind} ${mc}${ver ? ` ${ver}` : ''}`);
    }
  }
  result.loader = kind; result.loaderVersion = ver; result.mc = mc;

  // WP-4.5: a blank mcVersion is never guessed into a Java major. Java is resolved lazily, only
  // when a loader actually has to run/install; a prebuilt server pack needs no runtime to extract.
  let rt: { javapath: string } | null = null;
  const resolveJavaRuntime = async (): Promise<string> => {
    if (!mc) {
      throw appError(
        'validation',
        'CurseForge pack does not declare a Minecraft version; refusing to guess a Java runtime. '
        + 'Use a pack with manifest.json or resolve the pack metadata first.',
      );
    }
    if (!rt) {
      const javaMajor = await requiredJavaMajor(mc, { signal });
      o.onProgress?.({ stage: `resolving Java ${javaMajor}`, pct: 2 });
      rt = await ensureJava(javaMajor, path.join(o.dataRoot, 'runtime'), o.cacheDir, undefined, { signal });
    }
    return rt.javapath;
  };
  fs.mkdirSync(o.dir, { recursive: true });

  o.onProgress?.({ stage: 'extracting pack', pct: 8 });
  if (!hasManifest) {
    await extractZip(clientZip, o.dir, { root: '', skipExisting: true, signal });
  } else {
    await extractZip(clientZip, o.dir, { root: 'overrides/', skipExisting: true, signal });
  }

  // loader (M-9): prebuilt → as-is; shipped installer → run it ourselves; else from metadata.
  o.onProgress?.({ stage: `installing loader`, pct: 15 });
  const rootEntries = fs.readdirSync(o.dir);
  const shippedInstaller = rootEntries.find(f => /^(forge|neoforge)-.*-installer\.jar$/i.test(f));
  // A shipped loader installer always wins over weak run-script markers: packs like SF5 ship
  // `run.bat`/`user_jvm_args.txt` samples *and* the installer; only running the installer produces
  // the `libraries/` launch artifacts. Strong prebuilt evidence (libraries/launch jar) skips it.
  const hasPrebuiltLauncher = packShipsRunnableServer(o.dir);
  if (!hasPrebuiltLauncher) {
    const shipped = shippedInstaller;
    if (shipped) {
      log(`[curseforge] pack ships installer "${shipped}" — running --installServer ourselves`);
      await runInstaller(await resolveJavaRuntime(), path.join(o.dir, shipped), ['--installServer'], o.dir, 'shipped loader', { signal });
    } else if (mc && (kind === 'fabric' || kind === 'quilt')) {
      // Plain Fabric/Quilt server pack without manifest: loader build is resolved from provider meta.
      log(`[curseforge] installing ${kind} ${mc} loader from provider metadata (no manifest in pack)`);
      await installLoader(kind, o.dir, mc, null, await resolveJavaRuntime(), o.cacheDir, { signal });
    } else if (kind && mc && ver) {
      await installLoader(kind, o.dir, mc, ver, await resolveJavaRuntime(), o.cacheDir, { signal });
    } else if (kind && mc) {
      // Forge/NeoForge without a pinned build: resolve the provider's recommended build for this MC
      // version (the same lookup `installLoader` performs for a null version) instead of failing on a
      // pack that legitimately declares nothing — RLCraft's server pack ships only mods/ + config/.
      log(`[curseforge] installing ${kind} ${mc} loader from provider metadata (no pinned build in pack)`);
      await installLoader(kind, o.dir, mc, null, await resolveJavaRuntime(), o.cacheDir, { signal });
    } else if (!mc) {
      throw new Error(
        'This pack archive does not declare a Minecraft version and does not ship a runnable server. '
        + 'Use the author-provided SERVER pack ZIP (it contains run.bat/libraries or a loader installer), '
        + 'or a CurseForge client pack ZIP with manifest.json.',
      );
    } else {
      throw new Error(
        `${kind ?? 'unknown'} pack for Minecraft ${mc} has no manifest.json and does not ship a loader version. `
        + 'Use the author-provided SERVER pack ZIP (with its loader installer) or a client pack ZIP with manifest.json.',
      );
    }
  } else {
    log('[curseforge] pack already ships a runnable/prebuilt server — skipping loader install');
  }

  if (manifest?.files?.length) {
    const curated = makeCuratedResolver({ platform: 'curseforge', packSlug: o.projectId ? String(o.projectId) : null, presentPaths: [] });
    const total = manifest.files.length;
    for (const f of manifest.files) {
      if (f.required === false) { result.skippedOptional++; continue; }
      try {
        const meta = await fileMetadata(f.projectID, f.fileID, { signal });
        if (isClientOnly(meta.gameVersions)) { result.skippedClientOnly++; continue; }
        const fileName = meta.fileName ?? `${f.fileID}.jar`;
        if (curated.resolve(`mods/${fileName}`, 'required').env === 'unsupported') { result.skippedClientOnly++; continue; }
        await downloadFile(f.projectID, f.fileID, path.join(o.dir, 'mods', fileName), { size: meta.fileLength, fileName, signal });
        result.installed++;
        if (result.installed % 25 === 0) o.onProgress?.({ stage: `downloading mods ${result.installed}/${total}`, pct: 20 + Math.round(65 * result.installed / total) });
      } catch (e) {
        if (signal?.aborted) throw e;
        result.manuallyRequired.push({ projectId: f.projectID, fileId: f.fileID, pageUrl: `https://www.curseforge.com/minecraft/mc-mods?fileID=${f.fileID}`, reason: (e as Error).message });
      }
    }
  }
  o.onProgress?.({ stage: 'done', pct: 95 });
  // The unwrapped inner archive was scratch input only; the staged tree is what gets published.
  if (innerZipPath) { try { fs.rmSync(innerZipPath, { force: true }); } catch { /* best effort */ } }
  return result;
}
