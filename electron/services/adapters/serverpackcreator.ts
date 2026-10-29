// ServerPackCreator output adapter — research §2 row 12.
//
// Why this is its own adapter and not part of the CurseForge one (DV-12): rows 11 and 12 of the research format
// table are different formats. A row-11 author server pack has no manifest at all; a row-12 SPC output carries a
// `manifest.json` that is NOT a CurseForge manifest. Absorbing row 12 under a CurseForge id would repeat the D4
// mistake of duplicated-and-degraded logic, so the two CurseForge adapters explicitly *decline* row-12 archives
// and this adapter claims them.
//
// Schema, read from a REAL archive rather than assumed. The 1 GB wrapper
// `.app-data/cache/cfpack/466901-server-9296268.zip` unwraps to 3,553 entries whose root `manifest.json` is:
//   { "files": [...3642 entries...],
//     "minecraftVersion": "1.20.1",
//     "modloader": "Fabric",
//     "modloaderVersion": "0.19.3",
//     "serverPackCreatorVersion": "..." }
// That is exactly the shape research §2 row 12 predicts. Cross-check: the same inner archive also ships a
// `variables.txt` with MINECRAFT_VERSION=1.20.1 / MODLOADER=Fabric / MODLOADER_VERSION=0.19.3, and the Modrinth
// adapter independently reported Fabric 0.19.3 / MC 1.20.1 for the client pack — three sources agree.
//
// The payload is already a server tree (SPC builds server packs), so the recipe carries no download list: the
// archive itself is the payload, applied as one root override layer.
import { appError } from '../store';
import { isServerPackCreatorManifest } from './curseforge';
import {
  MANAGER_OWNED_PATHS,
  type AdapterIo,
  type DetectInput,
  type LoaderFamily,
  type PackAdapter,
  type PackRecipe,
  type OverrideLayer,
  type RecipeWarning,
} from './types';

/** `modloader` values ServerPackCreator writes, mapped onto canonical families. */
const SPC_LOADERS: Record<string, LoaderFamily> = {
  forge: 'forge',
  neoforge: 'neoforge',
  fabric: 'fabric',
  quilt: 'quilt',
  legacyfabric: 'fabric',
  vanilla: 'vanilla',
  paper: 'paper',
};

/**
 * Read the runtime out of an SPC manifest. Pure, so it is unit-testable without an archive.
 * `minecraftVersion` and `modloader` are the only required fields (the guard in curseforge.ts enforces that);
 * `modloaderVersion` is optional because SPC omits it for vanilla output.
 */
export function readSpcManifest(raw: unknown): {
  mc: string;
  loader: LoaderFamily;
  loaderVersion: string | null;
  fileCount: number;
  creatorVersion: string | null;
} | null {
  if (!isServerPackCreatorManifest(raw)) return null;
  const manifest = raw as {
    files?: unknown[];
    minecraftVersion: string;
    modloader: string;
    modloaderVersion?: unknown;
    serverPackCreatorVersion?: unknown;
  };
  const mc = manifest.minecraftVersion.trim();
  if (mc === '') return null;
  const rawLoader = manifest.modloader.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const loader = SPC_LOADERS[rawLoader] ?? 'vanilla';
  const loaderVersion = typeof manifest.modloaderVersion === 'string' && manifest.modloaderVersion.trim() !== ''
    ? manifest.modloaderVersion.trim()
    : null;
  return {
    mc,
    loader,
    loaderVersion,
    fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0,
    creatorVersion: typeof manifest.serverPackCreatorVersion === 'string' ? manifest.serverPackCreatorVersion : null,
  };
}

export const serverPackCreatorAdapter: PackAdapter = {
  id: 'serverpackcreator',
  displayName: 'ServerPackCreator output (manifest.json)',
  // Above the CurseForge adapters (88/87): a row-12 manifest must win over row-11 heuristic detection, because
  // it is exact declared metadata while row 11 has to infer. Below modrinth (90), which has per-file sides.
  priority: 89,
  shapes: ['archive'],

  async detect(input: DetectInput): Promise<boolean> {
    if (input.shape !== 'archive') return false;
    const manifest = await input.index.readJson<unknown>('manifest.json');
    return readSpcManifest(manifest) !== null;
  },

  async resolve(input: DetectInput, io: AdapterIo): Promise<PackRecipe> {
    if (input.shape !== 'archive') {
      throw appError('validation', `ServerPackCreator adapter cannot handle a "${input.shape}" input.`);
    }
    const manifest = await input.index.readJson<unknown>('manifest.json');
    const runtime = readSpcManifest(manifest);
    if (!runtime) {
      throw appError('validation',
        'manifest.json is not ServerPackCreator output (needs files[] plus minecraftVersion and modloader strings).');
    }

    const warnings: RecipeWarning[] = [
      {
        rule: 'spc.manifest-derived',
        message: `runtime taken from the ServerPackCreator manifest: ${runtime.loader} `
          + `${runtime.loaderVersion ?? '(no build declared)'} / MC ${runtime.mc}`
          + `${runtime.creatorVersion ? ` (SPC ${runtime.creatorVersion})` : ''}. `
          + `The manifest lists ${runtime.fileCount} file entries; the archive itself is the payload.`,
      },
    ];
    if (runtime.loader === 'quilt') {
      // Real packs do ship Quilt, but ADR-0005 rejects it for new installs; say so explicitly instead of
      // letting a later policy check fail with a generic message (DV-06 class).
      warnings.push({
        rule: 'spc.quilt-policy',
        message: 'this pack declares Quilt, which is not supported for new server installs (ADR-0005).',
      });
    }

    // The archive is already a server tree: one root layer, no download list.
    const overrides: OverrideLayer[] = [{ prefix: '', order: 1 }];
    io.log(`[spc] "${runtime.mc}" ${runtime.loader} ${runtime.loaderVersion ?? '(unpinned)'} from manifest.json (${runtime.fileCount} entries)`);

    return {
      formatId: 'serverpackcreator',
      name: 'ServerPackCreator pack',
      mc: runtime.mc,
      loader: runtime.loader,
      loaderVersion: runtime.loaderVersion,
      javaMajor: null,
      files: [],
      overrides,
      launchShape: runtime.loader === 'fabric' || runtime.loader === 'quilt' ? 'launch-jar' : 'generated-args',
      managerOwned: [...MANAGER_OWNED_PATHS],
      warnings,
      resolution: [
        { field: 'mc', source: 'manifest.json minecraftVersion' },
        { field: 'loader', source: `manifest.json modloader="${runtime.loader}"` },
        ...(runtime.loaderVersion ? [{ field: 'loaderVersion', source: 'manifest.json modloaderVersion' }] : []),
        { field: 'payload', source: 'archive tree applied as one root override layer (SPC builds server packs)' },
      ],
    };
  },
};
