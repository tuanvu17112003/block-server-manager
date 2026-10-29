// Plain server zip adapter â€” the last-resort format: a zip with no pack manifest at all.
//
// Real shapes (from the CurseForge work, docs/audit/11,12): a zip containing `mods/`, `config/`, optionally
// `libraries/`, `run.sh` / `run.bat` / `startserver.sh`, `user_jvm_args.txt`, or a `forge-*-installer.jar`.
// No machine-readable pack metadata exists.
//
// This adapter is deliberately the lowest priority and never guesses. Its contract:
//  - if explicit MC-version evidence exists in the archive, use it;
//  - if it does not, **fail closed** with a specific reason, because a bare `mods/` dump cannot be installed
//    safely and inventing a version is exactly the class of bug the census discipline exists to prevent.
//
// MC-version evidence, in order (each is a real artifact, not a heuristic):
//   1. `version.json` at the root (Mojang server metadata: {"id":"1.20.1",...})
//   2. a bundled server jar's `META-INF/MANIFEST.MF` (not read here: requires unzipping a nested jar)
//   3. the Forge maven layout `libraries/net/minecraftforge/forge/<mc>-<build>/...`
//   4. a loader installer jar name `forge-<mc>-<build>-installer.jar` / `neoforge-...`
import { appError } from '../store';
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

/** Evidence for the Minecraft version inside a bare server archive. */
export interface ServerZipEvidence {
  mc: string | null;
  loader: LoaderFamily;
  loaderVersion: string | null;
  source: string | null;
  hasMods: boolean;
  hasLibraries: boolean;
  hasServerJar: boolean;
  installerJar: string | null;
}

const MC_VERSION = String.raw`(\d+\.\d+(?:\.\d+)?)`;

/**
 * Read the runtime out of a bare server archive's entry list. Pure: takes names, returns evidence.
 * `version.jsonText` is the parsed content of a root `version.json` when present.
 */
export function readServerZipEvidence(names: readonly string[], versionJson: { id?: unknown } | null): ServerZipEvidence {
  const lower = names.map(name => name.replaceAll('\\', '/').toLowerCase());
  const hasMods = lower.some(name => name.startsWith('mods/'));
  const hasLibraries = lower.some(name => name.startsWith('libraries/'));
  const hasServerJar = lower.some(name => /^(server\.jar|minecraft_server[^/]*\.jar)$/.test(name));

  // 1) Mojang server metadata shipped in the archive.
  if (versionJson && typeof versionJson.id === 'string' && versionJson.id.trim() !== '') {
    return { mc: versionJson.id.trim(), loader: 'vanilla', loaderVersion: null, source: 'version.json', hasMods, hasLibraries, hasServerJar, installerJar: null };
  }

  // 3) Forge/NeoForge maven layout: libraries/net/minecraftforge/forge/<mc>-<build>/...
  for (const name of lower) {
    const forgePath = name.match(new RegExp(`^libraries/net/(minecraftforge/forge|neoforged/neoforge)/${MC_VERSION}-([^/]+)/`));
    if (forgePath) {
      const loader: LoaderFamily = forgePath[1] === 'neoforged/neoforge' ? 'neoforge' : 'forge';
      return { mc: forgePath[2]!, loader, loaderVersion: forgePath[3]!, source: 'libraries/ maven path', hasMods, hasLibraries, hasServerJar, installerJar: null };
    }
  }
  // Fabric/Quilt libraries do not encode the MC version in a comparable way; fall through.

  // 4) A loader installer jar at the root: `forge-1.12.2-14.23.5.2859-installer.jar`.
  const installer = lower.find(name => !name.includes('/') && /(forge|neoforge)-.*installer.*\.jar$/.test(name));
  if (installer) {
    const forge = installer.match(new RegExp(`forge-${MC_VERSION}-([^-]+)`));
    if (forge) {
      return { mc: forge[1]!, loader: installer.includes('neoforge') ? 'neoforge' : 'forge', loaderVersion: forge[2]!, source: 'loader installer jar name', hasMods, hasLibraries, hasServerJar, installerJar: installer };
    }
  }

  // 2) No reliable evidence.
  return { mc: null, loader: hasMods ? 'forge' : 'vanilla', loaderVersion: null, source: null, hasMods, hasLibraries, hasServerJar, installerJar: null };
}

/** True when this archive *looks* like a bare server pack at all (used only by detection). */
export function looksLikeServerZip(names: readonly string[]): boolean {
  const lower = names.map(name => name.replaceAll('\\', '/').toLowerCase());
  const hasMods = lower.some(name => name.startsWith('mods/'));
  const hasLibraries = lower.some(name => name.startsWith('libraries/'));
  const hasRunScript = lower.some(name => !name.includes('/') && /^(run\.(sh|bat)|startserver\.(sh|bat)|start\.(sh|bat))$/.test(name));
  const hasInstallerJar = lower.some(name => !name.includes('/') && /(forge|neoforge)-.*installer.*\.jar$/.test(name));
  const hasServerJar = lower.some(name => /^(server\.jar|minecraft_server[^/]*\.jar)$/.test(name));
  return hasMods || hasLibraries || hasRunScript || hasInstallerJar || hasServerJar;
}

export const serverZipAdapter: PackAdapter = {
  id: 'plain.serverzip',
  displayName: 'Plain server archive (no manifest)',
  shapes: ['archive'],
  // Lowest priority: only reached when no format with real metadata claimed the archive.
  priority: 20,

  detect(input: DetectInput): boolean {
    const archive = input.shape === 'archive' || input.shape === 'instance' ? input.index : undefined;
    if (!archive) return false;
    return looksLikeServerZip(archive.entries.filter(entry => !entry.isDir).map(entry => entry.name));
  },

  async resolve(input: DetectInput, io: AdapterIo): Promise<PackRecipe> {
    const archive = input.shape === 'archive' || input.shape === 'instance' ? input.index : undefined;
    if (!archive) throw appError('validation', 'server-archive adapter needs an archive.');
    const names = archive.entries.filter(entry => !entry.isDir).map(entry => entry.name);
    const versionJson = archive.names.has('version.json')
      ? await archive.readJson<{ id?: unknown }>('version.json')
      : null;
    const evidence = readServerZipEvidence(names, versionJson);

    if (!evidence.mc) {
      // Fail closed: a payload dump with no version evidence cannot be installed safely.
      throw appError('validation',
        'This archive has no pack manifest and does not state its Minecraft version, so it cannot be installed '
        + 'safely. Add a manifest (Modrinth, CurseForge, packwiz, Prism or ATLauncher) or an exact Minecraft '
        + `version. Evidence checked: ${[
          'version.json', 'libraries/ maven path', 'loader installer jar name',
        ].join(', ')}.`);
    }

    const warnings: RecipeWarning[] = [];
    warnings.push({
      rule: 'serverzip.manifest-less',
      message: `no pack manifest found; runtime derived from ${evidence.source}. Verified boot decides the rest.`,
    });

    const overrides: OverrideLayer[] = [{ prefix: '', order: 1 }];
    io.log(`[serverzip] MC ${evidence.mc} ${evidence.loader} ${evidence.loaderVersion ?? '(unpinned)'} from ${evidence.source}`);

    return {
      formatId: 'plain.serverzip',
      name: 'Server archive',
      mc: evidence.mc,
      loader: evidence.loader,
      loaderVersion: evidence.loaderVersion,
      javaMajor: null,
      files: [],
      overrides,
      launchShape: evidence.hasServerJar ? 'server-jar' : evidence.hasLibraries ? 'generated-args' : 'runnable-jar',
      managerOwned: [...MANAGER_OWNED_PATHS],
      warnings,
      resolution: [
        { field: 'mc', source: evidence.source ?? 'unknown' },
        { field: 'loader', source: evidence.source ?? 'no loader evidence' },
        { field: 'payload', source: 'archive tree applied as overrides' },
      ],
    };
  },
};



