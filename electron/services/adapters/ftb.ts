// FTB (Feed The Beast) adapter — public API, no key required.
//
// Why this adapter is the generality proof: FTB is a format this app could not open at all, it needs no
// API key (unlike CurseForge), and it carries exactly the metadata a canonical recipe needs. Verified
// live against the real API (docs/research/2026-10-29-claim-verification.md §13):
//   GET api.modpacks.ch/public/modpack/{id}          → pack + versions + per-version targets
//   GET api.modpacks.ch/public/modpack/{id}/{verId}  → files[] with clientonly/serveryonly/optional + sha1 + size
// A real file download returned matching size and SHA-1 with no authentication.
//
// Detection note: FTB App *instances* on disk are identified by `instance.json` carrying
// `uuid,id,versionId,mcVersion,modLoader`; a remote FTB pack is identified by its provider hint. Both
// route through this adapter so one recipe shape covers local and remote FTB inputs.
import { appError } from '../store';
import {
  MANAGER_OWNED_PATHS,
  type AdapterIo,
  type DetectContext,
  type FileSide,
  type LoaderFamily,
  type PackAdapter,
  type PackRecipe,
  type PlannedFile,
  type RecipeWarning,
} from './types';

export const FTB_ALLOWED_HOSTS: readonly string[] = ['api.modpacks.ch', 'api.feed-the-beast.com', 'dist.modpacks.ch'];

/** Public API base. `api.modpacks.ch` is the live host; the feed-the-beast.com name redirects to it. */
const FTB_API_BASE = 'https://api.modpacks.ch/public';

/** Shape of one target entry (`forge` / `minecraft` / `java` / `fabric` / `neoforge`). */
interface FtbTarget { id: number; name: string; type: string; version: string }

interface FtbVersionRef { id: number; name: string; type: string; targets?: FtbTarget[]; updated?: number }

interface FtbPack {
  id: number;
  name: string;
  versions?: FtbVersionRef[];
}

interface FtbFile {
  version?: string;
  /** Relative destination path, e.g. `./mods/foo.jar`. */
  path: string;
  url: string;
  mirrors?: string[];
  sha1?: string;
  size?: number;
  clientonly?: boolean;
  serveronly?: boolean;
  optional?: boolean;
  type?: string;
  name?: string;
}

interface FtbVersionDetail {
  id: number;
  name: string;
  targets?: FtbTarget[];
  files?: FtbFile[];
}

/** Target names the FTB API uses for loaders, mapped onto our canonical families. */
const LOADER_TARGETS: Record<string, LoaderFamily> = {
  forge: 'forge',
  neoforge: 'neoforge',
  fabric: 'fabric',
  quilt: 'quilt',
};

/** Local FTB App instance marker (the 179-byte `version.json` is not needed; `instance.json` is enough). */
interface FtbInstanceJson {
  uuid?: string;
  id?: number | string;
  versionId?: number | string;
  name?: string;
  mcVersion?: string;
  modLoader?: string;
}

/** Parse `"forge-14.23.5.2846"` / `"neoforge-21.1.9"` / `"fabric-0.15.0"` into family + version. */
export function parseFtbModLoader(modLoader: string | undefined | null): { loader: LoaderFamily; version: string | null } {
  const value = (modLoader ?? '').trim();
  if (value === '') return { loader: 'vanilla', version: null };
  const match = value.match(/^(forge|neoforge|fabric|quilt)(?:-(.+))?$/i);
  if (!match) return { loader: 'vanilla', version: null };
  return { loader: LOADER_TARGETS[match[1]!.toLowerCase()] ?? 'vanilla', version: match[2]?.trim() || null };
}

/**
 * Map FTB's three flags onto the canonical side value.
 * `serveronly` wins (server needs it, client does not); `clientonly` means a dedicated server must skip it.
 * Everything else is shared, and `optional` only downgrades a shared file — it never hides a server file.
 */
export function ftbFileSide(file: Pick<FtbFile, 'clientonly' | 'serveronly' | 'optional'>): FileSide {
  if (file.serveronly === true) return 'required';
  if (file.clientonly === true) return 'unsupported';
  if (file.optional === true) return 'optional';
  return 'required';
}

/** Strip the FTB `./` prefix and normalize separators. */
export function normalizeFtbPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

/**
 * Resolve the destination path for one FTB file entry.
 *
 * The FTB API is inconsistent between packs, which is why this cannot be guessed from extensions:
 *  - Most packs: `path` is the full file path (`./mods/foo.jar`, with `name` equal to the last segment).
 *  - Some packs (FTB Omnia): `path` is only the *directory* (`./mods`) and the real filename is in `name`.
 *  - Some entries point at a directory but ship a filename with **no extension** (`./config/vanillafix`
 *    + `config_version`), which defeats any "has a dot ⇒ it is a file" heuristic — and treating that as a
 *    file made a later directory creation collide (EEXIST).
 *
 * The reliable invariant is that **`name` is always the file name** and `path` is either that full path
 * or its parent directory. So: use `path` when it already ends with `name`, otherwise join them.
 * Returns '' when no safe destination can be derived.
 */
export function resolveFtbDestPath(file: Pick<FtbFile, 'path' | 'name'>): string {
  const rawPath = normalizeFtbPath(file.path ?? '');
  const rawName = (file.name ?? '').replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
  if (rawPath === '') return '';
  if (rawName === '') return rawPath;
  // `path` already carries the filename.
  if (rawPath === rawName || rawPath.endsWith(`/${rawName}`)) return rawPath;
  // `name` is a bare filename and `path` is its directory.
  if (!rawName.includes('/')) return `${rawPath.replace(/\/+$/, '')}/${rawName}`;
  return rawPath;
}

/** Read the Java major out of an FTB `java` target version such as `8.0.312+7` or `17.0.8`. */
export function ftbJavaMajor(targets: FtbTarget[] | undefined): number | null {
  const java = (targets ?? []).find((target) => target.name === 'java' || target.type === 'runtime');
  if (!java) return null;
  const match = String(java.version).match(/^(\d+)/);
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isInteger(major) && major > 0 ? major : null;
}

/**
 * Choose which version of a pack to install.
 *
 * **The FTB API returns `versions[]` in ASCENDING order (oldest first), and `id` is also ascending** —
 * verified against five real packs, where id order and `updated` order agree exactly. Taking `versions[0]`
 * therefore installs the *oldest* build, which is a serious correctness bug:
 *  - FTB Omnia's oldest version (`6`, 1.0.0, beta, 2020-04-01) declares **no modloader at all**, while every
 *    later release declares `forge 31.x` — so picking it made a Forge pack look vanilla.
 *  - Two packages that "passed" were silently installed from outdated releases (Academy 1.1.0 instead of
 *    1.4.0; Stoneblock 2 1.20.0 instead of 1.23.0).
 *
 * So: sort by `updated` (falling back to `id`) rather than trusting array order, prefer the newest
 * **release**, and only fall back to the newest version of any type when no release exists.
 */
export function pickFtbVersion(pack: FtbPack, versionId?: number | null): FtbVersionRef {
  const versions = pack.versions ?? [];
  if (versions.length === 0) throw appError('validation', `FTB pack ${pack.id} has no versions.`);
  if (versionId !== undefined && versionId !== null) {
    const found = versions.find((version) => version.id === versionId);
    if (!found) throw appError('validation', `FTB pack ${pack.id} has no version ${versionId}.`);
    return found;
  }
  const recency = (version: FtbVersionRef): number => (typeof version.updated === 'number' ? version.updated : version.id);
  const newestFirst = [...versions].sort((a, b) => recency(b) - recency(a));
  const newestRelease = newestFirst.find((version) => (version.type ?? '').toLowerCase() === 'release');
  return newestRelease ?? newestFirst[0]!;
}

/** True when a version is a pre-release, so the caller can warn instead of silently shipping a beta. */
export function isFtbPrerelease(version: FtbVersionRef): boolean {
  return (version.type ?? '').toLowerCase() !== 'release';
}

/**
 * Infer a loader from the pack's own file names when the API declares no modloader target.
 *
 * Some FTB packs (e.g. FTB Omnia) ship 155 Forge mods but list only `minecraft` and `java` in `targets`.
 * Treating that as vanilla would install a vanilla server and fail at boot, so we look for the loader
 * token mod authors put in their jar names. This is inference from evidence, it is recorded in
 * `resolution`, and it is reported as a warning — never silently assumed.
 * Returns null when the evidence is absent or contradictory, and the caller fails closed.
 */
export function inferFtbLoaderFromFiles(files: FtbFile[]): { loader: LoaderFamily; evidence: string } | null {
  const names = files
    .map((file) => `${file.name ?? ''} ${file.path ?? ''}`)
    .filter((text) => /\.jar\b/i.test(text));
  if (names.length === 0) return null;
  const counts: Record<string, number> = {};
  for (const text of names) {
    // `-forge-`, `-fabric-`, `-neoforge-`, `-quilt-` as filename tokens (case-insensitive).
    for (const token of ['neoforge', 'forge', 'fabric', 'quilt']) {
      if (new RegExp(`[-_.]${token}[-_.]`, 'i').test(text) || new RegExp(`[-_.]${token}\\.jar$`, 'i').test(text)) {
        counts[token] = (counts[token] ?? 0) + 1;
      }
    }
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  const [token, hits] = ranked[0]!;
  // Require a clear winner: at least 3 jars and no competing loader within half the count.
  const rival = ranked[1];
  if (hits < 3 || (rival && rival[1] > hits / 2)) return null;
  return { loader: LOADER_TARGETS[token] ?? 'vanilla', evidence: `${hits}/${names.length} jar names contain "-${token}-"` };
}

/** Build the canonical recipe from an already-fetched FTB version document. Pure, so it is testable. */
export function buildFtbRecipe(input: {
  packName: string;
  version: FtbVersionDetail;
  /** Optional target overrides when the version doc omits targets but the pack listing had them. */
  fallbackTargets?: FtbTarget[];
}): PackRecipe {
  const targets = input.version.targets ?? input.fallbackTargets ?? [];
  const game = targets.find((target) => target.type === 'game' || target.name === 'minecraft');
  const mc = String(game?.version ?? '').trim();

  const loaderTarget = targets.find((target) => target.type === 'modloader');
  let loader: LoaderFamily = loaderTarget ? (LOADER_TARGETS[loaderTarget.name.toLowerCase()] ?? 'vanilla') : 'vanilla';
  const loaderVersion = loaderTarget?.version?.trim() || null;

  const warnings: RecipeWarning[] = [];
  const files: PlannedFile[] = [];

  // A pack that ships mods but declares no modloader is self-contradictory metadata. Infer, or fail closed.
  const hasModFiles = (input.version.files ?? []).some((file) => (file.type === 'mod') || /\.jar$/i.test(file.name ?? ''));
  let loaderProvenance = loaderTarget ? `ftb target "${loaderTarget.name}"` : 'declared (no modloader target)';
  if (!loaderTarget && hasModFiles) {
    const inferred = inferFtbLoaderFromFiles(input.version.files ?? []);
    if (!inferred) {
      throw appError('validation',
        `FTB pack "${input.packName}" ships mods but declares no modloader target, and the jar names do not `
        + 'identify a loader. Refusing to install it as vanilla.');
    }
    loader = inferred.loader;
    loaderProvenance = `inferred from jar names (${inferred.evidence}); FTB declared no modloader`;
    warnings.push({
      rule: 'ftb.modloader-missing-inferred',
      message: `FTB declares no modloader for this version; "${inferred.loader}" inferred from ${inferred.evidence}.`,
    });
  }

  for (const file of input.version.files ?? []) {
    const path = resolveFtbDestPath(file);
    if (path === '') continue;
    // FTB ships non-mod resources too (config, kubejs, scripts, animation); all belong on a server
    // unless marked client-only. `.meta` sidecar files are FTB bookkeeping, not payload.
    if (/\.meta$/i.test(path)) continue;
    const urls = [file.url, ...(file.mirrors ?? [])].filter((url): url is string => typeof url === 'string' && url !== '');
    if (urls.length === 0) {
      warnings.push({ rule: 'ftb.file-no-url', message: `FTB file has no download URL; it will be skipped.`, path });
      continue;
    }
    files.push({
      path,
      source: { urls },
      sha1: file.sha1 ?? null,
      sha512: null,
      size: typeof file.size === 'number' ? file.size : null,
      side: ftbFileSide(file),
      sideProvenance: 'ftb.clientonly/serveronly/optional',
    });
  }

  if (files.length === 0) {
    throw appError('validation', `FTB pack "${input.packName}" version has no downloadable files.`);
  }
  if (mc === '') {
    throw appError('validation',
      `FTB pack "${input.packName}" does not declare a Minecraft version target; refusing to guess a runtime.`);
  }

  const declaredJava = ftbJavaMajor(targets);
  return {
    formatId: 'ftb.app',
    name: input.packName,
    mc,
    loader,
    loaderVersion,
    javaMajor: declaredJava,
    files,
    // FTB has no override layers: every payload file is listed explicitly with its final path.
    overrides: [],
    launchShape: loader === 'fabric' || loader === 'quilt' ? 'launch-jar' : 'generated-args',
    managerOwned: [...MANAGER_OWNED_PATHS],
    warnings,
    resolution: [
      { field: 'mc', source: `ftb target "minecraft"` },
      { field: 'loader', source: loaderProvenance },
      ...(declaredJava !== null ? [{ field: 'javaMajor', source: 'ftb target "java"' }] : []),
    ],
  };
}

/**
 * Local FTB App instance on disk. `instance.json` alone is not a pack payload (the files are fetched
 * from the FTB API using `id`/`versionId`), so detection requires those two numeric ids.
 */
function detectFtbInstance(instance: FtbInstanceJson | null): boolean {
  if (!instance) return false;
  const id = Number(instance.id);
  const versionId = Number(instance.versionId);
  return Number.isInteger(id) && id > 0 && Number.isInteger(versionId) && versionId > 0
    && typeof instance.mcVersion === 'string' && instance.mcVersion.trim() !== '';
}

export const ftbAdapter: PackAdapter = {
  id: 'ftb.app',
  displayName: 'Feed The Beast (FTB App / public API)',
  inputs: ['providerApi', 'archive'],
  // Lowest priority among provider formats: its detector is generic, so it must never shadow a
  // more specific archive signature.
  priority: 20,

  detect(ctx: DetectContext): boolean | Promise<boolean> {
    if (ctx.provider?.kind === 'ftb') return true;
    if (ctx.archive) {
      // A local FTB instance is only recognizable by its instance.json carrying numeric pack ids.
      return ctx.archive.names.has('instance.json');
    }
    return false;
  },

  async resolve(ctx: DetectContext, io: AdapterIo): Promise<PackRecipe> {
    // ---- local FTB App instance ----
    if (ctx.archive && ctx.provider?.kind !== 'ftb') {
      const instance = await ctx.archive.readJson<FtbInstanceJson>('instance.json');
      if (!detectFtbInstance(instance)) {
        throw appError('validation',
          'This archive has an instance.json that is not an FTB App instance (missing numeric pack/version ids).');
      }
      const packId = Number(instance!.id);
      const versionId = Number(instance!.versionId);
      io.log(`[ftb] local instance for pack ${packId} version ${versionId}`);
      const version = await io.fetchJson<FtbVersionDetail>(
        `${FTB_API_BASE}/modpack/${packId}/${versionId}`, FTB_ALLOWED_HOSTS,
      );
      return buildFtbRecipe({ packName: instance!.name ?? `FTB pack ${packId}`, version });
    }

    // ---- remote FTB pack by id ----
    const ids = ctx.provider?.ids ?? {};
    const packId = Number(ids.packId ?? '');
    if (!Number.isInteger(packId) || packId <= 0) {
      throw appError('validation', 'FTB install needs a numeric pack id (FTB_MODPACK_ID equivalent).');
    }
    const pinnedVersion = ids.versionId === undefined ? null : Number(ids.versionId);
    if (pinnedVersion !== null && (!Number.isInteger(pinnedVersion) || pinnedVersion <= 0)) {
      throw appError('validation', `FTB version id "${String(ids.versionId)}" is not a positive integer.`);
    }

    io.log(`[ftb] resolving pack ${packId}${pinnedVersion === null ? ' (latest version)' : ` version ${pinnedVersion}`}`);
    const pack = await io.fetchJson<FtbPack>(`${FTB_API_BASE}/modpack/${packId}`, FTB_ALLOWED_HOSTS);
    const versionRef = pickFtbVersion(pack, pinnedVersion);
    io.log(`[ftb] ${pack.name}: version ${versionRef.id} "${versionRef.name}" (${versionRef.type})`);
    if (isFtbPrerelease(versionRef)) {
      io.log(`[ftb] warning: no release version available; using ${versionRef.type} "${versionRef.name}"`);
    }

    const version = await io.fetchJson<FtbVersionDetail>(
      `${FTB_API_BASE}/modpack/${packId}/${versionRef.id}`, FTB_ALLOWED_HOSTS,
    );
    return buildFtbRecipe({
      packName: pack.name ?? `FTB pack ${packId}`,
      version,
      fallbackTargets: versionRef.targets,
    });
  },
};
