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

interface CfFileMeta { id: number; displayName?: string; fileName?: string; fileLength?: number; gameVersions?: string[]; serverPackFileId?: number }
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

export async function inspectCurseForgeProject(ref: number | string, dataRoot: string): Promise<CfProjectMeta> {
  if (!cfKey(dataRoot)) throw new Error('CurseForge API key not configured. Put the classic key in <data-root>/curseforge-key.txt.');
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
  const list = await official(dataRoot, `/mods/${projectId}/files?pageSize=1&index=0`) as { data?: CfFileMeta[] } | null;
  const latest = list?.data?.[0];
  if (!latest) throw new Error(`CurseForge project ${projectId} has no files.`);
  const detail = await official(dataRoot, `/mods/${projectId}/files/${latest.id}`) as { data?: CfFileMeta } | null;
  const meta = detail?.data ?? latest;
  const tags = meta.gameVersions ?? [];
  return {
    projectId,
    name: meta.displayName ?? meta.fileName ?? `CurseForge ${projectId}`,
    minecraftVersion: tags.find((tag) => /^\d+\.\d+(?:\.\d+)?$/.test(tag)) ?? null,
    loader: loaderFromGameVersions(tags),
    loaderVersion: null,
    hasServerPack: meta.serverPackFileId !== undefined && meta.serverPackFileId !== null,
  };
}

// ---- staged ZIP inspection (route A classify → UI DTO) ----
export interface CfInspection { name: string; classification: 'supportedServerPack' | 'clientExport' | 'unsupported'; reason: string; minecraftVersion: string | null; loader: string | null; loaderVersion: string | null }
export async function inspectStagedZip(zipPath: string): Promise<CfInspection> {
  const name = path.basename(zipPath);
  let entries: { name: string }[] = [];
  try { entries = await listZip(zipPath); } catch (e) { return { name, classification: 'unsupported', reason: `unreadable zip: ${(e as Error).message}`, minecraftVersion: null, loader: null, loaderVersion: null }; }
  const names = entries.map(e => e.name);
  const hasManifest = names.includes('manifest.json');
  if (hasManifest) {
    try {
      const m = JSON.parse((await readZipEntry(zipPath, 'manifest.json')).toString('utf8')) as { minecraft?: { version?: string; modLoaders?: { id?: string }[] } };
      const loaderId = m.minecraft?.modLoaders?.find(l => l.id)?.id ?? '';
      const [loader, ver] = loaderId.split('-');
      return { name, classification: 'clientExport', reason: 'CurseForge client pack (manifest.json) — mods are resolved keylessly from the manifest; client-only files are skipped.', minecraftVersion: m.minecraft?.version ?? null, loader: loader ?? null, loaderVersion: ver ?? null };
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
    return { name, classification: 'supportedServerPack', reason: prebuilt ? 'Prebuilt server pack (loader included).' : shippedInstaller ? 'Server pack with a bundled loader installer.' : 'Plain server pack (loader will be installed).', minecraftVersion, loader, loaderVersion };
  }
  return { name, classification: 'unsupported', reason: 'No mods/, loader artifacts, or installer recognized.', minecraftVersion: null, loader: null, loaderVersion: null };
}

// ---- install engine ----
export interface InstallCfOpts extends Cancelable {
  projectId?: number; zipPath?: string; dir: string; dataRoot: string; cacheDir: string;
  onProgress?: (p: { stage: string; pct?: number }) => void;
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

  // key mode one-click: latest file → serverPackFileId → CDN zip (route A)
  if (!clientZip && o.projectId && cfKey(o.dataRoot)) {
    try {
      const list = await official(o.dataRoot, `/mods/${o.projectId}/files?pageSize=1&index=0`, { signal }) as { data?: CfFileMeta[] } | null;
      const latest = list?.data?.[0];
      if (latest) {
        const f = await official(o.dataRoot, `/mods/${o.projectId}/files/${latest.id}`, { signal }) as { data?: CfFileMeta } | null;
        const sp = f?.data?.serverPackFileId;
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
        } else log('[curseforge] key mode: no serverPackFileId — falling back to client pack');
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      log(`[curseforge] key mode unavailable (${(e as Error).message}) — falling back to keyless`);
    }
  }

  if (!clientZip && o.projectId) {
    const r = await fetchTrusted(`${BASE}/mods/${o.projectId}/files?pageSize=1&index=0`, CURSEFORGE_ALLOWED_HOSTS, {
      signal, headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`cf files HTTP ${r.status}`);
    const j = await r.json() as { data: CfFileMeta[] };
    const latest = j.data[0];
    if (!latest) throw new Error('no files');
    clientZip = path.join(o.cacheDir, 'cfpack', `${o.projectId}-${latest.id}.zip`);
    await downloadFile(o.projectId, latest.id, clientZip, { size: latest.fileLength, fileName: latest.fileName, signal });
  }
  if (!clientZip) throw new Error('no CurseForge archive provided');
  if (fs.existsSync(o.dir)) throw new Error(`dir already exists: ${o.dir}`);

  const entries = await listZip(clientZip);
  const names = entries.map(e => e.name);
  const hasManifest = names.includes('manifest.json');

  let manifest: CfManifest | null = null, kind: LoaderKind | null = null, ver: string | null = null, mc: string | null = null, packName = path.basename(clientZip, '.zip');
  if (hasManifest) {
    manifest = JSON.parse((await readZipEntry(clientZip, 'manifest.json')).toString('utf8')) as CfManifest;
    const primary = manifest.minecraft.modLoaders.find(l => l.primary) ?? manifest.minecraft.modLoaders[0];
    const idm = primary?.id?.match(/^(fabric|quilt|forge|neoforge)-(.+)$/);
    if (!idm) throw new Error(`unsupported modLoader id: ${primary?.id}`);
    kind = idm[1] as LoaderKind; ver = idm[2]; mc = manifest.minecraft.version; packName = manifest.name ?? packName;
    result.route = 'B';
  } else {
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

  // loader (M-9): prebuilt → as-is; shipped installer → run it ourselves; else from manifest
  o.onProgress?.({ stage: `installing loader`, pct: 15 });
  if (!fs.existsSync(path.join(o.dir, 'run.bat')) && !fs.existsSync(path.join(o.dir, 'libraries'))) {
    const shipped = fs.readdirSync(o.dir).find(f => /^(forge|neoforge)-.*-installer\.jar$/i.test(f));
    if (shipped) {
      log(`[curseforge] pack ships installer "${shipped}" — running --installServer ourselves`);
      await runInstaller(await resolveJavaRuntime(), path.join(o.dir, shipped), ['--installServer'], o.dir, 'shipped loader', { signal });
    } else if (kind && mc && ver) {
      await installLoader(kind, o.dir, mc, ver, await resolveJavaRuntime(), o.cacheDir, { signal });
    } else throw new Error('server pack has neither a loader nor a manifest to install one from');
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
  return result;
}
