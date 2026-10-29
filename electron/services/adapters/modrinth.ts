// Modrinth adapter â€” shape A (archive) and shape B (provider), DELEGATING to the existing engine.
//
// Why this file exists at all is a QA finding, not a feature: research Â§8 line 347 said
//   "First adapters: modrinth, curseforge, serverpack, bare (covers everything the app does today, via the new
//    path, so no regression)"
// and that order was inverted during P1c, which left the adapter layer with no Modrinth adapter at all â€” so
// both real `.mrpack` files in `.app-data/cache/mrpack/` were claimed by nothing (docs/audit/20 D1).
//
// Invariant I2 (docs/audit/23 Â§4.2): an adapter RECOGNISES and NORMALISES; it delegates execution to the
// proven engine. So this module never parses a `.mrpack` itself â€” it calls `resolveMrpack` from
// `installer/modrinth.ts`, which is already exercised by the 12-pack matrix and the real end-to-end runs.
//
// Side mapping is the only real decision here, and it is deliberately conservative:
//   `env.server` = 'required' | 'optional' | 'unsupported'  â†’ that exact value
//   `env.server` absent                                     â†’ 'unknown'
// 'unknown' is a first-class value in the recipe (types.ts) precisely because collapsing "the manifest says
// nothing" into either 'required' or 'unsupported' is what silently corrupts a server install.
import { appError } from '../store';
import { resolveMrpack, splitDeps, type MrIndex } from '../installer/modrinth';
import {
  MANAGER_OWNED_PATHS,
  isSafeRelativePath,
  type AdapterIo,
  type ArchiveIndex,
  type DetectInput,
  type FileSide,
  type LoaderFamily,
  type PackAdapter,
  type PackRecipe,
  type PlannedFile,
  type RecipeWarning,
} from './types';

/** mrpack loader keys â†’ canonical loader family (mirrors LOADER_OF in the engine, kept explicit here). */
const MRPACK_LOADERS: readonly { key: string; loader: LoaderFamily }[] = [
  { key: 'neoforge', loader: 'neoforge' },
  { key: 'forge', loader: 'forge' },
  { key: 'quilt-loader', loader: 'quilt' },
  { key: 'fabric-loader', loader: 'fabric' },
];

/**
 * Map one mrpack `env.server` declaration onto the canonical side.
 * Absent/blank â‡’ `unknown` (never guessed). An unrecognised value â‡’ `unknown` too, with provenance.
 */
export function mrpackFileSide(serverEnv: string | null | undefined): { side: FileSide; provenance: string } {
  const value = (serverEnv ?? '').trim().toLowerCase();
  if (value === 'required') return { side: 'required', provenance: 'mrpack env.server="required"' };
  if (value === 'optional') return { side: 'optional', provenance: 'mrpack env.server="optional"' };
  if (value === 'unsupported') return { side: 'unsupported', provenance: 'mrpack env.server="unsupported"' };
  if (value === '') return { side: 'unknown', provenance: 'mrpack env.server absent â‡’ unknown' };
  return { side: 'unknown', provenance: `mrpack env.server="${value}" (unrecognised) â‡’ unknown` };
}

/** Extract loader + build + MC from an mrpack index through the engine's own parser. */
export function mrpackRuntime(index: MrIndex): { loader: LoaderFamily; loaderVersion: string | null; mc: string } {
  const deps = splitDeps(index);
  const loader = (deps.kind ?? 'vanilla') as LoaderFamily;
  return { loader, loaderVersion: deps.ver, mc: deps.mc };
}

/**
 * Build the canonical recipe from an already-resolved mrpack index.
 * Pure so it can be unit-tested, and so the same mapping is used for archive and provider inputs.
 */
export function buildMrpackRecipe(input: {
  index: MrIndex;
  name?: string;
  slug?: string | null;
}): PackRecipe {
  const { index } = input;
  const runtime = mrpackRuntime(index);
  const warnings: RecipeWarning[] = [];
  const files: PlannedFile[] = [];
  const byPath = new Map<string, PlannedFile>();
  let duplicatePaths = 0;

  for (const file of index.files) {
    const target = String(file.path ?? '').replaceAll('\\', '/').replace(/^\.?\/+/, '');
    if (target === '') continue;
    if (!isSafeRelativePath(target)) {
      warnings.push({ rule: 'modrinth.unsafe-path', message: 'file path escapes the server directory; skipped.', path: target });
      continue;
    }
    if (MANAGER_OWNED_PATHS.includes(target.toLowerCase())) continue;
    if (byPath.has(target)) { duplicatePaths += 1; continue; }
    const mapped = mrpackFileSide(file.env?.server);
    const urls = (file.downloads ?? []).filter((url): url is string => typeof url === 'string' && url !== '');
    if (urls.length === 0) {
      warnings.push({ rule: 'modrinth.file-no-url', message: 'mrpack file has no download URL; skipped.', path: target });
      continue;
    }
    byPath.set(target, {
      path: target,
      source: { urls },
      sha1: file.hashes?.sha1 ?? null,
      sha512: file.hashes?.sha512 ?? null,
      size: typeof file.fileSize === 'number' ? file.fileSize : null,
      side: mapped.side,
      sideProvenance: mapped.provenance,
    });
  }

  if (duplicatePaths > 0) {
    warnings.push({
      rule: 'modrinth.duplicate-destination',
      message: `${duplicatePaths} file entr${duplicatePaths === 1 ? 'y' : 'ies'} targeted an already-planned path; the first was kept.`,
    });
  }
  if (runtime.mc.trim() === '') {
    throw appError('validation', 'mrpack index declares no minecraft dependency; refusing to guess a runtime.');
  }

  return {
    formatId: 'modrinth.mrpack',
    name: input.name?.trim() || 'Modrinth pack',
    mc: runtime.mc,
    loader: runtime.loader,
    loaderVersion: runtime.loaderVersion,
    javaMajor: null,
    files: [...byPath.values()],
    // mrpack payload that is not a downloads[] entry ships in overrides/ and server-overrides/; the engine
    // already applies those, and client-overrides must never reach a server (enforced in validateRecipe).
    overrides: [
      { prefix: 'overrides/', order: 1 },
      { prefix: 'server-overrides/', order: 2 },
    ],
    launchShape: runtime.loader === 'fabric' || runtime.loader === 'quilt' ? 'launch-jar' : 'generated-args',
    managerOwned: [...MANAGER_OWNED_PATHS],
    warnings,
    resolution: [
      { field: 'mc', source: 'modrinth.index.json dependencies.minecraft' },
      { field: 'loader', source: runtime.loader === 'vanilla' ? 'no loader dependency' : `modrinth.index.json dependencies (${runtime.loader})` },
      { field: 'files', source: 'modrinth.index.json files[] (downloads + hashes)' },
      { field: 'side', source: 'files[].env.server, absent â‡’ unknown' },
      ...(input.slug ? [{ field: 'project', source: `modrinth project ${input.slug}` }] : []),
    ],
  };
}

/** Read the mrpack index straight out of an archive (thin, so detection never needs the network). */
async function readIndexFromArchive(archiveIndex: ArchiveIndex | undefined): Promise<MrIndex | null> {
  if (!archiveIndex) return null;
  const parsed = await archiveIndex.readJson<MrIndex>('modrinth.index.json');
  return parsed ?? null;
}

/** Validate the mrpack signature keys, per research Â§2 row 3. */
export function isMrpackIndex(raw: unknown): raw is MrIndex {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const candidate = raw as Partial<MrIndex>;
  return candidate.formatVersion === 1
    && candidate.game === 'minecraft'
    && Array.isArray(candidate.files)
    && typeof candidate.dependencies === 'object'
    && candidate.dependencies !== null;
}

export const modrinthAdapter: PackAdapter = {
  id: 'modrinth.mrpack',
  displayName: 'Modrinth (.mrpack)',
  // Highest priority: the only format whose manifest carries per-file sides and full CDN URLs.
  priority: 90,
  shapes: ['archive', 'provider'],

  async detect(input: DetectInput): Promise<boolean> {
    if (input.shape === 'provider') return input.kind === 'modrinth';
    if (input.shape !== 'archive') return false;
    const raw = await readIndexFromArchive(input.index);
    return isMrpackIndex(raw);
  },

  async resolve(input: DetectInput, io: AdapterIo): Promise<PackRecipe> {
    if (input.shape === 'provider') {
      if (input.kind !== 'modrinth') throw appError('validation', 'modrinth adapter received a non-Modrinth provider input.');
      const projectId = input.ids.projectId === undefined ? undefined : String(input.ids.projectId);
      const versionId = input.ids.versionId === undefined ? undefined : String(input.ids.versionId);
      if (!projectId && !versionId) throw appError('validation', 'Modrinth provider input needs projectId or versionId.');
      io.log(`[modrinth] resolving provider ${projectId ?? ''}${versionId ? ` version ${versionId}` : ''}`);
      // Delegation: the engine owns version resolution, download and hashing.
      const resolved = await resolveMrpack(
        { ...(projectId ? { projectId } : {}), ...(versionId ? { versionId } : {}) },
        input.cacheDir ?? '',
      );
      return buildMrpackRecipe({ index: resolved.index, name: resolved.index.name, slug: resolved.slug });
    }

    if (input.shape !== 'archive') {
      throw appError('validation', `modrinth adapter cannot handle a "${input.shape}" input.`);
    }
    const raw = await readIndexFromArchive(input.index);
    if (!isMrpackIndex(raw)) {
      throw appError('validation', 'archive has no valid modrinth.index.json (formatVersion 1, game "minecraft", files[]).');
    }
    io.log(`[modrinth] "${raw.name}" ${raw.files.length} files from modrinth.index.json`);
    return buildMrpackRecipe({ index: raw, name: raw.name });
  },
};

