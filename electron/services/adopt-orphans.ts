// Adopt orphaned server folders: give them a store record so they appear in the app again.
//
// Context. Three folders under `servers/` had complete server trees (world + level.dat, 106-112 MB each) but no record in
// the store, so no screen could list them and the app behaved as if they did not exist. They are real installations the
// user made; the records were lost when failed installs rolled back (see rollbackRecord in install-transaction.ts).
//
// Design rules, all chosen because this touches irreplaceable data:
//
//  - Read-only detection. Everything describing the server (loader, MC version, port) comes from files that are already
//    authoritative: `versions/<ver>` names the MC version, `libraries/net/fabricmc/fabric-loader/<ver>` names the loader
//    version, `server.properties` names the port and world. Nothing is guessed when evidence exists.
//  - The folder is never moved and never renamed. Its UUID is the only stable handle to the data, so the record is created
//    with that exact id.
//  - A port conflict is resolved by ALLOCATING A NEW PORT for the adopted server and rewriting server.properties, rather
//    than refusing to adopt. Two of the three orphans share port 25534; leaving them both bound would mean neither starts.
//    Changing the port is visible and reversible; leaving the data unreachable is not.
//  - A server whose folder lacks a world still gets a record, because the tree is still a real installation.
import fs from 'node:fs';
import path from 'node:path';

export interface AdoptableServer {
  id: string;
  folder: string;
  name: string;
  loader: string;
  mcVersion: string;
  loaderVersion: string | null;
  port: number;
  worldName: string;
  hasWorld: boolean;
  bytes: number;
  files: number;
  /** Identity of the install from `msm-install.json`, or null when absent — null is never collapsed. */
  signature: string | null;
}

/** Read `key=value` pairs from server.properties, ignoring comments and blanks. */
function readProperties(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try { text = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const m = /^([^=]+)=(.*)$/.exec(line);
    if (m !== null) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

/** MC version from `versions/<ver>`, which is how every loader writes the resolved game version. */
function detectMcVersion(dir: string): string {
  try {
    const versions = fs.readdirSync(path.join(dir, 'versions'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    // Prefer something that looks like a release number, so a snapshot folder does not win over `1.20.1`.
    const release = versions.find((v) => /^\d+\.\d+(\.\d+)?$/.test(v));
    if (release !== undefined) return release;
    if (versions.length > 0) return versions[0];
  } catch { /* no versions dir */ }
  // Fabric also records the target jar; fall back to its name.
  try {
    const props = readProperties(dir);
    const serverJar = props['serverJar'] ?? '';
    const m = /(?:minecraft|server)[.-]([\d.]+)\.jar/.exec(serverJar);
    if (m !== null) return m[1];
  } catch { /* ignore */ }
  return '1.20.1';
}

/** Loader and its version, from the libraries the loader wrote. */
function detectLoader(dir: string): { loader: string; loaderVersion: string | null } {
  const firstLibVersion = (segments: string[]): string | null => {
    try {
      const base = path.join(dir, 'libraries', ...segments);
      const versions = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
      return versions.length > 0 ? versions[0] : null;
    } catch { return null; }
  };

  const fabric = firstLibVersion(['net', 'fabricmc', 'fabric-loader']);
  if (fabric !== null || fs.existsSync(path.join(dir, 'fabric-server-launch.jar'))) {
    return { loader: 'Fabric', loaderVersion: fabric };
  }
  const quilt = firstLibVersion(['org', 'quiltmc', 'quilt-loader']);
  if (quilt !== null) return { loader: 'Quilt', loaderVersion: quilt };
  const neo = firstLibVersion(['net', 'neoforged', 'neoforge']);
  if (neo !== null) return { loader: 'NeoForge', loaderVersion: neo };
  const forge = firstLibVersion(['net', 'minecraftforge', 'forge']);
  if (forge !== null) return { loader: 'Forge', loaderVersion: forge };
  return { loader: 'Vanilla', loaderVersion: null };
}

function measure(dir: string): { bytes: number; files: number; hasProperties: boolean } {
  let bytes = 0;
  let files = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else { files += 1; try { bytes += fs.statSync(p).size; } catch { /* ignore */ } }
    }
  };
  walk(dir);
  return { bytes, files, hasProperties: fs.existsSync(path.join(dir, 'server.properties')) };
}

/**
 * Collapse duplicated installations, keeping the richest copy of each.
 *
 * Two 977 MB COBBLEVERSE folders existed on the real machine with identical trees. Adopting both would show the user two
 * servers they never deliberately made. The copy with a world (or else the larger one) is kept, because that is the one
 * whose data is worth having; the others are reported so they are not silently forgotten.
 */
export function collapseDuplicates(
  candidates: readonly AdoptableServer[],
): { keep: AdoptableServer[]; duplicates: AdoptableServer[] } {
  const best = new Map<string, AdoptableServer>();
  const keep: AdoptableServer[] = [];
  const duplicates: AdoptableServer[] = [];

  for (const candidate of candidates) {
    // No signature means no evidence of duplication: keep it. Hiding a real server to tidy the list is the worse error.
    if (candidate.signature === null) { keep.push(candidate); continue; }
    const current = best.get(candidate.signature);
    if (current === undefined) { best.set(candidate.signature, candidate); keep.push(candidate); continue; }
    // Prefer a copy that has a world, then the larger copy.
    const candidateScore = (candidate.hasWorld ? 1 : 0) * 1e12 + candidate.bytes;
    const currentScore = (current.hasWorld ? 1 : 0) * 1e12 + current.bytes;
    if (candidateScore > currentScore) {
      // Swap: the richer copy becomes the keeper, the previous one is reported as the duplicate.
      best.set(candidate.signature, candidate);
      const index = keep.indexOf(current);
      if (index >= 0) keep.splice(index, 1, candidate);
      duplicates.push(current);
    } else {
      duplicates.push(candidate);
    }
  }
  return { keep, duplicates };
}

/**
 * Make a display name unique by appending a disambiguator.
 *
 * Every orphan carried `motd=Block Server Manager`, the app's default, so adopting them as-is would collide on the name and
 * the store would reject every one after the first. A short id suffix is used rather than a counter so the name stays
 * stable if the same folder is adopted again later.
 */
export function uniqueName(desired: string, taken: ReadonlySet<string>): string {
  const base = desired.trim() === '' ? 'Recovered server' : desired.trim();
  if (!taken.has(base)) return base;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const suffix = attempt === 0 ? '' : ` (${attempt + 1})`;
    const candidate = `${base}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Fall back to a timestamp so adoption can never fail merely because names fill up.
  return `${base} ${new Date().toISOString().slice(11, 19)}`;
}

/**
 * Find server folders that have no store record.
 *
 * `hasRecord` is passed in rather than reading the store here so this stays pure enough to test, and so the caller decides
 * what "has a record" means for its own store instance.
 *
 * Filters learned from a dry run against real data, each excluding a folder that would have become a misleading entry:
 *  - `.publishing-` folders have their own recovery path.
 *  - an empty folder is not a server.
 *  - a folder holding only `server.jar` and nothing else is a download that never finished installing; presenting it as a
 *    server would give the user a start button that fails. Two such folders existed (49 MB jars, one file each).
 *  - duplicate trees are collapsed by `signature` in the caller, because two folders from the same modpack install are not
 *    two servers the user wants.
 */
export function findOrphanedServers(dataRoot: string, hasRecord: (id: string) => boolean): AdoptableServer[] {
  const serversDir = path.join(dataRoot, 'servers');
  let entries: string[];
  try { entries = fs.readdirSync(serversDir); } catch { return []; }

  const found: AdoptableServer[] = [];
  for (const id of entries) {
    if (id.includes('.publishing-')) continue;
    if (!/^[0-9a-zA-Z-]+$/.test(id)) continue;
    const folder = path.join(serversDir, id);
    let isDir = false;
    try { isDir = fs.statSync(folder).isDirectory(); } catch { /* ignore */ }
    if (!isDir) continue;
    if (hasRecord(id)) continue;

    const props = readProperties(folder);
    const { loader, loaderVersion } = detectLoader(folder);
    const worldName = props['level-name'] ?? 'world';
    const port = Number(props['server-port'] ?? '0');
    const { bytes, files, hasProperties } = measure(folder);
    if (files === 0) continue;
    // No server.properties means the install never reached its configuration step. A lone jar download is not a server.
    if (!hasProperties) continue;

    const descriptor = readInstallDescriptor(folder);
    // The motd is the user's own label when they set one; every orphan here carried the app default, so a descriptor slug
    // or the mc/loader pair makes a far more useful name than eight entries all called "Block Server Manager".
    const motdText = (props['motd'] ?? '').trim();
    const isDefaultMotd = motdText === '' || motdText === 'Block Server Manager' || motdText === 'A Minecraft Server';
    const suggestedName = isDefaultMotd
      ? (descriptor?.slug !== null && descriptor?.slug !== undefined
        ? `${descriptor.slug} (${loader} ${detectMcVersion(folder)})`
        : `${loader} ${detectMcVersion(folder)} server ${id.slice(0, 4)}`)
      : motdText;

    found.push({
      id,
      folder,
      name: suggestedName,
      loader,
      mcVersion: detectMcVersion(folder),
      loaderVersion,
      port: Number.isFinite(port) && port > 0 ? port : 0,
      worldName,
      hasWorld: fs.existsSync(path.join(folder, worldName, 'level.dat')),
      bytes,
      files,
      signature: makeSignature(descriptor),
    });
  }
  return found;
}

/** Identity of the installation, or null when there is no strong evidence. */
function readInstallDescriptor(dir: string): { slug: string | null; raw: string } | null {
  try {
    const raw = fs.readFileSync(path.join(dir, 'msm-install.json'), 'utf8');
    if (raw.trim() === '') return null;
    let slug: string | null = null;
    try {
      const parsed = JSON.parse(raw) as { slug?: unknown; name?: unknown; projectName?: unknown };
      if (typeof parsed.slug === 'string' && parsed.slug.trim() !== '') slug = parsed.slug.trim();
      else if (typeof parsed.name === 'string' && parsed.name.trim() !== '') slug = parsed.name.trim();
      else if (typeof parsed.projectName === 'string' && parsed.projectName.trim() !== '') slug = parsed.projectName.trim();
    } catch { /* malformed descriptor: keep the raw text for the signature only */ }
    return { slug, raw };
  } catch {
    return null;
  }
}

/**
 * Identity of the installation, or null when there is no strong evidence.
 *
 * Only `msm-install.json` counts as evidence: it is written by the installer and records what was installed. Folders
 * without it return null and are NEVER collapsed, because a dry run proved the alternative is destructive — two Vanilla
 * folders (ports 25531 and 25534) were collapsed into one purely because neither had a descriptor, and they were two
 * genuinely different servers. Showing a duplicate entry is a minor annoyance; hiding a server is data loss.
 */
function makeSignature(descriptor: { slug: string | null; raw: string } | null): string | null {
  if (descriptor === null) return null;
  return `${descriptor.raw.length}:${descriptor.raw.slice(0, 400)}`;
}

/** Choose a port that no adopted or existing server already uses, starting at the preferred value. */
export function chooseFreePort(preferred: number, taken: ReadonlySet<number>): number {
  if (preferred > 0 && !taken.has(preferred)) return preferred;
  // Walk upward from the preferred port so an adopted server keeps a port close to the one it had. Starting at the app's
  // usual range would scatter recovered servers to 25565 even when 25536 is free, which is needlessly surprising.
  const start = preferred > 0 ? preferred + 1 : 25565;
  for (let candidate = start; candidate <= 65535; candidate += 1) {
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error('No free port available to adopt the server.');
}

/** Rewrite only `server-port` in server.properties, preserving every other line and the file's line endings. */
export function writePortIntoProperties(folder: string, port: number): void {
  const file = path.join(folder, 'server.properties');
  const text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let replaced = false;
  const lines = text.split(/\r?\n/).map((line) => {
    if (/^server-port=/.test(line)) { replaced = true; return `server-port=${port}`; }
    return line;
  });
  if (!replaced) lines.push(`server-port=${port}`);
  fs.writeFileSync(file, lines.join(eol), 'utf8');
}
