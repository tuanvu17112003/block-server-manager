// Pure planning helpers for the world lifecycle: archive-layout classification for import,
// world-unit (overworld + nether + end) naming, export/delete/duplicate plans, and
// deterministic backup file names. No filesystem or Electron access — the I/O lives in worlds.ts.
import path from 'node:path';
import { appError } from './store';

export const DIMENSION_SUFFIXES = ['_nether', '_the_end'] as const;
export type DimensionSuffix = (typeof DIMENSION_SUFFIXES)[number];

/** Filesystem-safe world folder name (also valid as a Minecraft `level-name`). */
export function safeWorldName(value: string): string {
  const name = value.replace(/[<>:"/\\|?*\p{Cc}]/gu, '-').replace(/^[.\s-]+|[.\s-]+$/g, '');
  return name === '' ? 'world' : name;
}

/** True for `${base}_nether` / `${base}_the_end` style dimension folders (case-insensitive). */
export function isDimensionFolderName(name: string): boolean {
  const lower = name.toLowerCase();
  return DIMENSION_SUFFIXES.some((suffix) => lower.endsWith(suffix) && lower.length > suffix.length);
}

/** The dimension suffix of a folder name, or null for a base world folder. */
export function dimensionSuffixOf(name: string): DimensionSuffix | null {
  const lower = name.toLowerCase();
  for (const suffix of DIMENSION_SUFFIXES) {
    if (lower.endsWith(suffix)) return suffix;
  }
  return null;
}

/** All folder names that make up one world unit (overworld first). */
export function worldUnitFolderNames(base: string): string[] {
  return [base, ...DIMENSION_SUFFIXES.map((suffix) => `${base}${suffix}`)];
}

/** Target folder name for a unit part under a (possibly renamed) base. */
export function unitTargetName(targetBase: string, suffix: DimensionSuffix | null): string {
  return suffix === null ? targetBase : `${targetBase}${suffix}`;
}

/** First free `${base}` / `${base}-2` / `${base}-3` … name. */
export function uniqueName(taken: Iterable<string>, base: string): string {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
  throw appError('conflict', `Could not allocate a unique folder name based on "${base}".`);
}

/** First free base whose overworld/dimension folder names are all unused. */
export function uniqueWorldUnitBase(taken: Iterable<string>, base: string): string {
  const names = new Set(taken);
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    if (worldUnitFolderNames(candidate).every((name) => !names.has(name))) return candidate;
  }
  throw appError('conflict', `Could not allocate a unique world name based on "${base}".`);
}

export interface ImportArchiveDirectory {
  name: string;
  hasLevelDat: boolean;
}

export interface WorldImportInput {
  /** Archive file name (without a directory); used as the base hint for root-level worlds. */
  zipFileName: string;
  /** True when the archive has `level.dat` as a root file. */
  rootHasLevelDat: boolean;
  /** Directories directly under the archive root. */
  directories: ImportArchiveDirectory[];
}

export interface WorldImportPart {
  /** Folder name inside the extracted archive. */
  sourceName: string;
  /** null for the overworld folder; dimension suffix for sibling dimension folders. */
  suffix: DimensionSuffix | null;
}

export type WorldImportPlan =
  | { mode: 'root'; targetBaseHint: string }
  | { mode: 'unit'; sourceBase: string; targetBaseHint: string; parts: WorldImportPart[] };

function zipBaseHint(zipFileName: string): string {
  const stem = path.basename(zipFileName).replace(/\.zip$/i, '');
  return safeWorldName(stem);
}

function reject(message: string): never {
  throw appError('validation', message);
}

/**
 * Decide how to interpret an extracted world archive:
 * (a) level.dat at the archive root (single-player world);
 * (b) one folder containing level.dat (single-player world ZIP);
 * (c) server-style `world/level.dat` plus sibling `world_nether/` / `world_the_end/` folders.
 * Mixed or ambiguous archives are rejected with an actionable `validation` error.
 */
export function planWorldImport(input: WorldImportInput): WorldImportPlan {
  const directories = input.directories.map((entry) => ({ ...entry }));
  const dimensionDirs = directories.filter((entry) => isDimensionFolderName(entry.name));
  const levelDatDirs = directories.filter((entry) => entry.hasLevelDat);
  const baseCandidates = levelDatDirs.filter((entry) => !isDimensionFolderName(entry.name));

  if (input.rootHasLevelDat) {
    if (levelDatDirs.length > 0) {
      reject(
        `The archive contains level.dat at its root together with nested world folder(s) ` +
        `(${levelDatDirs.map((entry) => entry.name).sort().join(', ')}). Import one world unit per archive.`,
      );
    }
    if (dimensionDirs.length > 0) {
      reject(
        `The archive has level.dat at its root plus dimension folder(s) ` +
        `(${dimensionDirs.map((entry) => entry.name).sort().join(', ')}). ` +
        `Keep dimensions inside the world folder, or import a server-style world/ + world_nether/ archive.`,
      );
    }
    return { mode: 'root', targetBaseHint: zipBaseHint(input.zipFileName) };
  }

  if (baseCandidates.length === 0) {
    if (dimensionDirs.length > 0) {
      reject(
        `The archive only contains dimension folder(s) (${dimensionDirs.map((entry) => entry.name).sort().join(', ')}) ` +
        `without their base world folder.`,
      );
    }
    reject(
      'The archive does not contain a world: expected level.dat at the archive root ' +
      'or inside exactly one folder (for example world/level.dat).',
    );
  }
  if (baseCandidates.length > 1) {
    reject(
      `The archive contains multiple world folders (${baseCandidates.map((entry) => entry.name).sort().join(', ')}). ` +
      `Import one world at a time.`,
    );
  }

  const base = baseCandidates[0]!.name;
  if (base.toLowerCase().startsWith('.mcsm-')) {
    reject(`The archive world folder "${base}" uses a name reserved by the server manager.`);
  }
  const lowerBase = base.toLowerCase();
  const parts: WorldImportPart[] = [{ sourceName: base, suffix: null }];
  const matchedDims = new Set<string>();
  for (const suffix of DIMENSION_SUFFIXES) {
    const match = dimensionDirs.find((entry) => entry.name.toLowerCase() === `${lowerBase}${suffix}`);
    if (match === undefined) continue;
    matchedDims.add(match.name);
    parts.push({ sourceName: match.name, suffix });
  }
  const orphanDims = dimensionDirs.filter((entry) => !matchedDims.has(entry.name));
  if (orphanDims.length > 0) {
    reject(
      `Dimension folder(s) (${orphanDims.map((entry) => entry.name).sort().join(', ')}) ` +
      `do not belong to world folder "${base}". Import the matching base world or remove the orphan dimensions.`,
    );
  }
  return { mode: 'unit', sourceBase: base, targetBaseHint: safeWorldName(base), parts };
}

/** Existing folders of a world unit, in overworld/nether/end order. */
export function planWorldExport(availableNames: Iterable<string>, base: string): string[] {
  const names = new Set(availableNames);
  const resolve = (wanted: string): string | null => {
    if (names.has(wanted)) return wanted;
    const lower = wanted.toLowerCase();
    const matches = [...names].filter((name) => name.toLowerCase() === lower);
    return matches.length === 1 ? matches[0]! : null;
  };
  const baseActual = resolve(base);
  if (baseActual === null) reject(`Not a world folder: ${base}`);
  const included: string[] = [];
  for (const wanted of worldUnitFolderNames(baseActual)) {
    const actual = resolve(wanted);
    if (actual !== null) included.push(actual);
  }
  return included;
}

/** Folders to include in the safety backup that precedes deleting `worldName`. */
export function planWorldDeleteBackup(availableNames: Iterable<string>, worldName: string): string[] {
  return planWorldExport(availableNames, worldName);
}

export interface WorldDuplicatePlan {
  targetBase: string;
  copies: { source: string; target: string }[];
}

/** Unique target unit + source→target folder mapping for duplicating one world unit. */
export function planWorldDuplicate(availableNames: Iterable<string>, base: string): WorldDuplicatePlan {
  const names = new Set(availableNames);
  const resolve = (wanted: string): string | null => {
    if (names.has(wanted)) return wanted;
    const lower = wanted.toLowerCase();
    const matches = [...names].filter((name) => name.toLowerCase() === lower);
    return matches.length === 1 ? matches[0]! : null;
  };
  const baseActual = resolve(base);
  if (baseActual === null) reject(`Not a world folder: ${base}`);
  const targetBase = uniqueWorldUnitBase(names, `${baseActual}-copy`);
  const copies: { source: string; target: string }[] = [{ source: baseActual, target: targetBase }];
  for (const suffix of DIMENSION_SUFFIXES) {
    const actual = resolve(`${baseActual}${suffix}`);
    if (actual !== null) copies.push({ source: actual, target: `${targetBase}${suffix}` });
  }
  return { targetBase, copies };
}

/** Lower-case slug used in backup file names (mirrors the backup service convention). */
export function slugify(value: string): string {
  const out = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out === '' ? 'server' : out;
}

/** Filesystem-safe UTC timestamp, e.g. 2026-10-26T19-35-19-123Z. */
export function backupTimestamp(at: Date): string {
  return at.toISOString().replace(/[:.]/g, '-');
}

/** Deterministic archive name for a world-delete safety backup. */
export function worldDeleteBackupFileName(serverName: string, at: Date): string {
  return `${slugify(serverName)}-${backupTimestamp(at)}-world-delete.zip`;
}
