// FTB (Feed The Beast) adapter Ã¢â‚¬â€ public API, no key required.
//
// Why this adapter is the generality proof: FTB is a format this app could not open at all, it needs no
// API key (unlike CurseForge), and it carries exactly the metadata a canonical recipe needs. Verified
// live against the real API (docs/research/2026-10-29-claim-verification.md Ã‚Â§13):
//   GET api.modpacks.ch/public/modpack/{id}          Ã¢â€ â€™ pack + versions + per-version targets
//   GET api.modpacks.ch/public/modpack/{id}/{verId}  Ã¢â€ â€™ files[] with clientonly/serveryonly/optional + sha1 + size
// A real file download returned matching size and SHA-1 with no authentication.
//
// Detection note: FTB App *instances* on disk are identified by `instance.json` carrying
// `uuid,id,versionId,mcVersion,modLoader`; a remote FTB pack is identified by its provider hint. Both
// route through this adapter so one recipe shape covers local and remote FTB inputs.
import { appError } from '../store';
import {
  MANAGER_OWNED_PATHS, isSafeRelativePath,
  type AdapterIo,
  type DetectInput,
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
 * Everything else is shared, and `optional` only downgrades a shared file Ã¢â‚¬â€ it never hides a server file.
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
 * **Census result (157,125 files across all 92 published FTB packs): `path` is ALWAYS the parent directory
 * and `name` is ALWAYS the file name.** Not once did `path` contain the filename. So the only correct rule is
 * to join them Ã¢â‚¬â€ every heuristic ("has a dot Ã¢â€¡â€™ it is a file", "endsWith(name)") was wrong in some pack and
 * produced one of the bugs found during P1/P1b (155 mods dropped; EEXIST from a directory treated as a file).
 *
 * `path` may be empty (seen on a `default-server.properties` resource): those files have nowhere defined to
 * go, so returning '' makes the caller skip them rather than inventing a location.
 */
export function resolveFtbDestPath(file: Pick<FtbFile, 'path' | 'name'>): string {
  const rawPath = normalizeFtbPath(file.path ?? '');
  const rawName = (file.name ?? '').replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
  if (rawName === '') return '';
  if (rawPath === '') return '';
  // Defend here as well as in validateRecipe: a `..` segment must never reach path.join.
  if (rawPath.split('/').includes('..') || rawName.split('/').includes('..')) return '';
  return `${rawPath.replace(/\/+$/, '')}/${rawName}`;
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
 * Java majors this app can actually provision and launch (mirrors `SUPPORTED_MAJORS` in `java.ts`).
 * Census note: one published FTB pack declares Java **11** (`FTB Presents Integration by Parts DX`,
 * `11.0.19+7`). Treating that as a hard requirement would reject a pack that runs fine on 17, and the app
 * cannot install 11 anyway Ã¢â‚¬â€ so it is rounded up to the next supported major and reported, never dropped.
 */
export const APP_JAVA_MAJORS: readonly number[] = [8, 17, 21, 25];

export function coerceJavaMajor(declared: number | null): { major: number | null; adjusted: boolean } {
  if (declared === null) return { major: null, adjusted: false };
  if (APP_JAVA_MAJORS.includes(declared)) return { major: declared, adjusted: false };
  const next = APP_JAVA_MAJORS.find((major) => major >= declared) ?? APP_JAVA_MAJORS[APP_JAVA_MAJORS.length - 1]!;
  return { major: next, adjusted: true };
}

/**
 * Validate a Minecraft version string from a pack.
 *
 * `validateRecipe` requires `\d+\.\d+(\.\d+)?`, but the FTB corpus contains snapshot and pre-release names
 * (`18w43b`, `26.3-pre-1`, `26.4-snapshot-6`) and even alpha names (`rd-132211`). Those are real MC versions,
 * not malformed data, so the recipe validator must accept them or a legitimate pack is refused.
 */
export function isMinecraftVersionString(value: string): boolean {
  const text = (value ?? '').trim();
  if (text === '') return false;
  if (/^\d+\.\d+(?:\.\d+)?$/.test(text)) return true;           // 1.20.1, 26.3
  if (/^\d{2}w\d{2}[a-z]$/i.test(text)) return true;            // 18w43b (weekly snapshot)
  if (/^\d+\.\d+(?:\.\d+)?-(?:pre|rc|snapshot)[-\w.]*$/i.test(text)) return true; // 26.3-pre-1, 26.4-snapshot-6
  if (/^[a-z]\d+\.\d+(?:\.\d+)?[a-z]$/i.test(text)) return true; // c0.0.11a, rd-132211 handled below
  if (/^[a-z]{2}-\d+$/.test(text)) return true;                  // rd-132211 (alpha)
  return false;
}

/**
 * Choose which version of a pack to install.
 *
 * **The FTB API returns `versions[]` in ASCENDING order (oldest first), and `id` is also ascending** Ã¢â‚¬â€
 * verified against five real packs, where id order and `updated` order agree exactly. Taking `versions[0]`
 * therefore installs the *oldest* build, which is a serious correctness bug:
 *  - FTB Omnia's oldest version (`6`, 1.0.0, beta, 2020-04-01) declares **no modloader at all**, while every
 *    later release declares `forge 31.x` Ã¢â‚¬â€ so picking it made a Forge pack look vanilla.
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
 * `resolution`, and it is reported as a warning Ã¢â‚¬â€ never silently assumed.
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

  // Validate the Minecraft version first: without it nothing can be installed, whatever the loader is, so it is
  // both the more fundamental failure and the more actionable one to report.
  if (mc === '') {
    throw appError('validation',
      `FTB pack "${input.packName}" does not declare a Minecraft version target; refusing to guess a runtime.`);
  }

  // A pack that ships mods but declares no modloader is self-contradictory metadata. Infer, or fail closed.
  // `type` is optional in the API (a jar can arrive with no type), so a `.jar` under a `mods` directory also
  // counts Ã¢â‚¬â€ otherwise a resource-only archive could be misread as a modded pack and rejected.
  const hasModFiles = (input.version.files ?? []).some((file) => {
    if (file.type === 'mod') return true;
    const path = resolveFtbDestPath(file).toLowerCase();
    return path.startsWith('mods/') && path.endsWith('.jar');
  });
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

  // Census-driven: destinations can collide. 22 duplicate destinations were observed across the corpus
  // (e.g. `mods/pedestals-0.4.56.jar` listed twice in one version). Fetching the same path twice is at best
  // wasted work and at worst two different builds overwriting each other, so the first entry wins and the
  // duplicate is recorded rather than silently installed twice.
  const byPath = new Map<string, PlannedFile>();
  let duplicatePaths = 0;
  for (const file of input.version.files ?? []) {
    const path = resolveFtbDestPath(file);
    if (path === '') continue;
    // FTB ships non-mod resources too (config, kubejs, scripts, animation); all belong on a server
    // unless marked client-only. `.meta` sidecar files are FTB bookkeeping, not payload.
    if (/\.meta$/i.test(path)) continue;
    if (!isSafeRelativePath(path)) {
      warnings.push({ rule: 'ftb.unsafe-path', message: 'FTB file path escapes the server directory; skipped.', path });
      continue;
    }
    if (byPath.has(path)) { duplicatePaths += 1; continue; }
    const urls = [file.url, ...(file.mirrors ?? [])].filter((url): url is string => typeof url === 'string' && url !== '');
    if (urls.length === 0) {
      warnings.push({ rule: 'ftb.file-no-url', message: `FTB file has no download URL; it will be skipped.`, path });
      continue;
    }
    byPath.set(path, {
      path,
      source: { urls },
      sha1: file.sha1 ?? null,
      sha512: null,
      size: typeof file.size === 'number' ? file.size : null,
      side: ftbFileSide(file),
      sideProvenance: 'ftb.clientonly/serveronly/optional',
    });
  }
  const files = [...byPath.values()];
  if (duplicatePaths > 0) {
    warnings.push({
      rule: 'ftb.duplicate-destination',
      message: `${duplicatePaths} file entr${duplicatePaths === 1 ? 'y' : 'ies'} targeted an already-planned path; the first entry was kept.`,
    });
  }

  if (files.length === 0) {
    throw appError('validation', `FTB pack "${input.packName}" version has no downloadable files.`);
  }
  const declaredJava = ftbJavaMajor(targets);
  const java = coerceJavaMajor(declaredJava);
  if (java.adjusted && declaredJava !== null) {
    warnings.push({
      rule: 'ftb.java-major-unsupported',
      message: `FTB declares Java ${declaredJava}, which this app cannot provision; using Java ${java.major}.`,
    });
  }
  return {
    formatId: 'ftb.app',
    name: input.packName,
    mc,
    loader,
    loaderVersion,
    javaMajor: java.major,
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
  shapes: ['archive', 'provider'],
  // Lowest priority among provider formats: its detector is generic, so it must never shadow a
  // more specific archive signature.
  priority: 20,

  async detect(input: DetectInput): Promise<boolean> {
    if (input.shape === 'provider') return input.kind === 'ftb';
    if (input.shape !== 'archive') return false;
    // Validate keys, not the filename: three formats write `instance.json` (ATLauncher, FTB App, and the
    // vanilla Minecraft launcher). Only FTB's carries numeric pack + version ids and an mcVersion string.
    const instance = await input.index.readJson<FtbInstanceJson>('instance.json');
    return detectFtbInstance(instance);
  },

  async resolve(input: DetectInput, io: AdapterIo): Promise<PackRecipe> {
    // ---- local FTB App instance ----
    if (input.shape === 'archive') {
      const instance = await input.index.readJson<FtbInstanceJson>('instance.json');
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

    if (input.shape !== 'provider') {
      throw appError('validation', `FTB adapter cannot handle a "${input.shape}" input.`);
    }
    // ---- remote FTB pack by id ----
    const ids = input.ids;
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


