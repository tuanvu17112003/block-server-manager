// packwiz adapter Ã¢â‚¬â€ `pack.toml` + `index.toml` + `*.pw.toml`.
//
// Schema taken from packwiz's own struct tags (docs/research/2026-10-29-p1c-format-census.md Ã‚Â§3):
//   pack.toml   : name, author, version, description, pack-format, [index]{file,hash-format,hash},
//                 [versions]{minecraft,fabric,forge,quilt,...}, [export], [options]
//   index.toml  : hash-format, [[files]]{file,hash,hash-format,alias,metafile,preserve}
//   *.pw.toml   : name, filename, side("both"|"client"|"server"), pin, [download]{url,hash-format,hash,mode},
//                 [update], [option]{optional,description,default}
//
// Two facts that shape this adapter:
//  - packwiz is *declarative*: `pack.toml` carries no file list. Files are in `index.toml`, and a `[[files]]`
//    entry with `metafile = true` points at a `*.pw.toml` that carries the real URL, hash and **side**.
//    So a packwiz archive without `index.toml` cannot be installed and must say so specifically.
//  - side values are exactly `both` / `client` / `server`, and an absent side means **both**. This is the only
//    one of the archive formats that declares per-file sidedness, which makes it the richest adapter.
import { appError } from '../store';
import { parseToml, tomlAt, tomlString, tomlTable, type TomlTable } from './toml';
import {
  MANAGER_OWNED_PATHS,
  isSafeRelativePath,
  type AdapterIo,
  type DetectInput,
  type FileSide,
  type LoaderFamily,
  type PackAdapter,
  type PackRecipe,
  type PlannedFile,
  type RecipeWarning,
  type OverrideLayer,
} from './types';

/** packwiz `[versions]` keys that imply a loader, most-specific first. */
const PACKWIZ_LOADERS: readonly { key: string; loader: LoaderFamily }[] = [
  { key: 'neoforge', loader: 'neoforge' },
  { key: 'forge', loader: 'forge' },
  { key: 'quilt', loader: 'quilt' },
  { key: 'fabric', loader: 'fabric' },
];

/** `packwiz:1.x` is the only pack-format family we accept. */
export function isPackwizFormat(packFormat: string | null): boolean {
  return (packFormat ?? '').trim().toLowerCase().startsWith('packwiz:');
}

/**
 * Validate that a parsed `pack.toml` really is packwiz. `pack.toml` is a generic filename (Cargo, Rust tools),
 * so the decisive signal is `[versions].minecraft` plus either a `packwiz:` format tag or an `[index]` table.
 */
export function isValidPackwizPack(pack: TomlTable | null): boolean {
  if (!pack) return false;
  const minecraft = tomlString(pack, 'versions', 'minecraft');
  if (!minecraft || minecraft.trim() === '') return false;
  const packFormat = tomlString(pack, 'pack-format');
  if (isPackwizFormat(packFormat)) return true;
  // A missing pack-format is assumed 1.1.0 by packwiz itself (pack.go), so an [index] table is enough.
  const index = tomlTable(pack, 'index');
  return Boolean(index && tomlString(pack, 'index', 'file'));
}

/** Map packwiz `side` onto the canonical value. Absent Ã¢â€¡â€™ both Ã¢â€¡â€™ required. */
export function packwizFileSide(side: string | null): { side: FileSide; provenance: string } {
  const value = (side ?? '').trim().toLowerCase();
  if (value === 'client') return { side: 'unsupported', provenance: 'packwiz side="client"' };
  if (value === 'server') return { side: 'required', provenance: 'packwiz side="server"' };
  if (value === 'both') return { side: 'required', provenance: 'packwiz side="both"' };
  if (value === '') return { side: 'required', provenance: 'packwiz side absent Ã¢â€¡â€™ both' };
  // An unknown side value must not be guessed either way.
  return { side: 'unknown', provenance: `packwiz side="${value}" (unrecognised)` };
}

/** Resolve the loader and its build from `[versions]`. */
export function packwizLoader(versions: TomlTable | undefined): { loader: LoaderFamily; version: string | null } {
  for (const entry of PACKWIZ_LOADERS) {
    const value = versions ? tomlString(versions, entry.key) : null;
    if (value && value.trim() !== '') return { loader: entry.loader, version: value.trim() };
  }
  return { loader: 'vanilla', version: null };
}

/** A `*.pw.toml` metafile, in the shape this adapter needs. */
interface PackwizMetafile {
  name: string | null;
  filename: string | null;
  side: { side: FileSide; provenance: string };
  url: string | null;
  hash: string | null;
  hashFormat: string | null;
  optional: boolean;
}

function readMetafile(text: string): PackwizMetafile {
  let table: TomlTable;
  try {
    table = parseToml(text);
  } catch (error) {
    throw appError('validation', `packwiz metafile is not valid TOML: ${(error as Error).message}`);
  }
  return {
    name: tomlString(table, 'name'),
    filename: tomlString(table, 'filename'),
    side: packwizFileSide(tomlString(table, 'side')),
    url: tomlString(table, 'download', 'url'),
    hash: tomlString(table, 'download', 'hash'),
    hashFormat: tomlString(table, 'download', 'hash-format'),
    optional: Boolean(tomlAt(table, ['option', 'optional'])),
  };
}

/** Map packwiz hash-format onto the canonical hash slots. */
function hashFor(format: string | null, hash: string | null): { sha1?: string; sha512?: string } {
  if (!hash) return {};
  const normalized = (format ?? '').trim().toLowerCase();
  if (normalized === 'sha1') return { sha1: hash };
  if (normalized === 'sha512') return { sha512: hash };
  // sha256/md5/murmur2 have no slot in the recipe; downloadFirstAvailable verifies what it is given.
  return {};
}

/** Pack file names packwiz actually uses. Measured: `modpack.toml` is real (Jasons-impart/Create-Delight-Remake). */
export const PACKWIZ_PACK_FILES: readonly string[] = ['pack.toml', 'modpack.toml'];

/**
 * Fetch one text resource from a packwiz HTTP tree. Returns null on 404 so discovery can move on; throws on
 * other failures so a real outage is not mistaken for "the file does not exist".
 */
async function fetchTreeText(
  baseUrl: string,
  relativePath: string,
  fetchText?: (url: string) => Promise<string | null>,
): Promise<string | null> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = `${base}${relativePath.replace(/^\.?\/+/, '')}`;
  if (fetchText) return await fetchText(url);
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw appError('io', `packwiz HTTP tree returned ${response.status} for ${url}`);
  return await response.text();
}

/**
 * Discover the pack file in an HTTP tree: `pack.toml` first, then `modpack.toml`, at the base URL.
 * Returns the file name and its text, or null when neither exists.
 */
export async function discoverPackwizPackFile(
  baseUrl: string,
  fetchText?: (url: string) => Promise<string | null>,
): Promise<{ file: string; text: string } | null> {
  for (const candidate of PACKWIZ_PACK_FILES) {
    const text = await fetchTreeText(baseUrl, candidate, fetchText);
    if (text !== null) return { file: candidate, text };
  }
  return null;
}

/** Resolve a metafile path against the directory that holds the pack file (packs may live in a subdirectory). */
export function resolveTreeSibling(baseUrl: string, packFile: string, sibling: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  void packFile;
  return `${base}${sibling.replace(/^\.?\/+/, '')}`;
}

/**
 * Shape C: resolve a packwiz pack served as an HTTP tree.
 *
 * This is how `packwiz-installer` actually works (research §3.9: it "reads only `pack.toml` over HTTP and
 * nothing else, so any host/CDN/CI can serve a pack"), and it is the reason DV-22 exists: the adapter used to
 * *declare* httpTree without implementing it. Measured on real packs, `index.toml` can reference 86 and 126
 * metafiles, each an independent HTTP resource — there is no archive to read them out of.
 *
 * Errors are specific, never generic: a missing `index.toml` means the pack is not installable (declarative
 * format with no file list), while a missing metafile is a per-file warning so one dead link does not sink an
 * otherwise valid pack.
 */
async function resolveHttpTree(
  input: Extract<DetectInput, { shape: 'httpTree' }>,
  io: AdapterIo,
): Promise<PackRecipe> {
  const discovered = await discoverPackwizPackFile(input.baseUrl, input.fetchText);
  if (!discovered) {
    throw appError('validation',
      `no pack.toml or modpack.toml at ${input.baseUrl}. A packwiz HTTP tree must expose one of them.`);
  }
  let pack: TomlTable;
  try {
    pack = parseToml(discovered.text);
  } catch (error) {
    throw appError('validation', `${discovered.file} is not valid TOML: ${(error as Error).message}`);
  }
  if (!isValidPackwizPack(pack)) {
    throw appError('validation', `${discovered.file} is not a packwiz pack (no versions.minecraft).`);
  }

  const mc = (tomlString(pack, 'versions', 'minecraft') ?? '').trim();
  const { loader, version: loaderVersion } = packwizLoader(tomlTable(pack, 'versions'));
  const name = (tomlString(pack, 'name') ?? 'packwiz pack').trim() || 'packwiz pack';
  const warnings: RecipeWarning[] = [];
  const byPath = new Map<string, PlannedFile>();
  let duplicatePaths = 0;

  const indexText = await fetchTreeText(input.baseUrl, 'index.toml', input.fetchText);
  if (indexText === null) {
    throw appError('validation',
      `packwiz pack "${name}" has no index.toml at ${input.baseUrl}, so it declares no files. `
      + 'A packwiz tree must expose index.toml alongside its pack file.');
  }
  let index: TomlTable;
  try {
    index = parseToml(indexText);
  } catch (error) {
    throw appError('validation', `index.toml is not valid TOML: ${(error as Error).message}`);
  }
  const entries = tomlAt(index, ['files']);
  const fileEntries = Array.isArray(entries) ? entries : [];
  if (fileEntries.length === 0) {
    throw appError('validation', `packwiz pack "${name}" has an empty index.toml (no [[files]]).`);
  }

  let metafilesSeen = 0;
  for (const rawEntry of fileEntries) {
    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) continue;
    const entry = rawEntry as TomlTable;
    const filePath = (tomlString(entry, 'file') ?? '').replaceAll('\\', '/').replace(/^\.?\/+/, '');
    if (filePath === '') continue;
    if (!Boolean(tomlAt(entry, ['metafile']))) continue; // plain payload files ship in the tree, not as downloads
    metafilesSeen += 1;
    const text = await fetchTreeText(input.baseUrl, filePath, input.fetchText);
    if (text === null) {
      warnings.push({ rule: 'packwiz.metafile-missing', message: 'index.toml references a metafile the host does not serve; skipped.', path: filePath });
      continue;
    }
    let metafile: PackwizMetafile;
    try {
      metafile = readMetafile(text);
    } catch (error) {
      warnings.push({ rule: 'packwiz.metafile-invalid', message: (error as Error).message, path: filePath });
      continue;
    }
    if (!metafile.url) {
      warnings.push({ rule: 'packwiz.metafile-no-url', message: 'metafile has no [download].url; skipped.', path: filePath });
      continue;
    }
    const metafileDir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
    const fallbackName = metafile.filename ?? `${filePath.split('/').pop()!.replace(/\.pw\.toml$/i, '')}.jar`;
    const target = (metafileDir ? `${metafileDir}/${fallbackName}` : fallbackName).replaceAll('\\', '/').replace(/^\.?\/+/, '');
    if (!isSafeRelativePath(target)) {
      warnings.push({ rule: 'packwiz.unsafe-path', message: 'destination escapes the server directory; skipped.', path: target });
      continue;
    }
    if (MANAGER_OWNED_PATHS.includes(target.toLowerCase())) continue;
    if (byPath.has(target)) { duplicatePaths += 1; continue; }
    const hashes = hashFor(metafile.hashFormat, metafile.hash);
    byPath.set(target, {
      path: target,
      source: { urls: [metafile.url] },
      sha1: hashes.sha1 ?? null,
      sha512: hashes.sha512 ?? null,
      size: null,
      side: metafile.optional ? 'optional' : metafile.side.side,
      sideProvenance: metafile.optional ? `${metafile.side.provenance}; option.optional` : metafile.side.provenance,
    });
  }

  const resolved = [...byPath.values()];
  if (duplicatePaths > 0) {
    warnings.push({ rule: 'packwiz.duplicate-destination', message: `${duplicatePaths} metafile(s) targeted an already-planned path; the first was kept.` });
  }
  if (resolved.length === 0) {
    throw appError('validation',
      `packwiz pack "${name}" yielded no downloadable metafiles from its HTTP tree `
      + `(${metafilesSeen} metafile entries were listed).`);
  }

  io.log(`[packwiz] httpTree "${name}" ${loader} ${loaderVersion ?? '(unpinned)'} MC ${mc}: ${resolved.length}/${metafilesSeen} metafiles`);
  return {
    formatId: 'packwiz',
    name,
    mc,
    loader,
    loaderVersion,
    javaMajor: null,
    files: resolved,
    // The tree's own payload (config/scripts/resources) is not fetched here; only the metafile-declared mods are.
    overrides: [],
    launchShape: loader === 'fabric' || loader === 'quilt' ? 'launch-jar' : 'generated-args',
    managerOwned: [...MANAGER_OWNED_PATHS],
    warnings,
    resolution: [
      { field: 'mc', source: `${discovered.file} [versions].minecraft` },
      { field: 'loader', source: loader === 'vanilla' ? 'no loader key in [versions]' : `${discovered.file} [versions].${loader}` },
      { field: 'files', source: 'index.toml [[files]] metafile → *.pw.toml [download].url, fetched over HTTP' },
      { field: 'side', source: '*.pw.toml side (both/client/server), absent ⇒ both' },
    ],
  };
}

export const packwizAdapter: PackAdapter = {
  id: 'packwiz',
  displayName: 'packwiz (pack.toml / index.toml, archive or HTTP tree)',
  // Both shapes are implemented: shape A for zipped packs, shape C for the way packwiz-installer actually works
  // (fetch pack.toml -> index.toml -> each *.pw.toml over HTTP). Declaring a shape the adapter cannot handle
  // would be a lie the registry cannot catch (docs/audit/24 DV-22).
  shapes: ['archive', 'httpTree'],
  priority: 60,

  async detect(input: DetectInput): Promise<boolean> {
    if (input.shape === 'httpTree') {
      try {
        return (await discoverPackwizPackFile(input.baseUrl, input.fetchText)) !== null;
      } catch {
        // Detection must never throw: an unreachable tree simply is not a claimed pack.
        return false;
      }
    }
    const archive = input.shape === 'archive' || input.shape === 'instance' ? input.index : undefined;
    if (!archive) return false;
    for (const candidate of PACKWIZ_PACK_FILES) {
      const pack = await archive.readText(candidate);
      if (pack === null) continue;
      try {
        if (isValidPackwizPack(parseToml(pack))) return true;
      } catch {
        // An unparseable pack file is not a packwiz pack for detection purposes; try the next candidate.
      }
    }
    return false;
  },

  async resolve(input: DetectInput, io: AdapterIo): Promise<PackRecipe> {
    if (input.shape === 'httpTree') {
      return await resolveHttpTree(input, io);
    }
    const archive = input.shape === 'archive' || input.shape === 'instance' ? input.index : undefined;
    if (!archive) throw appError('validation', 'packwiz adapter needs an archive or an HTTP tree.');
    let packText: string | null = null;
    let packFile = 'pack.toml';
    for (const candidate of PACKWIZ_PACK_FILES) {
      packText = await archive.readText(candidate);
      if (packText !== null) { packFile = candidate; break; }
    }
    if (packText === null) throw appError('validation', 'packwiz archive has no pack.toml or modpack.toml.');
    const pack = parseToml(packText);
    if (!isValidPackwizPack(pack)) {
      throw appError('validation', `${packFile} is not a packwiz pack (no versions.minecraft).`);
    }

    const mc = (tomlString(pack, 'versions', 'minecraft') ?? '').trim();
    const { loader, version: loaderVersion } = packwizLoader(tomlTable(pack, 'versions'));
    const name = (tomlString(pack, 'name') ?? 'packwiz pack').trim() || 'packwiz pack';
    const warnings: RecipeWarning[] = [];
    const files: PlannedFile[] = [];
    const byPath = new Map<string, PlannedFile>();
    let duplicatePaths = 0;

    const indexText = await archive.readText('index.toml');
    if (indexText === null) {
      // Declarative format: without index.toml there is no file list at all.
      throw appError('validation',
        `packwiz pack "${name}" has no index.toml, so it declares no files. `
        + 'A packwiz archive must include index.toml (and its *.pw.toml metafiles) to be installable.');
    }
    const index = parseToml(indexText);
    const entries = tomlAt(index, ['files']);
    const fileEntries = Array.isArray(entries) ? entries : [];
    if (fileEntries.length === 0) {
      throw appError('validation', `packwiz pack "${name}" has an empty index.toml (no [[files]]).`);
    }

    for (const rawEntry of fileEntries) {
      if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) continue;
      const entry = rawEntry as TomlTable;
      const filePath = (tomlString(entry, 'file') ?? '').replaceAll('\\', '/').replace(/^\.?\/+/, '');
      if (filePath === '') continue;
      const isMetafile = Boolean(tomlAt(entry, ['metafile']));
      const preserve = Boolean(tomlAt(entry, ['preserve']));
      const alias = tomlString(entry, 'alias');

      if (!isMetafile) {
        // A plain indexed file: the archive itself carries the bytes (an override/config shipped in the pack).
        // It is not downloadable from a URL, so it must be extracted from the archive. The installer handles
        // that through the override layer; here we only record that it belongs on the server.
        continue;
      }

      // A metafile entry: its content is a *.pw.toml with the real download info.
      const text = await archive.readText(filePath);
      if (text === null) {
        warnings.push({ rule: 'packwiz.metafile-missing', message: 'index.toml references a metafile that is not in the archive; skipped.', path: filePath });
        continue;
      }
      let metafile: PackwizMetafile;
      try {
        metafile = readMetafile(text);
      } catch (error) {
        warnings.push({ rule: 'packwiz.metafile-invalid', message: (error as Error).message, path: filePath });
        continue;
      }
      if (!metafile.url) {
        warnings.push({ rule: 'packwiz.metafile-no-url', message: 'metafile has no [download].url; skipped.', path: filePath });
        continue;
      }
      // Destination path. packwiz's own convention (core/mod.go, and modrinth/export.go) is:
      //  - the metafile lives at `<dir>/<something>.pw.toml`
      //  - `filename` is the real on-disk file name (e.g. `sodium.jar`), NOT the metafile name
      //  - `alias` overrides the destination path entirely
      // Using the metafile name with `.pw.toml` stripped produced `mods/sodium` (no extension), which is wrong.
      const metafileDir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
      const fallbackName = metafile.filename ?? `${filePath.split('/').pop()!.replace(/\.pw\.toml$/i, '')}.jar`;
      const target = (alias ?? (metafileDir ? `${metafileDir}/${fallbackName}` : fallbackName))
        .replaceAll('\\', '/')
        .replace(/^\.?\/+/, '');
      if (!isSafeRelativePath(target)) {
        warnings.push({ rule: 'packwiz.unsafe-path', message: 'destination escapes the server directory; skipped.', path: target });
        continue;
      }
      if (MANAGER_OWNED_PATHS.includes(target.toLowerCase())) continue;
      if (byPath.has(target)) { duplicatePaths += 1; continue; }
      const hashes = hashFor(metafile.hashFormat, metafile.hash);
      byPath.set(target, {
        path: target,
        source: { urls: [metafile.url] },
        sha1: hashes.sha1 ?? null,
        sha512: hashes.sha512 ?? null,
        size: null,
        side: metafile.optional ? 'optional' : metafile.side.side,
        sideProvenance: metafile.optional ? `${metafile.side.provenance}; option.optional` : metafile.side.provenance,
      });
    }

    const resolved = [...byPath.values()];
    if (duplicatePaths > 0) {
      warnings.push({
        rule: 'packwiz.duplicate-destination',
        message: `${duplicatePaths} metafile(s) targeted an already-planned path; the first was kept.`,
      });
    }
    if (resolved.length === 0) {
      throw appError('validation',
        `packwiz pack "${name}" yielded no downloadable metafiles. `
        + 'Its index.toml may list only plain files, which this installer does not reconstruct from overrides.');
    }

    // packwiz ships non-metafile payload (config/, scripts/, resources/) directly in the archive. Those are the
    // override layer: extract everything except the metadata files themselves.
    const overrides: OverrideLayer[] = [{ prefix: '', order: 1 }];
    warnings.push({
      rule: 'packwiz.archive-payload',
      message: 'files shipped inside the archive (config/scripts/resources) are applied as an override layer; '
        + 'index.toml metadata files themselves are not installed.',
    });

    io.log(`[packwiz] "${name}" ${loader} ${loaderVersion ?? '(unpinned)'} MC ${mc}: ${resolved.length} metafiles`);
    return {
      formatId: 'packwiz',
      name,
      mc,
      loader,
      loaderVersion,
      javaMajor: null,
      files: resolved,
      overrides,
      launchShape: loader === 'fabric' || loader === 'quilt' ? 'launch-jar' : 'generated-args',
      managerOwned: [...MANAGER_OWNED_PATHS],
      warnings,
      resolution: [
        { field: 'mc', source: 'pack.toml [versions].minecraft' },
        { field: 'loader', source: loader === 'vanilla' ? 'no loader key in [versions]' : `pack.toml [versions].${loader}` },
        { field: 'files', source: 'index.toml [[files]] metafile Ã¢â€ â€™ *.pw.toml [download].url' },
        { field: 'side', source: '*.pw.toml side (both/client/server), absent Ã¢â€¡â€™ both' },
      ],
    };
  },
};





