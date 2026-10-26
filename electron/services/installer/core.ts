// Installer engine — TypeScript port of the proven spike (H:\TestAI\modrinth-curseforge\sample\core.mjs).
// Live-validated there: 12/12 packs, 4-layer client-mod defense, old-Forge 1.12.2/Java 8,
// Mojang-metadata java mapping, CF keyless + key-mode. Keep this file logic-identical; changes
// need re-validation against the spike's acceptance packs.
import { createWriteStream, existsSync, mkdirSync, writeFileSync, renameSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import yauzl from 'yauzl';

export const UA = 'BlockServerManager/0.2 (github.com/local; windows)';
export function log(msg: string): void { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }
export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// ---------- http ----------
const CF_HOST = /(^|\.)curseforge\.com$/;
let lastCfReq = 0;
async function throttle(host: string): Promise<void> {
  if (!CF_HOST.test(host)) return;
  const wait = lastCfReq + 550 - Date.now(); // 2 req/s cap (D-23)
  if (wait > 0) await sleep(wait);
  lastCfReq = Date.now();
}

export async function fetchOk(url: string, opts: RequestInit = {}): Promise<Response> {
  const host = new URL(url).host;
  for (let attempt = 1; ; attempt++) {
    await throttle(host);
    let res: Response;
    try { res = await fetch(url, { redirect: 'follow', ...opts, headers: { 'User-Agent': UA, ...(opts.headers as Record<string, string> || {}) } }); }
    catch (e) { if (attempt >= 3) throw new Error(`network ${url}: ${(e as Error).message}`); await sleep(1500 * attempt); continue; }
    if (res.status >= 500 && attempt < 3) { await sleep(1500 * attempt); continue; }
    return res;
  }
}

export interface DownloadOpts { sha1?: string; sha256?: string; sha512?: string; size?: number }
export interface DownloadResult { bytes: number; sha1: string; sha256: string; sha512: string }
// temp+rename, size+hash verify; never sends Range (www.curseforge.com /download 404s on Range).
export async function download(url: string, dest: string, opts: DownloadOpts = {}): Promise<DownloadResult> {
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  const res = await fetchOk(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const file = createWriteStream(tmp);
  const h1 = createHash('sha1'), h256 = createHash('sha256'), h512 = createHash('sha512');
  let n = 0;
  if (res.body) for await (const chunk of res.body as unknown as AsyncIterable<Buffer>) {
    n += chunk.length;
    h1.update(chunk); h256.update(chunk); h512.update(chunk);
    if (!file.write(chunk)) await once(file, 'drain');
  }
  await new Promise<void>(r => file.end(r));
  const digests = { sha1: h1.digest('hex'), sha256: h256.digest('hex'), sha512: h512.digest('hex') };
  if (opts.size != null && n !== opts.size) { rmSync(tmp, { force: true }); throw new Error(`size mismatch ${url}: got ${n}, want ${opts.size}`); }
  if (opts.sha1 && digests.sha1 !== opts.sha1) { rmSync(tmp, { force: true }); throw new Error(`sha1 mismatch ${url}`); }
  if (opts.sha256 && digests.sha256 !== opts.sha256.toLowerCase()) { rmSync(tmp, { force: true }); throw new Error(`sha256 mismatch ${url}`); }
  if (opts.sha512 && digests.sha512 !== opts.sha512) { rmSync(tmp, { force: true }); throw new Error(`sha512 mismatch ${url}`); }
  renameSync(tmp, dest);
  return { bytes: n, ...digests };
}

// ---------- zip (yauzl) ----------
function openZip(p: string): Promise<yauzl.ZipFile> {
  return new Promise((res, rej) => yauzl.open(p, { lazyEntries: true, autoClose: false }, (e, z) => (e ? rej(e) : res(z!))));
}
function safeTarget(destDir: string, entryName: string): string {
  if (/^[a-zA-Z]:/.test(entryName) || entryName.startsWith('/') || entryName.startsWith('\\')) throw new Error(`unsafe zip entry (absolute): ${entryName}`);
  const norm = path.posix.normalize(entryName.replaceAll('\\', '/'));
  if (norm.startsWith('..') || norm.includes('/../')) throw new Error(`unsafe zip entry (..): ${entryName}`);
  const t = path.resolve(destDir, norm);
  if (!t.startsWith(path.resolve(destDir) + path.sep)) throw new Error(`unsafe zip entry (escape): ${entryName}`);
  return t;
}
export interface ZipEntry { name: string; size: number; isDir: boolean }
export async function listZip(zipPath: string): Promise<ZipEntry[]> {
  const z = await openZip(zipPath);
  const out: ZipEntry[] = [];
  z.on('entry', (e: yauzl.Entry) => { out.push({ name: e.fileName, size: e.uncompressedSize, isDir: e.fileName.endsWith('/') }); z.readEntry(); });
  await new Promise<void>((res, rej) => { z.on('end', () => res()); z.on('error', rej); z.readEntry(); });
  z.close();
  return out;
}
export async function readZipEntry(zipPath: string, entryName: string): Promise<Buffer> {
  const z = await openZip(zipPath);
  try {
    return await new Promise<Buffer>((res, rej) => {
      let found = false;
      z.on('entry', (e: yauzl.Entry) => {
        if (found || e.fileName !== entryName) return z.readEntry();
        found = true;
        z.openReadStream(e, (er, s) => {
          if (er || !s) return rej(er ?? new Error('stream'));
          void (async () => {
            try {
              const chunks: Buffer[] = [];
              for await (const c of s) chunks.push(c as Buffer);
              res(Buffer.concat(chunks));
            } catch (err) { rej(err); }
          })();
        });
      });
      z.on('end', () => rej(new Error(`zip entry not found: ${entryName}`)));
      z.on('error', rej);
      z.readEntry();
    });
  } finally {
    z.close();
  }
}
export interface ExtractResult { written: string[]; skippedExisting: string[]; excluded: string[] }
export async function extractZip(zipPath: string, destDir: string, opts: { root?: string; skipExisting?: boolean; maxTotalBytes?: number; excludeFn?: (rel: string) => boolean } = {}): Promise<ExtractResult> {
  const { root = '', skipExisting = true, maxTotalBytes = 2 * 1024 ** 3, excludeFn } = opts;
  const z = await openZip(zipPath);
  const written: string[] = [], skippedExisting: string[] = [], excluded: string[] = [];
  let total = 0;
  let failed = false; // set on the first failure: stops pumping entries and gates the promise
  try {
    await new Promise<void>((res, rej) => {
      let settled = false;
      // M-17: every failure path (zipfile error, entry-stream error, output-stream error, throw)
      // funnels here so the promise ALWAYS settles and the zip file descriptor is released.
      const fail = (err: unknown): void => {
        if (failed || settled) return;
        failed = true;
        settled = true;
        try { z.close(); } catch { /* already closed */ }
        rej(err instanceof Error ? err : new Error(String(err)));
      };
      z.on('entry', (e: yauzl.Entry) => {
        void (async () => {
          try {
            if (failed) return;
            if (!e.fileName.startsWith(root)) { z.readEntry(); return; }
            const rel = e.fileName.slice(root.length);
            if (!rel || e.fileName.endsWith('/')) { z.readEntry(); return; }
            if (excludeFn && excludeFn(rel)) { excluded.push(rel); z.readEntry(); return; }
            const target = safeTarget(destDir, rel);
            total += e.uncompressedSize;
            if (total > maxTotalBytes) throw new Error(`archive too large: ${zipPath}`);
            mkdirSync(path.dirname(target), { recursive: true });
            if (skipExisting && existsSync(target) && statSync(target).isFile()) { skippedExisting.push(rel); z.readEntry(); return; }
            z.openReadStream(e, (er, s) => {
              if (er || !s) return fail(er ?? new Error('zip entry stream unavailable'));
              if (failed) { s.destroy(); return; }
              const out = createWriteStream(target);
              const removePartial = (): void => { try { rmSync(target, { force: true }); } catch { /* handle may still be open */ } };
              // Corrupt/truncated entry: yauzl forwards zlib Z_DATA_ERROR on the read stream; without
              // these handlers it becomes an uncaughtException and the promise hangs (probe M-17).
              s.once('error', err => { s.destroy(); out.destroy(); removePartial(); fail(err); });
              out.once('error', err => { s.destroy(); out.destroy(); removePartial(); fail(err); });
              // Retry cleanup once the write handle has actually closed (Windows EBUSY on first try).
              out.once('close', () => { if (failed) removePartial(); });
              out.once('finish', () => {
                if (failed) return;
                written.push(rel);
                z.readEntry();
              });
              s.pipe(out);
            });
          } catch (err) { fail(err); }
        })();
      });
      z.on('end', () => { if (!failed && !settled) { settled = true; res(); } });
      z.on('error', err => fail(err));
      z.readEntry();
    });
  } finally {
    try { z.close(); } catch { /* closed by fail() */ }
  }
  return { written, skippedExisting, excluded };
}

// ---------- java ----------
interface Manifest { versions: { id: string; url: string }[] }
let mcJavaCache: Manifest | null = null;
// Mojang metadata first (MC 26.x has no 1.x shape — live-proven on SkyBlock Enhanced); D-08 table as fallback.
export async function requiredJavaMajor(mc: string): Promise<number> {
  try {
    if (!mcJavaCache) mcJavaCache = await (await fetchOk('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).json() as Manifest;
    const entry = mcJavaCache.versions.find(v => v.id === mc);
    if (entry) {
      const meta = await (await fetchOk(entry.url)).json() as { javaVersion?: { majorVersion?: number } };
      if (meta.javaVersion?.majorVersion) return meta.javaVersion.majorVersion;
    }
  } catch { /* fall through to table */ }
  const parts = mc.split('.').map(Number);
  if (parts[0] !== 1) throw new Error(`cannot map java major for non-1.x MC version "${mc}" without Mojang metadata`);
  const minor = parts[1] ?? 0, patch = parts[2] ?? 0;
  if (minor <= 16) return 8;
  if (minor === 20 && patch >= 5) return 21;
  if (minor <= 20) return 17;
  return 21;
}

export interface JavaRuntime { major: number; javapath: string; source: string }
function javaMajorOf(javaExe: string): number | null {
  const r = spawnSync(javaExe, ['-version'], { encoding: 'utf8' });
  const out = (r.stderr || '') + (r.stdout || '');
  const m = out.match(/version "(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return m[1] === '1' ? Number(m[2]) : Number(m[1]);
}
export async function detectJava(major: number, extraRoots: string[]): Promise<JavaRuntime[]> {
  const found: JavaRuntime[] = [];
  const seen = new Set<string>();
  const consider = (p0: string, source: string) => {
    const exe = p0.endsWith('.exe') ? p0 : path.join(p0, 'bin', 'java.exe');
    if (!existsSync(exe) || seen.has(exe)) return;
    const mj = javaMajorOf(exe);
    if (mj === major) { seen.add(exe); found.push({ major: mj, javapath: exe, source }); }
    else if (mj !== null) seen.add(exe);
  };
  if (process.env.JAVA_HOME) consider(process.env.JAVA_HOME, 'JAVA_HOME');
  const where = spawnSync('where', ['java'], { encoding: 'utf8' });
  for (const l of (where.stdout || '').split(/\r?\n/)) if (l.trim()) consider(l.trim(), 'PATH');
  for (const base of ['C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Java', 'C:\\Program Files\\Microsoft', ...extraRoots]) {
    try { for (const d of readdirSync(base)) consider(path.join(base, d), 'installed'); } catch { /* not present */ }
  }
  return found;
}
export async function ensureJava(major: number, runtimeRoot: string, cacheDir: string, onProgress?: (p: { phase: string; pct?: number }) => void): Promise<JavaRuntime> {
  const found = await detectJava(major, [runtimeRoot]);
  const hit = found[0];
  if (hit) return hit;
  onProgress?.({ phase: `downloading Temurin ${major} (Adoptium)` });
  const assets = await (await fetchOk(`https://api.adoptium.net/v3/assets/latest/${major}/hotspot?os=windows&architecture=x64&image_type=jdk`)).json() as { binary: { package: { link: string; size: number } } }[];
  const pkg = assets[0].binary.package;
  const zipPath = path.join(cacheDir, `temurin-${major}.zip`);
  if (!existsSync(zipPath)) await download(pkg.link, zipPath, { size: pkg.size });
  const home = path.join(runtimeRoot, `temurin-${major}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  await extractZip(zipPath, home, { skipExisting: false });
  const inner = readdirSync(home).find(d => d.startsWith('jdk-'));
  const javaExe = path.join(home, inner ?? '', 'bin', 'java.exe');
  if (!existsSync(javaExe)) throw new Error(`jdk extraction failed: ${javaExe}`);
  return { major, javapath: javaExe, source: 'adoptium' };
}

// ---------- loaders ----------
export type LoaderKind = 'vanilla' | 'paper' | 'fabric' | 'quilt' | 'forge' | 'neoforge';
export async function runInstaller(javaExe: string, installerJar: string, args: string[], cwd: string, what: string, attempts = 2): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    log(`installing ${what}: java -jar ${path.basename(installerJar)} ${args.join(' ')}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
    const proc = spawn(javaExe, ['-jar', installerJar, ...args], { cwd });
    let tail = '';
    const collect = (d: Buffer) => { tail += d.toString(); if (tail.length > 8000) tail = tail.slice(-4000); };
    proc.stdout.on('data', collect); proc.stderr.on('data', collect);
    const code = (await once(proc, 'exit'))[0] as number;
    if (code === 0) return;
    // installers are re-runnable; transient network failures (SSL/EOF mid-download) get one retry (§19.2)
    if (attempt >= attempts) throw new Error(`${what} installer failed (exit ${code}):\n` + tail.split('\n').slice(-15).join('\n'));
    await sleep(5000);
  }
}
// ---------- paper (Fill v3) ----------
// Live shape (verified against https://fill.papermc.io/v3/projects/paper/versions/1.21.4/builds):
//   [ { id: 232, time: "...", channel: "STABLE"|"BETA"|"ALPHA",
//       downloads: { "server:default": { name, url, size, checksums: { sha256 } } } }, ... ]  (newest first)
// `selectPaperBuild`/`paperServerArtifact` are pure so build choice is unit-testable without network.
export const PAPER_SERVER_DOWNLOAD = 'server:default';

export interface FillBuildDownload {
  name?: string;
  url?: string;
  size?: number;
  checksums?: Record<string, string | undefined>;
}
export interface FillBuild {
  id?: number | string;
  time?: string;
  channel?: string;
  downloads?: Record<string, FillBuildDownload | null | undefined>;
}
export interface PaperServerArtifact {
  buildId: number; // -1 when the payload has no usable id
  channel: string;
  url: string;
  size: number;
  sha256: string; // lowercase hex
  name: string;
}

function fillBuildId(build: FillBuild | null | undefined): number {
  const raw = build?.id;
  const id = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : -1;
}
function fileBaseName(url: string): string {
  try { return path.basename(new URL(url).pathname) || 'paper.jar'; } catch { return 'paper.jar'; }
}
/** Latest-first ordering: Fill is newest-first already, but never trust payload order (id, then time). */
function fillBuildsNewestFirst(builds: FillBuild[]): FillBuild[] {
  const rank = (build: FillBuild): { id: number; time: number } => {
    const parsed = typeof build?.time === 'string' ? Date.parse(build.time) : NaN;
    return { id: fillBuildId(build), time: Number.isFinite(parsed) ? parsed : -Infinity };
  };
  return builds
    .map((build, index) => ({ build, index, rank: rank(build) }))
    .sort((a, b) => (b.rank.id - a.rank.id) || (b.rank.time - a.rank.time) || (a.index - b.index))
    .map((entry) => entry.build);
}
/** Validate one Fill build and return its `server:default` artifact; null when absent or incomplete. */
export function paperServerArtifact(build: FillBuild | null | undefined): PaperServerArtifact | null {
  if (!build || typeof build !== 'object') return null;
  const download = build.downloads?.[PAPER_SERVER_DOWNLOAD] ?? null;
  if (!download || typeof download !== 'object') return null;
  const url = typeof download.url === 'string' ? download.url.trim() : '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !parsed.hostname) return null;
  } catch { return null; }
  const size = typeof download.size === 'number' && Number.isSafeInteger(download.size) && download.size > 0 ? download.size : 0;
  if (!size) return null;
  const sha256 = typeof download.checksums?.sha256 === 'string' ? download.checksums.sha256.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  return {
    buildId: fillBuildId(build),
    channel: String(build.channel ?? '').toUpperCase(),
    url,
    size,
    sha256,
    name: typeof download.name === 'string' && download.name.trim() ? download.name.trim() : fileBaseName(url),
  };
}
/** Latest STABLE build that carries a complete `server:default` artifact. Throws when none exists. */
export function selectPaperBuild(builds: FillBuild[]): PaperServerArtifact {
  if (!Array.isArray(builds)) throw new Error('Fill API response is not a build array');
  const channels = [...new Set(builds.map(build => String(build?.channel ?? '?').toUpperCase()))];
  for (const build of fillBuildsNewestFirst(builds)) {
    if (String(build?.channel ?? '').toUpperCase() !== 'STABLE') continue;
    const artifact = paperServerArtifact(build);
    if (artifact) return artifact;
  }
  throw new Error(`no STABLE Paper build with a complete ${PAPER_SERVER_DOWNLOAD} download (${builds.length} build(s); channels: ${channels.join(', ') || 'none'})`);
}
/** Explicit build-id pin (channel may be BETA/ALPHA): requires a complete `server:default` artifact. */
export function selectPaperBuildById(builds: FillBuild[], buildId: number): PaperServerArtifact {
  if (!Array.isArray(builds)) throw new Error('Fill API response is not a build array');
  const build = builds.find(candidate => fillBuildId(candidate) === buildId);
  if (!build) throw new Error(`Paper build ${buildId} not found for this Minecraft version`);
  const artifact = paperServerArtifact(build);
  if (!artifact) throw new Error(`Paper build ${buildId} is not artifact-complete (${PAPER_SERVER_DOWNLOAD} needs url + size + sha256)`);
  return artifact;
}
export async function installLoader(kind: LoaderKind, dir: string, mc: string, ver: string, javaExe: string, cacheDir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  if (kind === 'paper') {
    const buildsUrl = `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(mc)}/builds`;
    const res = await fetchOk(buildsUrl);
    if (res.status === 404) throw new Error(`Paper has no builds for Minecraft ${mc}`);
    if (!res.ok) throw new Error(`Fill API HTTP ${res.status} for ${buildsUrl}`);
    let payload: unknown;
    try { payload = await res.json(); } catch (e) { throw new Error(`Fill API returned invalid JSON for Paper ${mc}: ${(e as Error).message}`); }
    if (!Array.isArray(payload)) throw new Error(`unexpected Fill API payload for Paper ${mc}: expected a build array`);
    // loaderVersion may be a numeric build pin; the wizard currently sends the MC version (ignored -> latest STABLE).
    const pinned = /^\d+$/.test(ver.trim()) ? Number(ver.trim()) : null;
    let artifact: PaperServerArtifact;
    try {
      artifact = pinned !== null ? selectPaperBuildById(payload as FillBuild[], pinned) : selectPaperBuild(payload as FillBuild[]);
    } catch (e) {
      throw new Error(`Paper ${mc}: ${(e as Error).message}`);
    }
    log(`[paper] ${mc}: installing build ${artifact.buildId === -1 ? '?' : artifact.buildId} (${artifact.channel || 'unknown channel'}) ${artifact.name}`);
    await download(artifact.url, path.join(dir, 'server.jar'), { size: artifact.size, sha256: artifact.sha256 });
    log(`[paper] ${mc}: server.jar verified (${artifact.size} bytes, sha256 ${artifact.sha256.slice(0, 12)}…)`);
    return;
  }
  if (kind === 'vanilla') {
    const manifest = await (await fetchOk('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).json() as { versions: { id: string; url: string }[] };
    const entry = manifest.versions.find(v => v.id === mc);
    if (!entry) throw new Error(`unknown MC version ${mc}`);
    const meta = await (await fetchOk(entry.url)).json() as { downloads?: { server?: { url: string; sha1: string; size: number } } };
    const srv = meta.downloads?.server;
    if (!srv) throw new Error(`no server download for ${mc}`);
    await download(srv.url, path.join(dir, 'server.jar'), { sha1: srv.sha1, size: srv.size });
    return;
  }
  if (kind === 'fabric' || kind === 'quilt') {
    const metaHost = kind === 'fabric' ? 'https://meta.fabricmc.net/v2/versions/installer' : 'https://meta.quiltmc.org/v3/versions/installer';
    const installers = await (await fetchOk(metaHost)).json() as { url?: string; version?: string; links?: { url?: string } }[];
    const iUrl = installers[0].url ?? installers[0].links?.url;
    if (!iUrl) throw new Error(`no ${kind} installer in meta`);
    const iJar = path.join(cacheDir, `${kind}-installer-${installers[0].version ?? path.basename(iUrl)}.jar`);
    if (!existsSync(iJar)) await download(iUrl, iJar);
    if (kind === 'fabric') await runInstaller(javaExe, iJar, ['server', '-dir', dir, '-mcversion', mc, '-loader', ver, '-downloadMinecraft'], dir, 'fabric');
    else await runInstaller(javaExe, iJar, ['install', 'server', mc, ver, `--install-dir=${dir}`, '--download-server'], dir, 'quilt');
    return;
  }
  if (kind === 'forge') {
    const v = `${mc}-${ver}`;
    const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${v}/forge-${v}-installer.jar`;
    const jar = path.join(cacheDir, `forge-${v}-installer.jar`);
    if (!existsSync(jar)) await download(url, jar);
    await runInstaller(javaExe, jar, ['--installServer'], dir, 'forge');
    return;
  }
  if (kind === 'neoforge') {
    // loaders_resolve yields "1.20.1-47.1.106" (version already carries the MC prefix); strip it.
    const bare = ver.startsWith(mc + '-') ? ver.slice(mc.length + 1) : ver;
    const v = `${mc}-${bare}`;
    const urls: [string, string][] = [
      [`https://maven.neoforged.net/releases/net/neoforged/neoforge/${v}/neoforge-${v}-installer.jar`, `neoforge-${v}-installer.jar`],
      [`https://maven.neoforged.net/releases/net/neoforged/forge/${v}/forge-${v}-installer.jar`, `neoforge-legacy-${v}-installer.jar`],
    ];
    for (const [u, name] of urls) {
      const probe = await fetchOk(u, { method: 'HEAD' });
      if (probe.ok) {
        const jar = path.join(cacheDir, name);
        if (!existsSync(jar)) await download(u, jar);
        await runInstaller(javaExe, jar, ['--installServer'], dir, 'neoforge');
        return;
      }
    }
    throw new Error(`neoforge installer not found for ${v}`);
  }
  throw new Error(`loader not supported: ${kind as string}`);
}

// ---------- launch ----------
function expandArgsFile(f: string, depth = 0): string[] {
  if (depth > 4) return [];
  const out: string[] = [];
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('#') || /^@echo/i.test(l) || /^rem /i.test(l)) continue;
    for (const tok of l.match(/(?:[^\s"]+"[^"]*"|[^\s"]+)/g) ?? []) {
      const t = tok.replaceAll('"', '');
      if (t === 'java' || t === 'javaw' || t === '%*') continue;
      if (t.startsWith('@')) {
        const ref = path.resolve(path.dirname(f), t.slice(1));
        if (existsSync(ref)) { out.push(...expandArgsFile(ref, depth + 1)); continue; }
      }
      out.push(t);
    }
  }
  return out;
}
export interface LaunchCommand { exe: string; args: string[] }
export function launchCommand(dir: string, javaExe: string): LaunchCommand {
  const runBat = path.join(dir, 'run.bat');
  if (existsSync(runBat)) {
    const args = expandArgsFile(runBat);
    if (!args.includes('nogui')) args.push('nogui');
    return { exe: javaExe, args };
  }
  for (const jar of ['fabric-server-launch.jar', 'quilt-server-launch.jar']) {
    if (existsSync(path.join(dir, jar))) return { exe: javaExe, args: ['-jar', jar, 'nogui'] };
  }
  // Old Forge (≤1.12.x): --installServer yields a runnable jar at the dir root, with or without "-universal".
  const uni = readdirSync(dir).find(f => /^forge-.*\.jar$/i.test(f) && !/installer|client|sources|javadoc|launcher/i.test(f));
  if (uni) return { exe: javaExe, args: ['-jar', uni, 'nogui'] };
  if (existsSync(path.join(dir, 'server.jar'))) return { exe: javaExe, args: ['-jar', 'server.jar', 'nogui'] };
  throw new Error(`no launch method found in ${dir}`);
}

// ---------- run + verify + auto-fix (L3) ----------
export async function freePort(preferred: number): Promise<number> {
  const inUse = (port: number) => new Promise<boolean>(res => {
    const s = net.createServer();
    s.once('error', () => res(true));
    s.once('listening', () => s.close(() => res(false)));
    s.listen(port, '127.0.0.1');
  });
  let p = preferred;
  while (await inUse(p)) p++;
  return p;
}
export interface StartResult { ok: boolean; reason: string; tail: string[] }
export async function startAndVerify(dir: string, cmd: LaunchCommand, opts: { timeoutMs?: number; onLine?: (l: string) => void } = {}): Promise<StartResult> {
  const { timeoutMs = 15 * 60_000, onLine } = opts;
  log(`starting server: ${path.basename(cmd.exe)} ${cmd.args.slice(0, 4).join(' ')} ... (cwd=${dir})`);
  const proc = spawn(cmd.exe, cmd.args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  return await new Promise<StartResult>(resolve => {
    let buf = ''; const lines: string[] = []; let done = false; let exitInfo: { code: number | null } | null = null;
    const finish = (ok: boolean, reason: string) => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { proc.stdin.write('stop\n'); } catch { /* already gone */ }
      const resolveNow = () => resolve({ ok, reason, tail: lines.slice(-400) });
      if (exitInfo) return resolveNow();
      const killAt = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 30_000);
      proc.once('exit', () => { clearTimeout(killAt); resolveNow(); });
      setTimeout(resolveNow, 45_000);
    };
    proc.once('exit', code => { exitInfo = { code }; if (!done) finish(false, `process exited (code ${code}) before Done(`); });
    const timer = setTimeout(() => finish(false, `timeout after ${timeoutMs / 1000}s without "Done ("`), timeoutMs);
    const onData = (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
        if (line.trim()) { lines.push(line); if (lines.length > 400) lines.shift(); onLine?.(line); }
        if (/Done \(\d/.test(line)) finish(true, line.trim());
      }
    };
    proc.stdout.on('data', onData); proc.stderr.on('data', onData);
  });
}
export async function scanModIds(modsDir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let jars: string[] = []; try { jars = readdirSync(modsDir).filter(f => /\.jar$/i.test(f)); } catch { return map; }
  for (const jar of jars) {
    const p = path.join(modsDir, jar);
    for (const name of ['fabric.mod.json', 'quilt.mod.json', 'META-INF/mods.toml', 'META-INF/neoforge.mods.toml']) {
      try {
        const text = (await readZipEntry(p, name)).toString('utf8');
        if (name.endsWith('.json')) {
          const j = JSON.parse(text) as { id?: string; quilt_loader?: { id?: string } };
          const id = j.id ?? j.quilt_loader?.id;
          if (id) { map.set(id, jar); break; }
        } else {
          const ids = [...text.matchAll(/modId\s*=\s*["']([^"']+)["']/g)].map(m => m[1]);
          if (ids.length) { for (const id of ids) map.set(id, jar); break; }
        }
      } catch { /* try next descriptor */ }
    }
  }
  return map;
}
export function analyzeFailure(tail: string[]): { disable: string[]; add: string[] } {
  const text = tail.join('\n');
  const disable = new Set<string>(), add = new Set<string>();
  for (const m of text.matchAll(/^\s*(.+?) \(([a-z0-9_.-]+)\) has failed to load correctly/gmi)) disable.add(m[2]);
  for (const m of text.matchAll(/Mod '.*?' \(([a-z0-9_.-]+)\).*?requires .*?([a-z0-9_.-]+), which is missing/gi)) { disable.add(m[1]); add.add(m[2]); }
  for (const m of text.matchAll(/\badd:([a-z0-9_.-]+)\b/gi)) add.add(m[1]);
  for (const m of text.matchAll(/Missing mandatory dependencies[^\]]*\[([^\]]+)\]/gi)) {
    for (const d of m[1].split(',')) { const id = d.trim().split(/[:@\s]/)[0]; if (id) add.add(id); }
  }
  // Mixin-instrumented frames: `handler$<hash>$<mixinConfig>$<namespace>$<method>` — namespace names the mod.
  for (const m of text.matchAll(/\b(?:handler|call)\$\w+\$([a-z0-9_-]+)\$/gi)) disable.add(m[1]);
  return { disable: [...disable], add: [...add] };
}
export function parseCrashReports(dir: string): Map<string, string> {
  const idToJar = new Map<string, string>();
  let files: string[] = [];
  try { files = readdirSync(path.join(dir, 'crash-reports')).filter(f => f.endsWith('.txt')).map(f => path.join(dir, 'crash-reports', f)); } catch { return idToJar; }
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!files.length) return idToJar;
  try {
    const text = readFileSync(files[0], 'utf8');
    const sections = text.split(/-- MOD ([a-z0-9_.-]+) --/);
    for (let i = 1; i + 1 < sections.length; i += 2) {
      const mf = sections[i + 1].match(/Mod File: .*[/\\](.+?\.jar)/);
      if (mf) idToJar.set(sections[i], mf[1]);
    }
  } catch { /* unreadable report */ }
  return idToJar;
}
export interface AutoFixEntry { round: number; action: 'disabled' | 'added'; mod: string; jar?: string }
export async function startWithAutoFix(dir: string, cmd: LaunchCommand, opts: { timeoutMs?: number; maxRounds?: number; fetchDep?: (id: string) => Promise<string | null>; l2Protect?: Set<string> } = {}): Promise<StartResult & { fixes: AutoFixEntry[]; rounds: number; l2?: { jar: string; reasons: string[] }[] }> {
  const { timeoutMs = 15 * 60_000, maxRounds = 8, fetchDep } = opts;
  const fixes: AutoFixEntry[] = [];
  let l2: { jar: string; reasons: string[] }[] | undefined;
  if (opts.l2Protect !== undefined) l2 = await applyJarSideness(path.join(dir, 'mods'), opts.l2Protect);
  for (let round = 1; round <= maxRounds; round++) {
    const r = await startAndVerify(dir, cmd, { timeoutMs });
    if (r.ok) return { ...r, fixes, rounds: round, l2 };
    const { disable, add } = analyzeFailure(r.tail);
    const crashJars = parseCrashReports(dir);
    let acted = false;
    const allDisable = new Set([...disable, ...crashJars.keys()]);
    if (allDisable.size || add.length) {
      const idMap = await scanModIds(path.join(dir, 'mods'));
      mkdirSync(path.join(dir, 'mods-disabled'), { recursive: true });
      for (const id of allDisable) {
        const jar = idMap.get(id) ?? crashJars.get(id);
        if (jar && existsSync(path.join(dir, 'mods', jar))) {
          renameSync(path.join(dir, 'mods', jar), path.join(dir, 'mods-disabled', jar));
          fixes.push({ round, action: 'disabled', mod: id, jar });
          log(`[autofix r${round}] disabled ${id} (${jar})`);
          acted = true;
        }
      }
      for (const depId of add) {
        if (idMap.has(depId) || !fetchDep) continue;
        try {
          const jar = await fetchDep(depId);
          if (jar) { fixes.push({ round, action: 'added', mod: depId, jar }); log(`[autofix r${round}] added missing dependency ${depId} (${jar})`); acted = true; }
        } catch (e) { log(`[autofix r${round}] could not fetch ${depId}: ${(e as Error).message}`); }
      }
    }
    if (!acted) return { ...r, fixes, rounds: round, l2 };
  }
  return { ok: false, reason: `still failing after ${maxRounds} auto-fix rounds`, tail: [], fixes, rounds: maxRounds, l2 };
}

// ---------- L2: jar self-declaration scan ----------
export async function scanJarSideness(jarPath: string): Promise<{ client: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  try {
    const toml = await readZipEntry(jarPath, 'META-INF/mods.toml').catch(() => null)
      ?? await readZipEntry(jarPath, 'META-INF/neoforge.mods.toml').catch(() => null);
    if (toml) {
      const sides = [...toml.toString('utf8').matchAll(/side\s*=\s*["']?(CLIENT|SERVER|BOTH)["']?/gi)].map(m => m[1].toUpperCase());
      if (sides.length && sides.every(s => s === 'CLIENT')) reasons.push(`mods.toml all sides CLIENT (${sides.length})`);
    }
  } catch { /* unreadable */ }
  try {
    const fmj = await readZipEntry(jarPath, 'fabric.mod.json').catch(() => null)
      ?? await readZipEntry(jarPath, 'quilt.mod.json').catch(() => null);
    if (fmj) {
      const j = JSON.parse(fmj.toString('utf8')) as { environment?: string; mixins?: (string | { config: string })[] };
      if (j.environment === 'client') reasons.push('fabric.mod.json environment=client');
      for (const cfg of j.mixins ?? []) {
        try {
          const name = typeof cfg === 'string' ? cfg : cfg.config;
          const mj = JSON.parse((await readZipEntry(jarPath, name)).toString('utf8')) as { environment?: string };
          if (mj.environment === 'client') reasons.push(`mixin ${name} environment=client`);
        } catch { /* optional config */ }
      }
    }
  } catch { /* unreadable */ }
  return { client: reasons.length > 0, reasons };
}
export async function applyJarSideness(modsDir: string, protect: Set<string> = new Set()): Promise<{ jar: string; reasons: string[] }[]> {
  const disabledDir = path.join(path.dirname(modsDir), 'mods-disabled');
  const out: { jar: string; reasons: string[] }[] = [];
  let jars: string[] = []; try { jars = readdirSync(modsDir).filter(f => /\.jar$/i.test(f)); } catch { return out; }
  for (const jar of jars) {
    if (protect.has(jar)) continue;
    const { client, reasons } = await scanJarSideness(path.join(modsDir, jar));
    if (!client) continue;
    mkdirSync(disabledDir, { recursive: true });
    renameSync(path.join(modsDir, jar), path.join(disabledDir, jar));
    out.push({ jar, reasons });
    log(`[L2] ${jar} → mods-disabled (${reasons.join('; ')})`);
  }
  return out;
}

// ---------- EULA / properties ----------
// EULA is written ONLY on explicit user consent (C-3/M-6) — the caller must gate this.
export function writeEula(dir: string): void {
  if (!existsSync(path.join(dir, 'eula.txt'))) {
    writeFileSync(path.join(dir, 'eula.txt'), '# accepted in Block Server Manager\neula=true\n');
  }
}
export function ensureServerProperties(dir: string, port: number): void {
  const f = path.join(dir, 'server.properties');
  if (!existsSync(f)) { writeFileSync(f, `server-port=${port}\nmotd=Block Server Manager\n`); return; }
  const text = readFileSync(f, 'utf8');
  if (!/^server-port=/m.test(text)) writeFileSync(f, text + `\nserver-port=${port}\n`);
}
