// Prism / MultiMC adapter â€” `mmc-pack.json`.
//
// Schema read from Prism's own serializer (`launcher/minecraft/PackProfile.cpp`, commit 1814088):
//   { formatVersion: 1, components: [ { uid, version, dependencyOnly?, important?, cachedName?, cachedVolatile? } ] }
//   formatVersion is a REQUIRED integer and must equal 1; components is a REQUIRED array; each component needs
//   `uid` (string) and `version` (string).
//
// Runtime components (from Component.cpp's ModPlatform map, all mutually exclusive):
//   net.minecraft | net.minecraftforge | net.neoforged | net.fabricmc.fabric-loader | org.quiltmc.quilt-loader
//
// Honest limitation established during the census: **Prism cannot export a server pack.** Its export menu only
// offers zip / .mrpack / CurseForge pack. So an `mmc-pack.json` archive is a *client instance*: the loader and
// MC version are authoritative, but the payload is the client's `.minecraft` tree. Converting it to a server
// means using that tree as an override layer, which is inference â€” and it is reported as a warning, not sold as
// a recommended path.
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

/** `mmc-pack.json` format version this adapter understands (Prism hard-codes 1). */
export const MMC_FORMAT_VERSION = 1;

/** Component uid â†’ loader family. `net.minecraft` is handled separately (it is the MC version). */
const MMC_LOADERS: readonly { uid: string; loader: LoaderFamily }[] = [
  { uid: 'net.neoforged', loader: 'neoforge' },
  { uid: 'net.minecraftforge', loader: 'forge' },
  { uid: 'org.quiltmc.quilt-loader', loader: 'quilt' },
  { uid: 'net.fabricmc.fabric-loader', loader: 'fabric' },
];

export const MMC_MINECRAFT_UID = 'net.minecraft';

interface MmcComponent { uid?: unknown; version?: unknown }
interface MmcPack { formatVersion?: unknown; components?: unknown }

/** Validate the structure Prism itself requires. Returns the components on success. */
export function validateMmcPack(raw: unknown): { components: MmcComponent[] } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const pack = raw as MmcPack;
  if (pack.formatVersion !== MMC_FORMAT_VERSION) return null;
  if (!Array.isArray(pack.components) || pack.components.length === 0) return null;
  const components: MmcComponent[] = [];
  for (const entry of pack.components) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const component = entry as MmcComponent;
    if (typeof component.uid !== 'string' || component.uid === '') return null;
    if (typeof component.version !== 'string') return null;
    components.push(component);
  }
  return { components };
}

/** Extract MC version + loader from the component list. */
export function readMmcRuntime(components: MmcComponent[]): {
  mc: string | null;
  loader: LoaderFamily;
  loaderVersion: string | null;
  loaderUid: string | null;
  conflicting: string[];
} {
  const byUid = new Map(components.map(component => [component.uid as string, String(component.version)]));
  const mc = byUid.get(MMC_MINECRAFT_UID) ?? null;
  const present = MMC_LOADERS.filter(entry => byUid.has(entry.uid));
  // Prism's own component map declares these mutually exclusive, so two of them is contradictory metadata.
  const conflicting = present.length > 1 ? present.map(entry => entry.uid) : [];
  const chosen = present[0] ?? null;
  return {
    mc,
    loader: chosen?.loader ?? 'vanilla',
    loaderVersion: chosen ? (byUid.get(chosen.uid) ?? null) : null,
    loaderUid: chosen?.uid ?? null,
    conflicting,
  };
}

export const prismAdapter: PackAdapter = {
  id: 'prism.multimc',
  displayName: 'Prism / MultiMC (mmc-pack.json)',
  shapes: ['archive', 'instance'],
  priority: 55,

  async detect(input: DetectInput): Promise<boolean> {
    const archive = input.shape === 'archive' || input.shape === 'instance' ? input.index : undefined;
    if (!archive) return false;
    if (!archive.names.has('mmc-pack.json')) return false;
    const raw = await archive.readJson('mmc-pack.json');
    return validateMmcPack(raw) !== null;
  },

  async resolve(input: DetectInput, io: AdapterIo): Promise<PackRecipe> {
    const archive = input.shape === 'archive' || input.shape === 'instance' ? input.index : undefined;
    if (!archive) throw appError('validation', 'Prism adapter needs an archive.');
    const raw = await archive.readJson('mmc-pack.json');
    const pack = validateMmcPack(raw);
    if (!pack) {
      throw appError('validation',
        'mmc-pack.json is not a Prism/MultiMC pack (needs formatVersion 1 and a components array of {uid, version}).');
    }
    const runtime = readMmcRuntime(pack.components);
    if (!runtime.mc) {
      throw appError('validation',
        'mmc-pack.json has no "net.minecraft" component, so the Minecraft version is unknown; refusing to guess.');
    }

    const warnings: RecipeWarning[] = [];
    if (runtime.conflicting.length > 0) {
      throw appError('validation',
        `mmc-pack.json declares conflicting loaders (${runtime.conflicting.join(', ')}); Prism treats these as mutually exclusive.`);
    }

    // Instance name: Prism keeps it in instance.cfg; mmc-pack.json itself has no name field.
    const instanceCfg = await archive.readText('instance.cfg');
    const name = (instanceCfg?.match(/^name=(.+)$/m)?.[1]?.trim()) || 'Prism instance';

    // Prism has no server export, so a server build from this archive is inferred: the client instance's
    // payload becomes the override layer and the loader/MC come from the components.
    warnings.push({
      rule: 'prism.client-instance-as-server',
      message: 'Prism cannot export a server pack, so this client instance is converted by using its payload as an '
        + 'override layer. Verified boot decides whether the result is a working server.',
    });

    const overrides: OverrideLayer[] = [
      { prefix: '.minecraft/', order: 1 },
      { prefix: '', order: 2 },
    ];

    io.log(`[prism] "${name}" ${runtime.loader} ${runtime.loaderVersion ?? '(unpinned)'} MC ${runtime.mc} from components`);
    return {
      formatId: 'prism.multimc',
      name,
      mc: runtime.mc,
      loader: runtime.loader,
      loaderVersion: runtime.loaderVersion,
      javaMajor: null,
      // A Prism instance holds its payload locally; there is nothing to download into mods/.
      files: [],
      overrides,
      launchShape: runtime.loader === 'fabric' || runtime.loader === 'quilt' ? 'launch-jar' : 'generated-args',
      managerOwned: [...MANAGER_OWNED_PATHS],
      warnings,
      resolution: [
        { field: 'mc', source: 'mmc-pack.json component "net.minecraft"' },
        { field: 'loader', source: runtime.loaderUid ? `mmc-pack.json component "${runtime.loaderUid}"` : 'no loader component' },
        { field: 'payload', source: 'Prism instance tree applied as overrides (no server export exists)' },
      ],
    };
  },
};



