// Deferred pack formats — formats whose signature we can recognise but deliberately do not install yet.
//
// Why this exists (docs/audit/26 Item 5): before this module, a user who dropped an MCBBS, HMCL, GDLauncher or
// Technic pack got the generic "Unrecognized modpack format (checked 42 entries; root files: …)". That message is
// true but useless and slightly dishonest: the format is not *unrecognised*, it is **known and deliberately
// deferred**. Telling those apart matters — the first invites the user to try again or report a bug, the second
// tells them the truth and points at the reason we recorded.
//
// Signatures come from the research table §2 rows 1/4/9/10, which cites each format's own manifest filename. The
// reasons mirror `scripts/conformance-waivers.json` so the app and the conformance report cannot disagree about
// what is deferred and why; a test asserts the two stay in step.
//
// Rule: this module NEVER makes a format installable. It only turns a dead end into an explanation. A format
// listed here must produce a deferred message; a pack matching nothing must still produce the generic one.

import type { ArchiveIndex } from './types';

export interface DeferredFormat {
  /** Stable id, matching the research §2 row where possible. */
  id: string;
  /** Human name, as the research table writes it. */
  name: string;
  /** Archive entry names that identify this format. All must be present for a match. */
  markers: readonly string[];
  /** Why it is not supported yet — the same sentence the conformance waivers record. */
  reason: string;
}

/**
 * Formats we can recognise but intentionally do not support.
 *
 * Ordered most-specific first: Technic's `bin/modpack.jar` is a weak signal on its own, so it is matched by that
 * plus the presence of a `bin/` directory, and it comes last so a stronger marker wins.
 */
export const DEFERRED_FORMATS: readonly DeferredFormat[] = [
  {
    id: 'mcbbs',
    name: 'MCBBS',
    markers: ['mcbbs.packmeta'],
    reason: 'regional (Chinese) format with no public specification and no real artefact on hand; measured E4 only',
  },
  {
    id: 'hmcl.server',
    name: 'HMCL server',
    markers: ['server-manifest.json'],
    reason: 'no real artefact has been measured, and it is not on the current plan’s critical path',
  },
  {
    id: 'gdlauncher',
    name: 'GDLauncher',
    markers: ['gdlpack.json'],
    reason: 'no real artefact has been measured; its manifest is hash-only resolution and needs provider work first',
  },
  {
    id: 'technic',
    name: 'Technic',
    markers: ['bin/modpack.jar'],
    reason: 'no real artefact has been measured; only the Solder read API is public and it has the lowest install share',
  },
] as const;

/**
 * Identify a deferred format from an archive listing.
 *
 * Returns null when nothing matches, so the caller keeps its generic message. Matching is by exact entry name
 * (case-insensitive) rather than extension, because a format's identity is its manifest filename — the same rule
 * the reference implementations use (research §2, `ModpackManifestParser.kt`).
 */
export function identifyDeferredFormat(index: ArchiveIndex): DeferredFormat | null {
  const names = new Set([...index.names].map(name => name.toLowerCase()));
  for (const format of DEFERRED_FORMATS) {
    if (format.markers.every(marker => names.has(marker.toLowerCase()))) return format;
  }
  return null;
}

/** The message shown when a pack is a known-but-deferred format. */
export function deferredFormatMessage(format: DeferredFormat): string {
  return `${format.name} packs are recognised but not supported by this build yet. `
    + `${format.reason}. `
    + 'Nothing was downloaded or changed. Convert the pack to Modrinth, CurseForge or packwiz format to install it.';
}

