// ATLauncher adapter â€” `instance.json`.
//
// Schema read from ATLauncher's own serializer (`data/Instance.java` @Json + Gson `save()` at L1994-2001, and
// `data/InstanceLauncher.java`), commit 8e9a713:
//   top level : uuid (UUID), inheritsFrom (String), launcher (InstanceLauncher)
//   launcher  : name, pack, description, packId, externalPackId, version, hash, java, loaderVersion,
//               requiredMemory, maximumMemory, javaPath, javaArguments, ...
//
// **Three different formats write a file named `instance.json`** (census Â§2): ATLauncher (`uuid` + `launcher`),
// FTB App (`id`/`versionId`/`mcVersion`/`modLoader`) and the vanilla Minecraft launcher (`profiles`). Filename
// alone is meaningless, so detection validates keys and the priority order decides.
//
// Like Prism, ATLauncher has no "export server pack" concept; a CF-sourced ATL instance may carry a
// `curseForgeManifest`, in which case the CurseForge adapter's rules apply to that manifest instead.
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

interface AtlLoaderVersion {
  type?: unknown;
  version?: unknown;
  /** Some ATL exports use `loader` instead of `type`. */
  loader?: unknown;
}

interface AtlInstanceLauncher {
  name?: unknown;
  pack?: unknown;
  packId?: unknown;
  version?: unknown;
  loaderVersion?: unknown;
  java?: unknown;
  javaPath?: unknown;
  requiredMemory?: unknown;
  curseForgeManifest?: unknown;
}

interface AtlInstance {
  uuid?: unknown;
  inheritsFrom?: unknown;
  launcher?: unknown;
}

/** Loader names ATLauncher writes into `launcher.loaderVersion.type`. */
const ATL_LOADERS: Record<string, LoaderFamily> = {
  forge: 'forge',
  neoforge: 'neoforge',
  fabric: 'fabric',
  quilt: 'quilt',
  vanilla: 'vanilla',
  paper: 'paper',
  craftbukkit: 'paper',
  spigot: 'paper',
};

/** A valid ATLauncher instance: an object whose `launcher` table carries a name and/or pack identity. */
export function readAtlInstance(raw: unknown): { launcher: AtlInstanceLauncher; uuid: string | null } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const instance = raw as AtlInstance;
  if (typeof instance.launcher !== 'object' || instance.launcher === null || Array.isArray(instance.launcher)) return null;
  const launcher = instance.launcher as AtlInstanceLauncher;
  // Must identify a pack: name or pack. This is what separates it from FTB (numeric ids) and vanilla (profiles).
  const hasIdentity = (typeof launcher.name === 'string' && launcher.name.trim() !== '')
    || (typeof launcher.pack === 'string' && launcher.pack.trim() !== '')
    || typeof launcher.packId === 'number';
  if (!hasIdentity) return null;
  // ...and must NOT look like FTB or the vanilla launcher.
  if (typeof (raw as Record<string, unknown>).mcVersion === 'string') return null;
  if (typeof (raw as Record<string, unknown>).versionId === 'number') return null;
  if (Object.hasOwn(raw as Record<string, unknown>, 'profiles')) return null;
  return { launcher, uuid: typeof instance.uuid === 'string' ? instance.uuid : null };
}

/** Extract loader + build from `launcher.loaderVersion`. */
export function readAtlLoader(launcher: AtlInstanceLauncher): { loader: LoaderFamily; loaderVersion: string | null } {
  const value = launcher.loaderVersion;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { loader: 'vanilla', loaderVersion: null };
  const entry = value as AtlLoaderVersion;
  const rawType = (typeof entry.type === 'string' ? entry.type : typeof entry.loader === 'string' ? entry.loader : '').trim().toLowerCase();
  const loader = ATL_LOADERS[rawType] ?? 'vanilla';
  const version = typeof entry.version === 'string' && entry.version.trim() !== '' ? entry.version.trim() : null;
  return { loader, loaderVersion: version };
}

/** Minecraft version: ATL stores it on `launcher.version` for pack instances. */
export function readAtlMc(launcher: AtlInstanceLauncher): string | null {
  const value = launcher.version;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export const atlauncherAdapter: PackAdapter = {
  id: 'atlauncher',
  displayName: 'ATLauncher (instance.json)',
  shapes: ['archive'],
  priority: 50,

  async detect(input: DetectInput): Promise<boolean> {
    const archive = input.shape === 'archive' || input.shape === 'instance' ? input.index : undefined;
    if (!archive) return false;
    if (!archive.names.has('instance.json')) return false;
    const raw = await archive.readJson('instance.json');
    return readAtlInstance(raw) !== null;
  },

  async resolve(input: DetectInput, io: AdapterIo): Promise<PackRecipe> {
    const archive = input.shape === 'archive' || input.shape === 'instance' ? input.index : undefined;
    if (!archive) throw appError('validation', 'ATLauncher adapter needs an archive.');
    const raw = await archive.readJson('instance.json');
    const instance = readAtlInstance(raw);
    if (!instance) {
      throw appError('validation',
        'instance.json is not an ATLauncher instance (needs a "launcher" object with a pack name).');
    }
    const { launcher } = instance;
    if (typeof launcher.curseForgeManifest === 'object' && launcher.curseForgeManifest !== null) {
      // A CF-sourced ATL instance should be installed via the CurseForge path, which has exact project/file ids.
      throw appError('validation',
        'This ATLauncher instance is CurseForge-sourced (it carries a curseForgeManifest). '
        + 'Install the CurseForge pack instead so exact project and file ids are used.');
    }

    const mc = readAtlMc(launcher);
    if (!mc) {
      throw appError('validation',
        'This ATLauncher instance does not declare launcher.version, so the Minecraft version is unknown; '
        + 'refusing to guess a runtime.');
    }
    const { loader, loaderVersion } = readAtlLoader(launcher);
    const name = (typeof launcher.name === 'string' && launcher.name.trim()) || 'ATLauncher instance';

    const warnings: RecipeWarning[] = [];
    warnings.push({
      rule: 'atl.local-instance-payload',
      message: 'ATLauncher instances keep their payload locally; this archive is converted by applying its tree as '
        + 'an override layer. Verified boot decides whether the result works as a server.',
    });

    const overrides: OverrideLayer[] = [{ prefix: '', order: 1 }];

    // Java hints: ATL records `java`/`javaPath` for the client; they are advisory here (Mojang metadata wins).
    const javaHint = typeof launcher.javaPath === 'string' ? launcher.javaPath : null;
    if (javaHint) warnings.push({ rule: 'atl.java-hint', message: `ATLauncher records javaPath "${javaHint}"; Java is resolved from Mojang metadata instead.` });

    io.log(`[atlauncher] "${name}" ${loader} ${loaderVersion ?? '(unpinned)'} MC ${mc}`);
    return {
      formatId: 'atlauncher',
      name,
      mc,
      loader,
      loaderVersion,
      javaMajor: null,
      files: [],
      overrides,
      launchShape: loader === 'fabric' || loader === 'quilt' || loader === 'paper' ? 'launch-jar' : 'generated-args',
      managerOwned: [...MANAGER_OWNED_PATHS],
      warnings,
      resolution: [
        { field: 'mc', source: 'instance.json launcher.version' },
        { field: 'loader', source: loader === 'vanilla' ? 'no launcher.loaderVersion.type' : `instance.json launcher.loaderVersion.type="${loader}"` },
        { field: 'payload', source: 'ATLauncher instance tree applied as overrides' },
      ],
    evidenceGrade: 'E3',
    evidenceNote: 'schema-derived from ATLauncher instance.json; NO real ATLauncher instance exists on disk, so nothing was installed. Not proof.',
    };
  },
};



