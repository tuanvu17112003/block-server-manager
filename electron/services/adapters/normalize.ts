// Shared archive normalization — research §6 pipeline step 2, which was specified and never implemented.
//
// The research doc (docs/research/2026-10-29-universal-modpack-install.md, line 305) requires:
//   "**Normalize** — list entries once; unwrap single nested zip; strip a single wrapping directory;
//    record an `ArchiveIndex`."
//
// Why this exists as shared code and not per-engine: the CurseForge engine already has its own unwrap
// (`findNestedServerPackZip` + an inline recursion in `inspectStagedZip`), but the adapter layer did not, and
// the consequence was measured in docs/audit/20 (D4): the real 1 GB archive
// `.app-data/cache/cfpack/466901-server-9296268.zip` has exactly 2 entries (one nested zip + readme.txt) and
// was claimed by NO adapter. Every adapter that takes an archive must see the same normalized view.
//
// Design rules, taken from the research and from ADR-0013:
//  - unwrap at MOST one nested zip (bounded depth = 1), and only when the outer archive has no format marker;
//  - strip a single top-level wrapping directory when every entry shares that prefix;
//  - never execute anything, never follow links, reuse the bounded extract helpers already in
//    `installer/core.ts` rather than adding a second zip reader;
//  - leave the caller's original archive untouched; any temporary file created is owned and cleaned by this
//    module unless the caller opts to keep it.
import fs from 'node:fs';
import path from 'node:path';
import { appError } from '../store';
import { listZip, readZipEntry } from '../installer/core';
import { buildArchiveIndex } from './registry';
import type { ArchiveIndex } from './types';

/** Format markers that mean "do not unwrap; this archive already IS a pack". */
const ROOT_FORMAT_MARKERS: readonly string[] = [
  'modrinth.index.json',
  'manifest.json',
  'mmc-pack.json',
  'instance.json',
  'pack.toml',
  'modpack.toml',
  'server-manifest.json',
  'mcbbs.packmeta',
  'gdlpack.json',
  'version.json',
];

/** Sibling files that may legitimately accompany a wrapper zip without being payload. */
const HARMLESS_SIBLING = /\.(txt|md|html?|url|json|png|jpg|jpeg|gif)$/i;

export interface NormalizeOptions {
  /** Keep the unwrapped temporary file; caller must delete it. Default false. */
  keepUnwrapped?: boolean;
  /** Directory to place the unwrapped temp zip in. Defaults to the source archive's directory. */
  stagingDir?: string;
  log?: (message: string) => void;
}

export interface NormalizeResult {
  /** The archive that actually contains the pack (may be the unwrapped inner zip). */
  effectivePath: string;
  /** Index of the effective archive, already wrapper-stripped. */
  index: ArchiveIndex;
  /** True when a single nested zip was unwrapped. */
  unwrapped: boolean;
  /** Basename of the nested zip that was unwrapped, if any. */
  nestedZip: string | null;
  /** Top-level wrapping directory that was stripped, if any. */
  strippedPrefix: string | null;
  /** Temporary file to remove, when `keepUnwrapped` is true and unwrapping happened. */
  tempPath: string | null;
  /** How many entries the original (outer) archive had. */
  outerEntryCount: number;
}

/** True when the archive root states its own format, so unwrapping would be wrong. */
export function hasRootFormatMarker(names: readonly string[]): boolean {
  return names.some(name => {
    const normalized = name.replaceAll('\\', '/');
    // Only root-level names count; a marker nested in a folder is not a root marker.
    if (normalized.includes('/')) return false;
    return ROOT_FORMAT_MARKERS.includes(normalized.toLowerCase());
  });
}

/**
 * Detect a single-nested-zip wrapper. Mirrors the shape of `findNestedServerPackZip` in curseforge.ts but
 * stays here so every adapter shares one rule: exactly one `.zip`, everything else harmless metadata.
 */
export function findWrapperZip(files: readonly { name: string }[]): string | null {
  const real = files.filter(entry => !entry.name.endsWith('/'));
  const nested = real.filter(entry => /\.zip$/i.test(entry.name));
  if (nested.length !== 1) return null;
  const rest = real.filter(entry => !/\.zip$/i.test(entry.name));
  const harmless = rest.every(entry => HARMLESS_SIBLING.test(entry.name));
  return harmless ? nested[0]!.name : null;
}

/**
 * Find the single top-level directory shared by every entry, e.g. all entries start with `PackName/`.
 * Returns null when there is no single wrapper, or when the archive is only that directory.
 */
export function findWrapperPrefix(names: readonly string[]): string | null {
  const files = names.filter(name => !name.endsWith('/')).map(name => name.replaceAll('\\', '/'));
  if (files.length === 0) return null;
  const segments = files.map(name => name.split('/'));
  // Every file must be at least two levels deep for a wrapper to exist.
  if (segments.some(parts => parts.length < 2)) return null;
  const first = segments[0]![0]!;
  if (!segments.every(parts => parts[0] === first)) return null;
  return first;
}

/**
 * Normalize an archive for adapter detection: unwrap one nested zip if needed, then report the index the
 * adapters should actually see (wrapper prefix applied).
 *
 * The returned `index` is a fresh `ArchiveIndex` over the effective archive's raw entries. Prefix stripping is
 * reported separately (`strippedPrefix`) rather than mutating entry names, so adapters can decide: a format
 * whose markers live at the archive root wants the stripped view, while a payload dump does not.
 */
export async function normalizeArchive(archivePath: string, opts: NormalizeOptions = {}): Promise<NormalizeResult> {
  const log = opts.log ?? (() => {});
  if (!fs.existsSync(archivePath)) throw appError('not-found', `Archive not found: ${archivePath}`);

  const outerEntries = await listZip(archivePath);
  const outerNames = outerEntries.map(entry => entry.name.replaceAll('\\', '/'));
  let effectivePath = archivePath;
  let unwrapped = false;
  let nestedZip: string | null = null;
  let tempPath: string | null = null;

  // ---- unwrap at most ONE nested zip, and only when the root carries no format marker ----
  if (!hasRootFormatMarker(outerNames)) {
    const wrapper = findWrapperZip(outerEntries.map(entry => ({ name: entry.name })));
    if (wrapper) {
      const dir = opts.stagingDir ?? path.dirname(archivePath);
      const target = path.join(dir, `.msm-unwrapped-${Date.now()}-${path.basename(wrapper)}`);
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, await readZipEntry(archivePath, wrapper));
        // Guard: the inner archive must be readable and must not itself be another pure wrapper at depth 2.
        const innerEntries = await listZip(target);
        const innerNames = innerEntries.map(entry => entry.name.replaceAll('\\', '/'));
        if (!hasRootFormatMarker(innerNames)) {
          const secondWrapper = findWrapperZip(innerEntries.map(entry => ({ name: entry.name })));
          if (secondWrapper) {
            // Depth is bounded at 1 by design; report rather than recurse.
            log(`[normalize] refusing to unwrap more than one nested zip (depth-2 wrapper "${secondWrapper}")`);
            fs.rmSync(target, { force: true });
            throw appError('validation',
              `Archive nests a zip inside a zip inside another zip (depth 2 at "${secondWrapper}"). `
              + 'Only a single wrapper level is supported; extract the inner archive manually.');
          }
        }
        effectivePath = target;
        unwrapped = true;
        nestedZip = wrapper;
        tempPath = opts.keepUnwrapped ? target : null;
        log(`[normalize] unwrapped nested zip "${wrapper}" (${outerNames.length} outer entries)`);
      } catch (error) {
        if (!opts.keepUnwrapped) fs.rmSync(target, { force: true });
        throw error;
      }
    }
  }

  // ---- wrapper-directory detection on the effective archive ----
  const effectiveEntries = effectivePath === archivePath ? outerEntries : await listZip(effectivePath);
  const effectiveNames = effectiveEntries.map(entry => entry.name.replaceAll('\\', '/'));
  const strippedPrefix = findWrapperPrefix(effectiveNames);
  if (strippedPrefix) log(`[normalize] single wrapping directory "${strippedPrefix}" detected`);

  const index = await buildArchiveIndex(effectivePath);
  if (!opts.keepUnwrapped && unwrapped) {
    // The index is memoized over the file; deleting now would break later reads, so the caller must keep it
    // until it is done. Document the ownership explicitly instead of a silent leak.
    log('[normalize] note: the unwrapped temp archive is kept until the caller deletes it');
  }
  return {
    effectivePath,
    index,
    unwrapped,
    nestedZip,
    strippedPrefix,
    tempPath,
    outerEntryCount: outerEntries.length,
  };
}

/** Remove the temporary file created by `normalizeArchive`, if any. Safe to call repeatedly. */
export function cleanupNormalized(result: Pick<NormalizeResult, 'effectivePath' | 'tempPath'> & { unwrapped: boolean }): void {
  const target = result.tempPath ?? (result.unwrapped ? result.effectivePath : null);
  if (!target) return;
  try {
    fs.rmSync(target, { force: true });
  } catch {
    /* best effort: a leftover temp file must never fail an install */
  }
}

/** Build an index view where a single wrapping directory has been stripped from every entry name. */
export function stripPrefixFromIndex(index: ArchiveIndex, prefix: string): ArchiveIndex {
  const normalizedPrefix = `${prefix.replaceAll('\\', '/').replace(/\/+$/, '')}/`;
  const readText = async (name: string): Promise<string | null> => index.readText(`${normalizedPrefix}${name}`);
  const has = (name: string): boolean => index.names.has(`${normalizedPrefix}${name}`);
  void has;
  return {
    entries: index.entries
      .filter(entry => entry.name.replaceAll('\\', '/').startsWith(normalizedPrefix))
      .map(entry => ({ ...entry, name: entry.name.replaceAll('\\', '/').slice(normalizedPrefix.length) })),
    names: new Set(
      index.entries
        .map(entry => entry.name.replaceAll('\\', '/'))
        .filter(name => name.startsWith(normalizedPrefix))
        .map(name => name.slice(normalizedPrefix.length)),
    ),
    readText,
    readJson: async <T = unknown>(name: string): Promise<T | null> => {
      const text = await readText(name);
      if (text === null) return null;
      try {
        return JSON.parse(text) as T;
      } catch {
        return null;
      }
    },
    under: (prefixPath: string): string[] => {
      const normalized = prefixPath.replaceAll('\\', '/').replace(/^\.\/+/, '').toLowerCase();
      return index.under(normalizedPrefix)
        .map(name => name.replaceAll('\\', '/').slice(normalizedPrefix.length))
        .filter(name => name.toLowerCase().startsWith(normalized));
    },
  };
}
