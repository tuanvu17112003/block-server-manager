// Installer engine — TypeScript port of the proven spike (H:\TestAI\modrinth-curseforge\sample\core.mjs).
// Live-validated there: 12/12 packs, 4-layer client-mod defense, old-Forge 1.12.2/Java 8,
// Mojang-metadata java mapping, CF keyless + key-mode. Keep this file logic-identical; changes
// need re-validation against the spike's acceptance packs.
import { createWriteStream, createReadStream, existsSync, mkdirSync, writeFileSync, renameSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import yauzl from 'yauzl';
import { appError } from '../store';

export const UA = 'BlockServerManager/0.2 (github.com/local; windows)';
export function log(msg: string): void { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }
export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// ---------- cancellation (WP-4.1) ----------
/** Optional abort signal shared by every installer engine entry point. */
export interface Cancelable { signal?: AbortSignal }

/** Typed cancellation error (`code: 'cancelled'`) consumed by the IPC envelope and job runner. */
export function cancelledError(message = 'Install cancelled.'): Error {
  return appError('cancelled', message);
}
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError();
}
export function isAbortError(error: unknown): boolean {
  const named = error as { name?: string; code?: string } | null | undefined;
  return named?.name === 'AbortError' || named?.code === 'ABORT_ERR';
}
/** `sleep` that rejects promptly with a `cancelled` error when the signal aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(cancelledError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => { clearTimeout(timer); reject(cancelledError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
/**
 * Race `work` against an abort signal. `onAbort` runs exactly once (e.g. destroy a fetch body or
 * kill a child process); `dispose()` removes the listener on the success path.
 */
export function abortRace(signal: AbortSignal | undefined, onAbort?: () => void): { promise: Promise<never>; dispose: () => void } {
  if (!signal) return { promise: new Promise<never>(() => undefined), dispose: () => undefined };
  let handler: (() => void) | null = null;
  const promise = new Promise<never>((_resolve, reject) => {
    handler = () => {
      try { onAbort?.(); } catch { /* abort cleanup is best effort */ }
      reject(cancelledError());
    };
    if (signal.aborted) handler();
    else signal.addEventListener('abort', handler, { once: true });
  });
  return {
    promise,
    dispose: () => { if (handler) signal.removeEventListener('abort', handler); },
  };
}

// ---------- trusted hosts + manual redirects (WP-4.4 / INST-011) ----------
export type HostAllowlist = readonly string[];

/** Provider allowlists used by every metadata/artifact fetch (ADR-0018 per-hop validation). */
export const MODRINTH_ALLOWED_HOSTS: HostAllowlist = [
  'api.modrinth.com', 'cdn.modrinth.com', 'github.com', 'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
];
export const CURSEFORGE_ALLOWED_HOSTS: HostAllowlist = [
  'api.curseforge.com', 'www.curseforge.com', 'legacy.curseforge.com', 'curseforge.com',
  'mediafilez.forgecdn.net', 'edge.forgecdn.net', 'mediafilez.curseforge.com',
];
export const LOADER_ALLOWED_HOSTS: HostAllowlist = [
  'meta.fabricmc.net', 'maven.fabricmc.net', 'meta.quiltmc.org', 'maven.quiltmc.org',
  'maven.minecraftforge.net', 'files.minecraftforge.net',
  'maven.neoforged.net', 'fill.papermc.io', 'fill-data.papermc.io', 'piston-meta.mojang.com',
  'piston-data.mojang.com', 'launchermeta.mojang.com', 'launcher.mojang.com',
  'resources.download.minecraft.net', 'api.adoptium.net', 'api.github.com', 'github.com',
  'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
];
export const ADOPTIUM_ALLOWED_HOSTS: HostAllowlist = LOADER_ALLOWED_HOSTS;

/** Exact host match; a leading `.` entry allows that domain and its subdomains. */
export function isHostAllowed(host: string, allowlist: HostAllowlist): boolean {
  const candidate = String(host ?? '').trim().toLowerCase();
  if (!candidate) return false;
  return allowlist.some((rawEntry) => {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) return false;
    if (entry.startsWith('.')) return candidate === entry.slice(1) || candidate.endsWith(entry);
    return candidate === entry;
  });
}

export interface TrustedFetchOptions extends RequestInit { maxRedirects?: number }

/**
 * Fetch with provider policy: HTTPS only, manual redirect following (≤5 hops by default) where
 * EVERY hop must be one of `allowedHosts`; a redirect to any other host/protocol is rejected.
 * Network errors/5xx are retried up to 3 times (never on abort).
 */
export async function fetchTrusted(url: string, allowedHosts: HostAllowlist, opts: TrustedFetchOptions = {}): Promise<Response> {
  const { maxRedirects = 5, ...init } = opts;
  const signal = init.signal ?? undefined;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await trustedFetchWalk(String(url ?? '').trim(), allowedHosts, maxRedirects, init);
      if (response.status >= 500 && attempt < 3) {
        await abortableSleep(750 * attempt, signal);
        continue;
      }
      return response;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'cancelled' || code === 'validation' || isAbortError(error) || signal?.aborted) {
        if (isAbortError(error) || signal?.aborted) throw cancelledError();
        throw error;
      }
      if (attempt >= 3) throw error;
      await abortableSleep(750 * attempt, signal);
    }
  }
}

async function trustedFetchWalk(initialUrl: string, allowedHosts: HostAllowlist, maxRedirects: number, init: RequestInit): Promise<Response> {
  const signal = init.signal ?? undefined;
  let current = initialUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    throwIfAborted(signal);
    let parsed: URL;
    try { parsed = new URL(current); } catch { throw appError('validation', `invalid URL: ${current}`); }
    if (parsed.protocol !== 'https:') throw appError('validation', `refusing non-HTTPS URL: ${current}`);
    if (!isHostAllowed(parsed.hostname, allowedHosts)) {
      throw appError('validation', `host not allowed: ${parsed.hostname} (${current})`);
    }
    await throttle(parsed.host, signal);
    let response: Response;
    try {
      response = await fetch(parsed.toString(), {
        ...init,
        redirect: 'manual',
        signal,
        headers: { 'User-Agent': UA, ...(init.headers as Record<string, string> | undefined ?? {}) },
      });
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw cancelledError();
      throw new Error(`network ${current}: ${(error as Error).message}`);
    }
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const location = response.headers.get('location');
      if (!location) return response;
      if (hop >= maxRedirects) throw appError('validation', `too many redirects (${maxRedirects}) for ${initialUrl}`);
      try { void response.body?.cancel(); } catch { /* ignore body cleanup */ }
      try { current = new URL(location, parsed).toString(); } catch { throw appError('validation', `invalid redirect location from ${parsed.toString()}: ${location}`); }
      continue;
    }
    return response;
  }
  throw appError('validation', `too many redirects (${maxRedirects}) for ${initialUrl}`);
}

// ---------- http ----------
const CF_HOST = /(^|\.)curseforge\.com$/;
let lastCfReq = 0;
async function throttle(host: string, signal?: AbortSignal): Promise<void> {
  if (!CF_HOST.test(host)) return;
  const wait = lastCfReq + 550 - Date.now(); // 2 req/s cap (D-23)
  if (wait > 0) await abortableSleep(wait, signal);
  lastCfReq = Date.now();
}

export async function fetchOk(url: string, opts: RequestInit = {}): Promise<Response> {
  const host = new URL(url).host;
  const signal = opts.signal ?? undefined;
  for (let attempt = 1; ; attempt++) {
    throwIfAborted(signal);
    await throttle(host, signal);
    let res: Response;
    try { res = await fetch(url, { redirect: 'follow', ...opts, headers: { 'User-Agent': UA, ...(opts.headers as Record<string, string> || {}) } }); }
    catch (e) {
      if (isAbortError(e) || signal?.aborted) throw cancelledError();
      if (attempt >= 3) throw new Error(`network ${url}: ${(e as Error).message}`);
      await abortableSleep(1500 * attempt, signal);
      continue;
    }
    if (res.status >= 500 && attempt < 3) { await abortableSleep(1500 * attempt, signal); continue; }
    return res;
  }
}

export interface DownloadOpts extends Cancelable {
  sha1?: string;
  sha256?: string;
  sha512?: string;
  size?: number;
  /** When set, the URL (and every redirect hop) must stay on these HTTPS hosts. */
  allowedHosts?: HostAllowlist;
}
export interface DownloadResult { bytes: number; sha1: string; sha256: string; sha512: string }
// temp+rename, size+hash verify; never sends Range (www.curseforge.com /download 404s on Range).
// Cancellable: an abort destroys the HTTP body + `.part` file and throws a typed `cancelled` error.
export async function download(url: string, dest: string, opts: DownloadOpts = {}): Promise<DownloadResult> {
  const { signal } = opts;
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  let file: ReturnType<typeof createWriteStream> | null = null;
  const abort = abortRace(signal, () => { try { void file?.destroy(); } catch { /* ignore */ } });
  void abort.promise.catch(() => undefined); // race/cleanup path handles it; avoids unhandled rejections
  try {
    throwIfAborted(signal);
    const res = opts.allowedHosts
      ? await fetchTrusted(url, opts.allowedHosts, { signal })
      : await fetchOk(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    throwIfAborted(signal);
    file = createWriteStream(tmp);
    const h1 = createHash('sha1'), h256 = createHash('sha256'), h512 = createHash('sha512');
    let n = 0;
    const pump = (async (): Promise<void> => {
      if (!res.body) return;
      for await (const chunk of res.body as unknown as AsyncIterable<Buffer>) {
        n += chunk.length;
        h1.update(chunk); h256.update(chunk); h512.update(chunk);
        if (!file!.write(chunk)) await once(file!, 'drain');
      }
    })();
    pump.catch(() => { /* surfaced through the race below (avoids unhandled rejection) */ });
    try {
      await Promise.race([pump, abort.promise]);
    } catch (error) {
      try { void res.body?.cancel().catch(() => undefined); } catch { /* ignore */ }
      throw error;
    }
    await new Promise<void>((resolve, reject) => file!.end((error?: Error | null) => (error ? reject(error) : resolve())));
    throwIfAborted(signal);
    const digests = { sha1: h1.digest('hex'), sha256: h256.digest('hex'), sha512: h512.digest('hex') };
    if (opts.size != null && n !== opts.size) throw new Error(`size mismatch ${url}: got ${n}, want ${opts.size}`);
    if (opts.sha1 && digests.sha1 !== opts.sha1.toLowerCase()) throw new Error(`sha1 mismatch ${url}`);
    if (opts.sha256 && digests.sha256 !== opts.sha256.toLowerCase()) throw new Error(`sha256 mismatch ${url}`);
    if (opts.sha512 && digests.sha512 !== opts.sha512.toLowerCase()) throw new Error(`sha512 mismatch ${url}`);
    renameSync(tmp, dest);
    return { bytes: n, ...digests };
  } catch (error) {
    try { file?.destroy(); } catch { /* ignore */ }
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    if (isAbortError(error) || signal?.aborted) throw cancelledError();
    throw error;
  } finally {
    abort.dispose();
  }
}

// ---------- integrity: cache re-verification + ordered source failover (WP-4.4 / INST-010) ----------
export interface FileExpectation { size?: number; sha1?: string; sha256?: string; sha512?: string }

/** Streaming hash of a local file (used to re-verify caches before reuse). */
export async function hashFile(file: string): Promise<DownloadResult> {
  const h1 = createHash('sha1'), h256 = createHash('sha256'), h512 = createHash('sha512');
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk: Buffer) => { bytes += chunk.length; h1.update(chunk); h256.update(chunk); h512.update(chunk); });
    stream.once('error', reject);
    stream.once('end', () => resolve());
  });
  return { bytes, sha1: h1.digest('hex'), sha256: h256.digest('hex'), sha512: h512.digest('hex') };
}

/** True when `file` exists and matches every expectation that is present. */
export async function verifyCachedFile(file: string, expected: FileExpectation = {}): Promise<boolean> {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return false;
    if (expected.size != null && statSync(file).size !== expected.size) return false;
    const needsHash = Boolean(expected.sha1 || expected.sha256 || expected.sha512);
    if (!needsHash) return true;
    const digests = await hashFile(file);
    if (expected.sha1 && digests.sha1 !== expected.sha1.toLowerCase()) return false;
    if (expected.sha256 && digests.sha256 !== expected.sha256.toLowerCase()) return false;
    if (expected.sha512 && digests.sha512 !== expected.sha512.toLowerCase()) return false;
    return true;
  } catch { return false; }
}

export interface DownloadCandidate extends FileExpectation { url: string }
export interface DownloadFirstAvailableOpts extends Cancelable {
  dest: string;
  allowedHosts?: HostAllowlist;
  /** Attempts per candidate URL (default 2); candidates themselves are tried in order. */
  attemptsPerCandidate?: number;
  onAttempt?: (candidate: DownloadCandidate, index: number, attempt: number) => void;
}
export interface DownloadFirstAvailableResult extends DownloadResult {
  url: string;
  cached: boolean;
  attempts: number;
}

/**
 * Ordered URL failover with per-candidate size/hash verification. An existing `dest` is re-hashed
 * and reused only when it matches one candidate's expectations (corrupt caches are re-downloaded).
 */
export async function downloadFirstAvailable(
  candidates: (string | DownloadCandidate)[],
  opts: DownloadFirstAvailableOpts,
): Promise<DownloadFirstAvailableResult> {
  const { dest, signal } = opts;
  throwIfAborted(signal);
  const list: DownloadCandidate[] = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => (typeof candidate === 'string' ? { url: candidate } : candidate))
    .filter((candidate): candidate is DownloadCandidate => typeof candidate?.url === 'string' && candidate.url.trim().length > 0);
  if (list.length === 0) throw appError('validation', `no download sources for ${dest}`);
  if (existsSync(dest)) {
    for (const candidate of list) {
      if (await verifyCachedFile(dest, candidate)) {
        const digests = await hashFile(dest);
        return { ...digests, url: candidate.url, cached: true, attempts: 0 };
      }
    }
    // Corrupt/incomplete cache: remove it so a failed re-download cannot silently leave a bad file.
    try { rmSync(dest, { force: true }); } catch { /* ignore */ }
  }
  const attemptsPerCandidate = Math.max(1, opts.attemptsPerCandidate ?? 2);
  const failures: string[] = [];
  let attempts = 0;
  for (const [index, candidate] of list.entries()) {
    for (let attempt = 1; attempt <= attemptsPerCandidate; attempt += 1) {
      throwIfAborted(signal);
      attempts += 1;
      opts.onAttempt?.(candidate, index, attempt);
      try {
        const result = await download(candidate.url, dest, {
          sha1: candidate.sha1, sha256: candidate.sha256, sha512: candidate.sha512, size: candidate.size,
          allowedHosts: opts.allowedHosts, signal,
        });
        return { ...result, url: candidate.url, cached: false, attempts };
      } catch (error) {
        if (isAbortError(error) || signal?.aborted || (error as { code?: string }).code === 'cancelled') throw cancelledError();
        failures.push(`${candidate.url}#${attempt}: ${(error as Error).message}`);
        if (attempt < attemptsPerCandidate) await abortableSleep(300 * attempt, signal);
      }
    }
  }
  throw new Error(`all download sources failed for ${dest}: ${failures.join(' | ')}`);
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
// ---------- archive hardening (WP-4.4 / INST-019) ----------
export const ARCHIVE_MAX_ENTRIES = 100_000;
export const ARCHIVE_MAX_PATH_LENGTH = 1024;
const WINDOWS_RESERVED_NAMES = new Set<string>([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** Entry-name policy: path length, Win32 reserved device names, trailing dot/space segments. */
export function unsafeArchiveEntryReason(entryName: string, opts: { maxPathLength?: number } = {}): string | null {
  const maxPathLength = opts.maxPathLength ?? ARCHIVE_MAX_PATH_LENGTH;
  const normalized = entryName.replaceAll('\\', '/');
  if (!normalized) return `empty archive entry name`;
  if (normalized.length > maxPathLength) {
    return `archive entry path too long (${normalized.length} > ${maxPathLength}): ${entryName}`;
  }
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.' || segment === '..') continue;
    const base = segment.split('.')[0] ?? segment;
    if (WINDOWS_RESERVED_NAMES.has(base.toLowerCase())) {
      return `reserved Windows device name "${segment}" in archive entry: ${entryName}`;
    }
    if (/[. ]$/.test(segment)) {
      return `archive entry segment has a trailing dot or space: "${segment}" (${entryName})`;
    }
  }
  return null;
}

/** yauzl entry is a symlink/reparse point (unix mode bits or the Win32 reparse attribute). */
export function isSymlinkArchiveEntry(entry: yauzl.Entry): boolean {
  const attributes = (entry as unknown as { externalFileAttributes?: number }).externalFileAttributes ?? 0;
  const unixMode = (attributes >>> 16) & 0xffff;
  if ((unixMode & 0o170000) === 0o120000) return true;
  return (attributes & 0x400) !== 0; // FILE_ATTRIBUTE_REPARSE_POINT
}

export interface ExtractOpts extends Cancelable {
  root?: string;
  skipExisting?: boolean;
  maxTotalBytes?: number;
  /** Hard cap on archive entries (default {@link ARCHIVE_MAX_ENTRIES}). */
  maxEntries?: number;
  /** Hard cap on normalized entry path length (default {@link ARCHIVE_MAX_PATH_LENGTH}). */
  maxPathLength?: number;
  excludeFn?: (rel: string) => boolean;
}
export async function extractZip(zipPath: string, destDir: string, opts: ExtractOpts = {}): Promise<ExtractResult> {
  const { root = '', skipExisting = true, maxTotalBytes = 2 * 1024 ** 3, excludeFn, signal } = opts;
  const maxEntries = opts.maxEntries ?? ARCHIVE_MAX_ENTRIES;
  const maxPathLength = opts.maxPathLength ?? ARCHIVE_MAX_PATH_LENGTH;
  throwIfAborted(signal);
  const z = await openZip(zipPath);
  const written: string[] = [], skippedExisting: string[] = [], excluded: string[] = [];
  const seenPaths = new Set<string>(); // case-insensitive duplicate detection
  let entriesSeen = 0;
  let total = 0;
  let failed = false; // set on the first failure: stops pumping entries and gates the promise
  let abortDispose: () => void = () => undefined;
  let activeStream: (NodeJS.ReadableStream & { destroy?: () => void }) | null = null;
  let activeOut: ReturnType<typeof createWriteStream> | null = null;
  let activeTarget = '';
  try {
    await new Promise<void>((res, rej) => {
      let settled = false;
      // M-17: every failure path (zipfile error, entry-stream error, output-stream error, throw)
      // funnels here so the promise ALWAYS settles and the zip file descriptor is released.
      const fail = (err: unknown): void => {
        if (failed || settled) return;
        failed = true;
        settled = true;
        try { activeStream?.destroy?.(); } catch { /* ignore */ }
        try { activeOut?.destroy(); } catch { /* ignore */ }
        if (activeTarget) { try { rmSync(activeTarget, { force: true }); } catch { /* handle may be open */ } }
        try { z.close(); } catch { /* already closed */ }
        rej(err instanceof Error ? err : new Error(String(err)));
      };
      const abort = abortRace(signal, () => {
        try { activeStream?.destroy?.(); } catch { /* ignore */ }
        try { activeOut?.destroy(); } catch { /* ignore */ }
        if (activeTarget) { try { rmSync(activeTarget, { force: true }); } catch { /* ignore */ } }
      });
      abortDispose = abort.dispose;
      void abort.promise.catch((error) => fail(error));
      z.on('entry', (e: yauzl.Entry) => {
        void (async () => {
          try {
            if (failed) return;
            throwIfAborted(signal);
            entriesSeen += 1;
            if (entriesSeen > maxEntries) throw new Error(`archive has too many entries (> ${maxEntries}): ${zipPath}`);
            const unsafe = unsafeArchiveEntryReason(e.fileName, { maxPathLength });
            if (unsafe) throw new Error(`unsafe archive entry: ${unsafe}`);
            if (isSymlinkArchiveEntry(e)) throw new Error(`symlink/reparse entry not allowed: ${e.fileName}`);
            if (!e.fileName.startsWith(root)) { z.readEntry(); return; }
            const rel = e.fileName.slice(root.length);
            if (!rel || e.fileName.endsWith('/')) { z.readEntry(); return; }
            const lowered = rel.replaceAll('\\', '/').toLowerCase();
            if (seenPaths.has(lowered)) throw new Error(`duplicate archive path (case-insensitive): ${rel}`);
            seenPaths.add(lowered);
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
              activeStream = s; activeOut = out; activeTarget = target;
              const removePartial = (): void => { try { rmSync(target, { force: true }); } catch { /* handle may still be open */ } };
              // Corrupt/truncated entry: yauzl forwards zlib Z_DATA_ERROR on the read stream; without
              // these handlers it becomes an uncaughtException and the promise hangs (probe M-17).
              s.once('error', err => { s.destroy(); out.destroy(); removePartial(); fail(err); });
              out.once('error', err => { s.destroy(); out.destroy(); removePartial(); fail(err); });
              // Retry cleanup once the write handle has actually closed (Windows EBUSY on first try).
              out.once('close', () => { if (failed) removePartial(); });
              out.once('finish', () => {
                if (failed) return;
                activeStream = null; activeOut = null; activeTarget = '';
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
    abortDispose();
    try { z.close(); } catch { /* closed by fail() */ }
  }
  return { written, skippedExisting, excluded };
}

// ---------- java ----------
interface Manifest { versions: { id: string; url: string }[] }
let mcJavaCache: Manifest | null = null;
// Mojang metadata first (MC 26.x has no 1.x shape — live-proven on SkyBlock Enhanced); D-08 table as fallback.
export async function requiredJavaMajor(mc: string, opts: Cancelable = {}): Promise<number> {
  try {
    if (!mcJavaCache) {
      mcJavaCache = await (await fetchTrusted('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', LOADER_ALLOWED_HOSTS, { signal: opts.signal })).json() as Manifest;
    }
    const entry = mcJavaCache.versions.find(v => v.id === mc);
    if (entry) {
      const meta = await (await fetchTrusted(entry.url, LOADER_ALLOWED_HOSTS, { signal: opts.signal })).json() as { javaVersion?: { majorVersion?: number } };
      if (meta.javaVersion?.majorVersion) return meta.javaVersion.majorVersion;
    }
  } catch (error) {
    if (opts.signal?.aborted || isAbortError(error)) throw cancelledError();
    /* fall through to table */
  }
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
export async function ensureJava(major: number, runtimeRoot: string, cacheDir: string, onProgress?: (p: { phase: string; pct?: number }) => void, opts: Cancelable = {}): Promise<JavaRuntime> {
  throwIfAborted(opts.signal);
  const found = await detectJava(major, [runtimeRoot]);
  const hit = found[0];
  if (hit) return hit;
  onProgress?.({ phase: `downloading Temurin ${major} (Adoptium)` });
  const assets = await (await fetchTrusted(`https://api.adoptium.net/v3/assets/latest/${major}/hotspot?os=windows&architecture=x64&image_type=jdk`, ADOPTIUM_ALLOWED_HOSTS, { signal: opts.signal })).json() as { binary: { package: { link: string; size: number } } }[];
  const pkg = assets[0].binary.package;
  const zipPath = path.join(cacheDir, `temurin-${major}.zip`);
  // Cache re-verify: a truncated/stale JDK zip must be re-downloaded, never silently extracted.
  if (!(await verifyCachedFile(zipPath, { size: pkg.size }))) {
    await download(pkg.link, zipPath, { size: pkg.size, allowedHosts: ADOPTIUM_ALLOWED_HOSTS, signal: opts.signal });
  }
  throwIfAborted(opts.signal);
  const home = path.join(runtimeRoot, `temurin-${major}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  await extractZip(zipPath, home, { skipExisting: false, signal: opts.signal });
  const inner = readdirSync(home).find(d => d.startsWith('jdk-'));
  const javaExe = path.join(home, inner ?? '', 'bin', 'java.exe');
  if (!existsSync(javaExe)) throw new Error(`jdk extraction failed: ${javaExe}`);
  return { major, javapath: javaExe, source: 'adoptium' };
}

// ---------- loaders ----------
export type LoaderKind = 'vanilla' | 'paper' | 'fabric' | 'quilt' | 'forge' | 'neoforge';

/** Minimal ChildProcess surface used by `runInstaller` (injectable for cancellation tests). */
export interface InstallerChildProcess {
  pid?: number;
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
  once(event: 'exit', listener: (code: number | null, signal?: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}
export interface RunInstallerOptions extends Cancelable {
  attempts?: number;
  /** Test seam: replace the real `spawn`. */
  spawnProcess?: (exe: string, args: string[], options: { cwd: string }) => InstallerChildProcess;
  /** Test seam: replace the Windows process-tree kill. */
  killTree?: (pid: number) => void;
}

/** Kill a child process AND its descendants (installer scripts spawn java children). */
export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* best effort */ }
    return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

/**
 * Run a java installer JAR. Cancellation kills the whole child tree and rejects with a
 * `cancelled` error within milliseconds of the abort (never waits for the child to exit).
 */
export async function runInstaller(javaExe: string, installerJar: string, args: string[], cwd: string, what: string, opts: RunInstallerOptions = {}): Promise<void> {
  const attempts = opts.attempts ?? 2;
  const spawnProcess = opts.spawnProcess ?? ((exe, spawnArgs, options) => spawn(exe, spawnArgs, options) as unknown as InstallerChildProcess);
  const killTree = opts.killTree ?? killProcessTree;
  for (let attempt = 1; ; attempt++) {
    throwIfAborted(opts.signal);
    log(`installing ${what}: java -jar ${path.basename(installerJar)} ${args.join(' ')}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
    const proc = spawnProcess(javaExe, ['-jar', installerJar, ...args], { cwd });
    let tail = '';
    const collect = (d: Buffer) => { tail += d.toString(); if (tail.length > 8000) tail = tail.slice(-4000); };
    proc.stdout.on('data', collect); proc.stderr.on('data', collect);
    const exit = new Promise<number | null>((resolve) => { proc.once('exit', (code) => resolve(code)); });
    const abort = abortRace(opts.signal, () => {
      try { if (proc.pid) killTree(proc.pid); } catch { /* best effort */ }
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    });
    let code: number | null;
    try {
      code = await Promise.race([exit, abort.promise]);
    } catch (error) {
      throw error; // cancelled
    } finally {
      abort.dispose();
    }
    throwIfAborted(opts.signal);
    if (code === 0) return;
    // installers are re-runnable; transient network failures (SSL/EOF mid-download) get one retry (§19.2)
    if (attempt >= attempts) throw new Error(`${what} installer failed (exit ${code}):\n` + tail.split('\n').slice(-15).join('\n'));
    await abortableSleep(5000, opts.signal);
  }
}
// ---------- neoforge install coordinates ----------
// Documented MC→artifact mapping only (ADR-0007; never numeric inference):
// - MC 1.20.1 keeps the legacy `net/neoforged/forge` artifact with a `1.20.1-47.x` version.
// - MC 1.20.2+ uses `net/neoforged/neoforge` with the full modern version and no MC prefix
//   (e.g. 21.1.80 for MC 1.21.1, 20.4.253 for 1.20.4, 26.3.0.99 for MC 26.3).
// Pure and exported so catalogue/install coordinates are unit-testable without network.
export interface NeoForgeInstallerCandidate { url: string; name: string; artifact: 'neoforge' | 'forge'; mavenVersion: string }
export function neoforgeInstallerCandidates(mc: string, loaderVersion: string): NeoForgeInstallerCandidate[] {
  const mcVersion = String(mc ?? '').trim();
  const requested = String(loaderVersion ?? '').trim();
  if (!mcVersion || !requested) return [];
  // Persisted legacy pins may already carry the MC prefix ("1.20.1-47.1.106"); accept both forms.
  const bare = requested.startsWith(`${mcVersion}-`) ? requested.slice(mcVersion.length + 1).trim() : requested;
  if (!bare) return [];
  const root = 'https://maven.neoforged.net/releases/net/neoforged';
  if (mcVersion === '1.20.1') {
    const mavenVersion = `${mcVersion}-${bare}`;
    return [{
      url: `${root}/forge/${mavenVersion}/forge-${mavenVersion}-installer.jar`,
      name: `neoforge-legacy-${mavenVersion}-installer.jar`,
      artifact: 'forge',
      mavenVersion,
    }];
  }
  return [{
    url: `${root}/neoforge/${bare}/neoforge-${bare}-installer.jar`,
    name: `neoforge-${bare}-installer.jar`,
    artifact: 'neoforge',
    mavenVersion: bare,
  }];
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
/**
 * Forge build for an exact Minecraft version, from Forge's own promotions feed.
 * Used only when a server pack carries no manifest and no installer name (RLCraft's server pack is
 * `mods/` + `config/` only). This is still authoritative provider metadata, not a guess: the feed is
 * Forge's canonical "recommended/latest build for this MC version" answer.
 */
async function latestForgeVersion(mc: string, signal?: AbortSignal): Promise<string> {
  const res = await fetchTrusted('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json', LOADER_ALLOWED_HOSTS, { signal });
  if (!res.ok) throw new Error(`forge promotions HTTP ${res.status}`);
  const body = await res.json() as { promos?: Record<string, string> };
  const promos = body.promos ?? {};
  const recommended = promos[`${mc}-recommended`];
  const latest = promos[`${mc}-latest`];
  const version = recommended ?? latest;
  if (!version) throw new Error(`Forge publishes no build for Minecraft ${mc}`);
  log(`[forge] ${mc}: using provider build ${version} (${recommended ? 'recommended' : 'latest'})`);
  return version;
}

async function latestFabricLoaderVersion(mc: string, signal?: AbortSignal): Promise<string> {
  const pick = (payload: unknown): string | null => {
    const entries = Array.isArray(payload) ? payload : [];
    const parsed = entries
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .map((entry) => {
        const loader = typeof entry.loader === 'object' && entry.loader !== null ? entry.loader as Record<string, unknown> : entry;
        return { version: typeof loader.version === 'string' ? loader.version : '', stable: loader.stable === true };
      })
      .filter((entry) => entry.version !== '');
    return (parsed.find((entry) => entry.stable) ?? parsed[0])?.version ?? null;
  };
  try {
    const scoped = await fetchTrusted(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}`, LOADER_ALLOWED_HOSTS, { signal });
    if (scoped.ok) {
      const version = pick(await scoped.json());
      if (version) return version;
    }
  } catch { /* fall back to the global loader list */ }
  const global = await fetchTrusted('https://meta.fabricmc.net/v2/versions/loader', LOADER_ALLOWED_HOSTS, { signal });
  if (!global.ok) throw new Error(`Fabric loader metadata HTTP ${global.status}`);
  const version = pick(await global.json());
  if (!version) throw new Error('Fabric did not return a loader version');
  return version;
}

async function latestQuiltLoaderVersion(mc: string, signal?: AbortSignal): Promise<string> {
  const pick = (payload: unknown): string | null => {
    const entries = Array.isArray(payload) ? payload : [];
    const first = entries.find((entry) => typeof (entry as { version?: unknown } | null)?.version === 'string') as { version?: string } | undefined;
    return first?.version ?? null;
  };
  for (const url of [`https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mc)}`, 'https://meta.quiltmc.org/v3/versions/loader']) {
    try {
      const response = await fetchTrusted(url, LOADER_ALLOWED_HOSTS, { signal });
      if (!response.ok) continue;
      const version = pick(await response.json());
      if (version) return version;
    } catch { /* try the next endpoint */ }
  }
  throw new Error(`Quilt did not return a loader version for Minecraft ${mc}`);
}

export async function installLoader(kind: LoaderKind, dir: string, mc: string, ver: string | null, javaExe: string, cacheDir: string, opts: Cancelable = {}): Promise<void> {
  const { signal } = opts;
  throwIfAborted(signal);
  mkdirSync(dir, { recursive: true });
  const loaderVersion = (ver ?? '').trim();
  if (kind === 'paper') {
    const buildsUrl = `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(mc)}/builds`;
    const res = await fetchTrusted(buildsUrl, LOADER_ALLOWED_HOSTS, { signal });
    if (res.status === 404) throw new Error(`Paper has no builds for Minecraft ${mc}`);
    if (!res.ok) throw new Error(`Fill API HTTP ${res.status} for ${buildsUrl}`);
    let payload: unknown;
    try { payload = await res.json(); } catch (e) { throw new Error(`Fill API returned invalid JSON for Paper ${mc}: ${(e as Error).message}`); }
    if (!Array.isArray(payload)) throw new Error(`unexpected Fill API payload for Paper ${mc}: expected a build array`);
    // loaderVersion may be a numeric build pin; the wizard currently sends the MC version (ignored -> latest STABLE).
    const pinned = /^\d+$/.test(loaderVersion) ? Number(loaderVersion) : null;
    let artifact: PaperServerArtifact;
    try {
      artifact = pinned !== null ? selectPaperBuildById(payload as FillBuild[], pinned) : selectPaperBuild(payload as FillBuild[]);
    } catch (e) {
      throw new Error(`Paper ${mc}: ${(e as Error).message}`);
    }
    log(`[paper] ${mc}: installing build ${artifact.buildId === -1 ? '?' : artifact.buildId} (${artifact.channel || 'unknown channel'}) ${artifact.name}`);
    await download(artifact.url, path.join(dir, 'server.jar'), { size: artifact.size, sha256: artifact.sha256, allowedHosts: LOADER_ALLOWED_HOSTS, signal });
    log(`[paper] ${mc}: server.jar verified (${artifact.size} bytes, sha256 ${artifact.sha256.slice(0, 12)}…)`);
    return;
  }
  if (kind === 'vanilla') {
    const manifest = await (await fetchTrusted('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', LOADER_ALLOWED_HOSTS, { signal })).json() as { versions: { id: string; url: string }[] };
    const entry = manifest.versions.find(v => v.id === mc);
    if (!entry) throw new Error(`unknown MC version ${mc}`);
    const meta = await (await fetchTrusted(entry.url, LOADER_ALLOWED_HOSTS, { signal })).json() as { downloads?: { server?: { url: string; sha1: string; size: number } } };
    const srv = meta.downloads?.server;
    if (!srv) throw new Error(`no server download for ${mc}`);
    await download(srv.url, path.join(dir, 'server.jar'), { sha1: srv.sha1, size: srv.size, allowedHosts: LOADER_ALLOWED_HOSTS, signal });
    return;
  }
  if (kind === 'fabric' || kind === 'quilt') {
    const metaHost = kind === 'fabric' ? 'https://meta.fabricmc.net/v2/versions/installer' : 'https://meta.quiltmc.org/v3/versions/installer';
    const installers = await (await fetchTrusted(metaHost, LOADER_ALLOWED_HOSTS, { signal })).json() as { url?: string; version?: string; links?: { url?: string } }[];
    const iUrl = installers[0].url ?? installers[0].links?.url;
    if (!iUrl) throw new Error(`no ${kind} installer in meta`);
    const iJar = path.join(cacheDir, `${kind}-installer-${installers[0].version ?? path.basename(iUrl)}.jar`);
    if (!(await verifyCachedFile(iJar, {}))) await download(iUrl, iJar, { allowedHosts: LOADER_ALLOWED_HOSTS, signal });
    // Plain server packs may not pin a loader build: use the newest stable loader from provider meta.
    const resolvedVersion = loaderVersion || (kind === 'fabric'
      ? await latestFabricLoaderVersion(mc, signal)
      : await latestQuiltLoaderVersion(mc, signal));
    log(`[${kind}] ${mc}: using loader ${resolvedVersion}`);
    if (kind === 'fabric') await runInstaller(javaExe, iJar, ['server', '-dir', dir, '-mcversion', mc, '-loader', resolvedVersion, '-downloadMinecraft'], dir, 'fabric', { signal });
    else await runInstaller(javaExe, iJar, ['install', 'server', mc, resolvedVersion, `--install-dir=${dir}`, '--download-server'], dir, 'quilt', { signal });
    return;
  }
  if (kind === 'forge') {
    // A pack without a manifest/installer names no Forge build. Resolve the provider's canonical
    // build for this MC version instead of failing (RLCraft 1.12.2 server pack ships mods only).
    // `loaderVersion` may arrive as an empty string from archive inference, so test for truthiness.
    const resolvedForgeVersion = (loaderVersion ?? '').trim() !== '' ? loaderVersion! : await latestForgeVersion(mc, signal);
    const v = `${mc}-${resolvedForgeVersion}`;
    const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${v}/forge-${v}-installer.jar`;
    const jar = path.join(cacheDir, `forge-${v}-installer.jar`);
    const head = await fetchTrusted(url, LOADER_ALLOWED_HOSTS, { method: 'HEAD', signal });
    if (!head.ok) throw new Error(`forge installer not found for ${v} (HTTP ${head.status})`);
    if (!(await verifyCachedFile(jar, {}))) await download(url, jar, { allowedHosts: LOADER_ALLOWED_HOSTS, signal });
    await runInstaller(javaExe, jar, ['--installServer'], dir, 'forge', { signal });
    return;
  }
  if (kind === 'neoforge') {
    // Documented coordinate (see neoforgeInstallerCandidates): 1.20.1 legacy `1.20.1-47.x`
    // under net/neoforged/forge; 1.20.2+ modern full version under net/neoforged/neoforge.
    const candidates = neoforgeInstallerCandidates(mc, loaderVersion);
    if (candidates.length === 0) throw new Error(`NeoForge needs an exact loader version for Minecraft ${mc} (this archive has no manifest/installer metadata; got "${loaderVersion}").`);
    const attempted: string[] = [];
    for (const candidate of candidates) {
      const probe = await fetchTrusted(candidate.url, LOADER_ALLOWED_HOSTS, { method: 'HEAD', signal });
      if (!probe.ok) { attempted.push(`${candidate.mavenVersion} (HTTP ${probe.status})`); continue; }
      const jar = path.join(cacheDir, candidate.name);
      if (!(await verifyCachedFile(jar, {}))) await download(candidate.url, jar, { allowedHosts: LOADER_ALLOWED_HOSTS, signal });
      await runInstaller(javaExe, jar, ['--installServer'], dir, 'neoforge', { signal });
      return;
    }
    throw new Error(`neoforge installer not found for Minecraft ${mc} ${loaderVersion} (tried ${attempted.join(', ') || candidates.map(candidate => candidate.mavenVersion).join(', ')})`);
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
      // The published directory cannot be renamed while a JVM still holds it as its working directory. Resolving on this
      // timer without the child having exited is what produced the reported EPERM during install: the verification boot
      // "finished", publish ran immediately, and Windows refused to rename a folder that was still a process's cwd.
      // So the timeout kills first and WAITS for the exit event; only a process that survives SIGKILL lets us continue,
      // and the reason records that it happened so a later publish failure can be traced to it.
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* gone */ }
        setTimeout(() => resolveNow(), 10_000);
      }, 45_000);
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

/**
 * Dependency modIds that ARE the platform rather than another mod.
 * Quoted from ServerPackCreator's `ForgeTomlScanner.kt:63-68` (`neoForgeMinecraft`): a mod declaring a `side`
 * on one of these is stating its OWN sideness, not a dependency's.
 */
const FORGE_PLATFORM_MODIDS: readonly RegExp[] = [/^forge$/i, /^neoforge$/i, /^minecraft$/i];

interface ForgeDependencyEntry { modId: string; side: string | null; type: string | null; optional: boolean }

/**
 * Parse the `[[dependencies.<modid>]]` blocks of a `mods.toml` into entries.
 *
 * The previous implementation scanned the whole file with a regex for `side = CLIENT|SERVER|BOTH` and treated a
 * jar as client-only when EVERY occurrence was CLIENT. Research §3.1 showed that predicate is wrong: dependency
 * blocks for OTHER mods also carry `side=`, so it both misses real client mods (a client mod with an unrelated
 * BOTH dependency line) and can mis-disable server mods.
 *
 * ServerPackCreator's rule (`ForgeTomlScanner.kt:114-152`) is narrower and is what this implements:
 *   - only `[[dependencies.<thisMod>]]` entries are considered;
 *   - `type = "incompatible"` entries are skipped entirely;
 *   - an entry whose modId is forge/neoforge/minecraft states THIS mod's sideness;
 *   - if no such platform entry exists, the mod is treated as SERVER;
 *   - any parse problem ⇒ SERVER (fail toward keeping the mod).
 *
 * This is a small hand parser rather than a TOML dependency because `mods.toml` is an untrusted file inside a
 * mod jar and the subset needed here is four keys.
 */
export function parseForgeDependencies(text: string): Map<string, ForgeDependencyEntry[]> {
  const byMod = new Map<string, ForgeDependencyEntry[]>();
  let inDependencies = false;
  let currentOwner: string | null = null;
  let entry: Partial<ForgeDependencyEntry> | null = null;

  const flushEntry = (): void => {
    if (!entry || currentOwner === null) { entry = null; return; }
    if (typeof entry.modId === 'string' && entry.modId.trim() !== '') {
      // Push into the owner's array in the map (not a local array, which would be discarded).
      const bucket = byMod.get(currentOwner) ?? [];
      bucket.push({
        modId: entry.modId.trim(),
        side: typeof entry.side === 'string' ? entry.side : null,
        type: typeof entry.type === 'string' ? entry.type : null,
        optional: entry.optional === true,
      });
      byMod.set(currentOwner, bucket);
    }
    entry = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;

    // `[[dependencies.<modid>]]` (array of tables) or `[dependencies]` (plain table).
    const tableHeader = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?$/);
    if (tableHeader) {
      // Flush the previous dependency entry before starting a new table; a new [[...]] header begins a new entry.
      flushEntry();
      const path = tableHeader[1]!.split('.').map(part => part.trim().replace(/^["']|["']$/g, ''));
      inDependencies = path[0] === 'dependencies' && path.length >= 2;
      currentOwner = inDependencies ? path[1]! : null;
      if (inDependencies && currentOwner !== null && !byMod.has(currentOwner)) byMod.set(currentOwner, []);
      entry ??= {};
      continue;
    }
    if (!inDependencies) continue;

    const assignment = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!assignment) continue;
    const key = assignment[1]!.trim();
    const rawValue = assignment[2]!.trim();
    if (key === 'modId' || key === 'side' || key === 'type') {
      entry ??= {};
      entry[key] = rawValue.replace(/^["']|["']$/g, '');
    } else if (key === 'mandatory') {
      entry ??= {};
      entry.optional = rawValue === 'false';
    }
  }
  flushEntry();
  return byMod;
}

/**
 * Decide whether a Forge/NeoForge jar declares itself client-only, using ServerPackCreator's platform-dependency
 * rule (research §3.1). Fails toward SERVER: no dependencies, no platform entry, or unparseable text ⇒ not client.
 */
export function forgeTomlIsClientOnly(text: string): { client: boolean; reason: string | null } {
  let byMod: Map<string, ForgeDependencyEntry[]>;
  try {
    byMod = parseForgeDependencies(text);
  } catch {
    return { client: false, reason: null };
  }
  // The jar's OWN block is `[[dependencies.<the first [[mods]] modId>]]` -- the block ServerPackCreator reads
  // (`valueMap()["mods"][0]`). A second bundled mod's block is deliberately not consulted: letting a bundled
  // library that demands a client-side platform condemn the whole jar is the over-exclusion direction.
  const ownModId = parseForgeModId(text);
  let owners: string[];
  if (ownModId !== null) {
    const key = [...byMod.keys()].find(candidate => candidate.toLowerCase() === ownModId.toLowerCase());
    owners = key === undefined ? [] : [key];
  } else {
    // No readable `[[mods]]` id: judge every block and require all of them to agree on CLIENT, which is the
    // fail-toward-keeping reading of a descriptor whose own identity could not be read.
    owners = [...byMod.keys()];
  }
  let sawPlatformEntry = false;
  for (const owner of owners) {
    const platformEntries = (byMod.get(owner) ?? []).filter(entry =>
      entry.type?.toLowerCase() !== 'incompatible'
      && FORGE_PLATFORM_MODIDS.some(pattern => pattern.test(entry.modId)));
    if (platformEntries.length === 0) continue;
    sawPlatformEntry = true;
    // Every platform entry must say CLIENT; a single BOTH/SERVER keeps the mod.
    if (!platformEntries.every(entry => (entry.side ?? '').toUpperCase() === 'CLIENT')) {
      return { client: false, reason: null };
    }
  }
  if (!sawPlatformEntry) return { client: false, reason: null };
  return { client: true, reason: `mods.toml platform dependency side=CLIENT (${owners.length} block(s))` };
}

/**
 * Rule ids every L2 exclusion/decision is attributed to (research §3.6: an exclusion that cannot be
 * attributed to a rule id is a silent over-exclusion waiting to happen).
 */
export const L2_RULE = 'l2.jar-self-declaration';
export const L2_RESCUE_RULE = 'l2.dependency-rescue';

/**
 * Platform ids Fabric and Quilt never record as real dependencies, unioned from ServerPackCreator's two
 * scanners (`FabricScanner.kt:61-62`, `QuiltScanner.kt`): `fabricloader` and `quilt_loader` are the loaders,
 * `java`/`minecraft` the runtime. `fabric` is deliberately absent — it is Fabric API, the most depended-on mod
 * in the ecosystem, and refusing to record it is what made a dependency rescue impossible for it.
 */
const JAR_PLATFORM_MODIDS = /^(fabricloader|quilt_loader|java|minecraft)$/i;

/** Read a `provides`/`depends` block that may hold bare ids or `{ id }` objects (Quilt allows both). */
function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim() !== '') out.push(entry.trim());
    else if (entry && typeof entry === 'object') {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === 'string' && id.trim() !== '') out.push(id.trim());
    }
  }
  return out;
}

/**
 * The `modId` of the first `[[mods]]` block, or null.
 *
 * ServerPackCreator reads exactly this (`ForgeTomlScanner.kt:91`: `valueMap()["mods"][0]`) to know which
 * `[[dependencies.<modid>]]` block is the jar's own. Kept separate from {@link parseForgeDependencies}, which
 * only tracks `dependencies` tables.
 */
export function parseForgeModId(text: string): string | null {
  let inMods = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const header = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?$/);
    if (header) {
      const path = header[1]!.split('.').map(part => part.trim().replace(/^["']|["']$/g, ''));
      inMods = path.length === 1 && path[0]!.toLowerCase() === 'mods';
      continue;
    }
    if (!inMods) continue;
    const assignment = line.match(/^modId\s*=\s*(.+)$/);
    if (assignment) {
      const id = assignment[1]!.trim().replace(/^["']|["']$/g, '');
      if (id !== '') return id;
    }
  }
  return null;
}

/**
 * The mod ids a Forge/NeoForge descriptor says it needs **on the server**.
 *
 * Mirrors `ForgeTomlScanner.getSidenessesAndDependencies` (lines 119-145): only non-platform entries become
 * dependencies, `type = "incompatible"` entries are skipped (they mean the opposite of a dependency) and an
 * entry whose `side` is CLIENT is a client-only dependency, so it must not rescue anything.
 *
 * Read from the jar's own `[[dependencies.<modId>]]` block. When the descriptor has no readable `[[mods]]` id,
 * every owner block is read instead — over-recording a dependency can only ever *rescue* a jar, which is the
 * fail-toward-keeping direction the whole rule is built on.
 */
function forgeServerDependencies(text: string, ownModId: string | null): string[] {
  let byMod: Map<string, ForgeDependencyEntry[]>;
  try {
    byMod = parseForgeDependencies(text);
  } catch {
    return [];
  }
  const keyFor = (id: string): string | undefined => [...byMod.keys()].find(key => key.toLowerCase() === id.toLowerCase());
  const owners: string[] = [];
  if (ownModId !== null) {
    const key = keyFor(ownModId);
    if (key !== undefined) owners.push(key);
  } else {
    owners.push(...byMod.keys());
  }
  const ids = new Set<string>();
  for (const owner of owners) {
    for (const entry of byMod.get(owner) ?? []) {
      if ((entry.type ?? '').toLowerCase() === 'incompatible') continue;
      if (FORGE_PLATFORM_MODIDS.some(pattern => pattern.test(entry.modId))) continue;
      if ((entry.side ?? '').toUpperCase() === 'CLIENT') continue;
      ids.add(entry.modId.toLowerCase());
    }
  }
  return [...ids];
}

/** One jar's self-declared identity and dependencies, plus the L2 sideness verdict. */
export interface JarDeclaration {
  /** Basename of the jar, so a verdict always names the file it is about. */
  file?: string;
  /** The id other jars name in `depends` (`[[mods]] modId`, fabric `id`, quilt `quilt_loader.id`), or null. */
  modId: string | null;
  /** Ids this jar also answers to — fabric's `provides` (Fabric API declares `fabric`). */
  provides: string[];
  /** Mod ids this jar needs on the server (platform ids and client-only dependencies removed). */
  depends: string[];
  client: boolean;
  reasons: string[];
}

/**
 * Read one jar's descriptor for everything the side-resolution stack needs: its own id, its `provides`
 * aliases, its server-side dependencies, and whether it declares itself client-only.
 *
 * A jar that cannot be read is not an error — it is a jar nothing is known about, which must be kept.
 */
export async function scanJarDeclaration(jarPath: string): Promise<JarDeclaration> {
  const out: JarDeclaration = { file: path.basename(jarPath), modId: null, provides: [], depends: [], client: false, reasons: [] };
  try {
    const toml = await readZipEntry(jarPath, 'META-INF/mods.toml').catch(() => null)
      ?? await readZipEntry(jarPath, 'META-INF/neoforge.mods.toml').catch(() => null);
    if (toml) {
      const text = toml.toString('utf8');
      out.modId = parseForgeModId(text);
      out.depends = forgeServerDependencies(text, out.modId);
      const verdict = forgeTomlIsClientOnly(text);
      if (verdict.client && verdict.reason) { out.client = true; out.reasons.push(verdict.reason); }
    }
  } catch { /* unreadable descriptor -> keep */ }
  try {
    const fmj = await readZipEntry(jarPath, 'fabric.mod.json').catch(() => null)
      ?? await readZipEntry(jarPath, 'quilt.mod.json').catch(() => null);
    if (fmj) {
      const j = JSON.parse(fmj.toString('utf8')) as {
        id?: string; environment?: string; provides?: unknown; depends?: unknown;
        mixins?: (string | { config: string })[];
        quilt_loader?: { id?: string; provides?: unknown; depends?: unknown };
      };
      const quilt = j.quilt_loader;
      out.modId = typeof j.id === 'string' ? j.id : (typeof quilt?.id === 'string' ? quilt.id : out.modId);
      out.provides = idList(j.provides ?? quilt?.provides);
      const block = j.depends ?? quilt?.depends;
      const declared = Array.isArray(block)
        ? idList(block)
        : (block !== null && typeof block === 'object' ? Object.keys(block as Record<string, unknown>) : []);
      out.depends = declared.filter(id => !JAR_PLATFORM_MODIDS.test(id)).map(id => id.toLowerCase());
      if (j.environment === 'client') { out.client = true; out.reasons.push('fabric.mod.json environment=client'); }
      for (const cfg of j.mixins ?? []) {
        try {
          const name = typeof cfg === 'string' ? cfg : cfg.config;
          const mj = JSON.parse((await readZipEntry(jarPath, name)).toString('utf8')) as { environment?: string };
          if (mj.environment === 'client') { out.client = true; out.reasons.push(`mixin ${name} environment=client`); }
        } catch { /* optional config */ }
      }
    }
  } catch { /* unreadable descriptor -> keep */ }
  return out;
}

export async function scanJarSideness(jarPath: string): Promise<{ client: boolean; reasons: string[] }> {
  const declaration = await scanJarDeclaration(jarPath);
  return { client: declaration.client, reasons: declaration.reasons };
}
/**
 * Pure dependency-rescue decision over a scanned mods directory.
 *
 * Ported from ServerPackCreator's `ModListCompiler.compileModList` loop (lines 242-256 and `dependantOf`,
 * 280-287), which exists because a server pack that installs and then dies on load is worse than a slightly
 * larger one. Before a jar is disabled, every *kept* jar's server-side dependencies are resolved against the
 * disabled jar's id **and the aliases it declares in `provides`** — the alias half is load-bearing, not
 * defensive: Fabric API declares `"id": "fabric-api"` with `"provides": ["fabric"]`, so a mod writing
 * `depends: {"fabric": "*"}` names an id no jar in the pack calls itself.
 *
 * Iterated to a fixpoint like the reference: each rescue re-adds a jar to the kept set, which can put that
 * jar's own dependencies in play and rescue a further one.
 *
 * Fail toward keeping throughout: an unreadable jar has no id and no dependencies, so it can never cause a
 * disable, and a jar nothing depends on keeps its original verdict.
 */
export function rescueDependencies(
  disabled: readonly JarDeclaration[],
  kept: readonly JarDeclaration[],
): { keep: JarDeclaration[]; stillDisabled: JarDeclaration[] } {
  const stillDisabled = [...disabled];
  const keep = [...kept];
  // An id may be answered by several jars (duplicate installs, `provides` aliases): anything answered stays.
  const answersTo = (jar: JarDeclaration): Set<string> => {
    const ids = new Set<string>();
    if (jar.modId) ids.add(jar.modId.toLowerCase());
    for (const alias of jar.provides) ids.add(alias.toLowerCase());
    return ids;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = stillDisabled.length - 1; index >= 0; index -= 1) {
      const candidate = stillDisabled[index]!;
      const candidateIds = answersTo(candidate);
      const dependant = keep.find(keptJar =>
        keptJar.depends.some(dep => candidateIds.has(dep)));
      if (!dependant) continue;
      stillDisabled.splice(index, 1);
      keep.push(candidate);
      changed = true;
      log(`[L2] ${L2_RESCUE_RULE}: keeping ${candidate.modId ?? '(no id)'} — ${dependant.modId ?? '(no id)'} depends on it`);
    }
  }
  return { keep, stillDisabled };
}

/**
 * L2: move jars that declare themselves client-only into `mods-disabled/`, rescuing any jar a *kept* jar
 * depends on.
 *
 * `protect` is the community force-include set (`curated.ts` `protectBasenames`): those jars are required by
 * data, so they are never candidates and are part of the kept set the rescue resolves against.
 */
export async function applyJarSideness(modsDir: string, protect: Set<string> = new Set()): Promise<{ jar: string; reasons: string[] }[]> {
  const disabledDir = path.join(path.dirname(modsDir), 'mods-disabled');
  const out: { jar: string; reasons: string[] }[] = [];
  let jars: string[] = []; try { jars = readdirSync(modsDir).filter(f => /\.jar$/i.test(f)); } catch { return out; }

  // Scan everything first: the rescue needs the kept set, which is only known after every jar is read.
  const declarations = new Map<string, JarDeclaration>();
  for (const jar of jars) declarations.set(jar, await scanJarDeclaration(path.join(modsDir, jar)));

  const candidates: JarDeclaration[] = [];
  const kept: JarDeclaration[] = [];
  for (const jar of jars) {
    const declaration = declarations.get(jar)!;
    if (protect.has(jar)) { kept.push(declaration); continue; }
    if (declaration.client) candidates.push(declaration);
    else kept.push(declaration);
  }

  const { stillDisabled } = rescueDependencies(candidates, kept);
  for (const declaration of stillDisabled) {
    const jar = declaration.file;
    if (!jar || !existsSync(path.join(modsDir, jar))) continue;
    mkdirSync(disabledDir, { recursive: true });
    renameSync(path.join(modsDir, jar), path.join(disabledDir, jar));
    // Every exclusion names the rule that produced it and the evidence it acted on (research §3.6).
    const reasons = [`${L2_RULE}: ${declaration.reasons.join('; ')}`];
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

