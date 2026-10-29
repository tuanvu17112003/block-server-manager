// CurseForge adapters — shape A (archive), DELEGATING to the existing CurseForge engine.
//
// Same QA origin as `modrinth.ts`: research §8 line 347 required `modrinth, curseforge, serverpack, bare`
// FIRST, "covers everything the app does today, via the new path, so no regression". The adapter layer was
// written without them, so archives the app already installs were claimed by nothing or by the degraded
// `plain.serverzip` duplicate (docs/audit/20 D1 and D4).
//
// Invariant I2 (docs/audit/23 §4.2): an adapter recognises and normalises; it delegates execution to the
// proven engine. So this module does NOT re-implement archive classification or mrpack parsing. It calls
// `inspectStagedZip` / `inferServerPackMetadata` from `installer/curseforge.ts` — the functions exercised by
// the 12-pack matrix and the real end-to-end runs — and only maps their verdict onto a canonical `PackRecipe`.
//
// Two formats live here, and they are registered as two adapters because they are two rows of the research
// §2 catalogue with different signatures:
//
//   `curseforge.client`     — row 2: `manifest.json` with `manifestType=="minecraftModpack"` +
//                             `manifestVersion==1` + `minecraft.version` + `minecraft.modLoaders[]`.
//   `curseforge.serverpack` — row 11: an AUTHOR server pack with no manifest. Metadata comes from the
//                             distributable's own artifacts: a shipped `forge-*-installer.jar`, the
//                             `libraries/` maven layout, Fabric/Quilt launch jars, or (measured on 2 of the
//                             4 real cached packs) the ServerPackCreator `variables.txt` that the author
//                             shipped inside the distribution.
//
// Deliberately NOT claimed here — research §2 row 12, ServerPackCreator *output* proper, whose signature is
// `manifest.json` with `files[]+minecraftVersion+modloader+serverPackCreatorVersion`. It has no adapter yet;
// absorbing it under a CurseForge id would repeat the duplicated-and-degraded-logic mistake that D4 exists to
// prevent. Recorded as DV-04/DV-05 and DV-07 in docs/audit/24-deviations-register.md (C4 scope).
import { appError } from '../store';
import { inspectStagedZip, inferServerPackMetadata, type CfInspection } from '../installer/curseforge';
import {
  MANAGER_OWNED_PATHS,
  isSafeRelativePath,
  type AdapterIo,
  type DetectInput,
  type FileSide,
  type LoaderFamily,
  type OverrideLayer,
  type PackAdapter,
  type PackRecipe,
  type PlannedFile,
  type RecipeWarning,
} from './types';

/** The CurseForge `manifest.json`, in the shape this adapter reads. */
export interface CfManifest {
  manifestType?: string;
  manifestVersion?: number;
  name?: string;
  minecraft?: { version?: string; modLoaders?: { id?: string; primary?: boolean }[] };
  files?: { projectID?: number; fileID?: number; required?: boolean }[];
}

/**
 * True only for the real CurseForge schema — key validation, never the filename.
 *
 * `manifest.json` is claimed by several formats (research §2 preamble), and ServerPackCreator ships one
 * too (a flat `files[]` list). Requiring `manifestType`, `manifestVersion`, `minecraft.version` and a
 * non-empty `minecraft.modLoaders[]` is what separates them. `inspectStagedZip` is deliberately more
 * lenient (it falls through to layout detection); detection here must not be.
 */
export function isCurseForgeManifest(raw: unknown): raw is CfManifest & {
  manifestType: 'minecraftModpack';
  manifestVersion: 1;
  minecraft: { version: string; modLoaders: { id: string }[] };
} {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const candidate = raw as CfManifest;
  if (candidate.manifestType !== 'minecraftModpack') return false;
  if (candidate.manifestVersion !== 1) return false;
  const minecraft = candidate.minecraft;
  if (!minecraft || typeof minecraft !== 'object') return false;
  if (typeof minecraft.version !== 'string' || minecraft.version.trim() === '') return false;
  if (!Array.isArray(minecraft.modLoaders) || minecraft.modLoaders.length === 0) return false;
  return minecraft.modLoaders.every((entry) => !!entry && typeof entry === 'object'
    && typeof entry.id === 'string' && entry.id.trim() !== '');
}

/**
 * True for a ServerPackCreator output manifest (research §2 row 12).
 * Used only to REFUSE the archive, so this adapter cannot silently absorb a format whose fields
 * (`minecraftVersion`/`modloader`/`serverPackCreatorVersion`) it does not model. Recorded as DV-04/DV-05.
 */
export function isServerPackCreatorManifest(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const candidate = raw as { files?: unknown; minecraftVersion?: unknown; modloader?: unknown; serverPackCreatorVersion?: unknown };
  return Array.isArray(candidate.files)
    && typeof candidate.minecraftVersion === 'string'
    && typeof candidate.modloader === 'string';
}

/**
 * Map a CurseForge `manifest.json` file flag onto the canonical side.
 *
 * Research §2 row 2: CurseForge carries **no side data at all**, only `required`. So `required: true` is
 * `required` and `required: false` is `optional`. No value can honestly become `unsupported` here: that
 * verdict needs curated or jar-level evidence, which is a later layer's job — inventing it in an adapter is
 * the exact failure mode `unknown` exists to prevent. An absent flag is `required`, matching the CF default
 * and the engine's own rule (`f.required === false` is its only skip).
 */
export function cfManifestFileSide(required: boolean | undefined): { side: FileSide; provenance: string } {
  if (required === false) return { side: 'optional', provenance: 'curseforge manifest required=false' };
  return { side: 'required', provenance: 'curseforge manifest required=true/absent (CF has no side data)' };
}

/** Normalise the engine's capitalised loader names onto the canonical loader family. */
export function cfLoaderFamily(loader: string | null | undefined): LoaderFamily | null {
  const value = (loader ?? '').trim().toLowerCase();
  if (value === 'vanilla') return 'vanilla';
  if (value === 'forge') return 'forge';
  if (value === 'neoforge') return 'neoforge';
  if (value === 'fabric') return 'fabric';
  if (value === 'quilt') return 'quilt';
  if (value === 'paper') return 'paper';
  return null;
}

/** `"forge-47.4.0"` → `{ loader: 'forge', version: '47.4.0' }`; validated, never defaulted. */
export function parseCfModLoaderId(id: string): { loader: LoaderFamily; version: string | null } | null {
  const match = (id ?? '').trim().match(/^(forge|neoforge|fabric|quilt)-(.+)$/i);
  if (!match) return null;
  const loader = cfLoaderFamily(match[1]);
  if (!loader) return null;
  return { loader, version: match[2]?.trim() || null };
}

/**
 * Build the canonical recipe for a CurseForge CLIENT pack (research §2 row 2).
 *
 * Files are emitted with provider coordinates rather than URLs, because a CF manifest carries none: the CDN
 * URL must be resolved through the API at install time (`FileSource.provider` exists for exactly this, and
 * `validateRecipe` accepts it). No filename is invented beyond a deterministic placeholder, because the
 * manifest itself carries none — the engine names the file when it downloads it.
 */
export function buildCurseForgeClientRecipe(manifest: CfManifest & {
  minecraft: { version: string; modLoaders: { id: string; primary?: boolean }[] };
}, archiveName: string): PackRecipe {
  const warnings: RecipeWarning[] = [];
  const primary = manifest.minecraft.modLoaders.find((entry) => entry.primary) ?? manifest.minecraft.modLoaders[0];
  const parsed = parseCfModLoaderId(primary?.id ?? '');
  if (!parsed) {
    throw appError('validation',
      `CurseForge manifest declares an unrecognised modLoader id "${primary?.id ?? '(none)'}"; refusing to guess a loader.`);
  }

  const files: PlannedFile[] = [];
  const seen = new Set<string>();
  let skippedUnidentified = 0;
  let skippedDuplicate = 0;
  for (const entry of manifest.files ?? []) {
    const projectId = Number(entry.projectID);
    const fileId = Number(entry.fileID);
    if (!Number.isInteger(projectId) || projectId <= 0 || !Number.isInteger(fileId) || fileId <= 0) {
      skippedUnidentified += 1;
      continue;
    }
    const destination = `mods/${projectId}-${fileId}.jar`;
    if (!isSafeRelativePath(destination) || seen.has(destination)) { skippedDuplicate += 1; continue; }
    seen.add(destination);
    const mapped = cfManifestFileSide(entry.required);
    files.push({
      path: destination,
      source: { provider: { kind: 'curseforge', projectId, fileId } },
      sha1: null,
      sha512: null,
      size: null,
      side: mapped.side,
      sideProvenance: mapped.provenance,
    });
  }
  if (skippedUnidentified > 0) {
    warnings.push({
      rule: 'curseforge.manifest-entry-unidentified',
      message: `${skippedUnidentified} manifest file entr${skippedUnidentified === 1 ? 'y' : 'ies'} carried no usable projectID/fileID and could not be planned.`,
    });
  }
  if (skippedDuplicate > 0) {
    warnings.push({
      rule: 'curseforge.duplicate-destination',
      message: `${skippedDuplicate} manifest entr${skippedDuplicate === 1 ? 'y' : 'ies'} collided on a destination path; the first was kept.`,
    });
  }
  warnings.push({
    rule: 'curseforge.no-side-data',
    message: 'CurseForge carries no per-file side data; every file stays a server candidate and the curated/boot layers decide later.',
  });
  if (files.length > 0) {
    warnings.push({
      rule: 'curseforge.placeholder-destination',
      message: 'a CurseForge manifest carries no filenames, so each destination is a deterministic '
        + '`mods/<projectId>-<fileId>.jar` placeholder; the engine names the real file when it resolves the '
        + 'provider coordinates against the API.',
    });
  }
  if (manifest.files && manifest.files.length === 0) {
    warnings.push({ rule: 'curseforge.manifest-empty', message: 'manifest.json lists no files; the pack ships only overrides/.' });
  }

  return {
    formatId: 'curseforge.client',
    name: (manifest.name ?? '').trim() || archiveName.replace(/\.zip$/i, ''),
    mc: manifest.minecraft.version,
    loader: parsed.loader,
    loaderVersion: parsed.version,
    javaMajor: null,
    files,
    overrides: [{ prefix: 'overrides/', order: 1 }],
    launchShape: parsed.loader === 'fabric' || parsed.loader === 'quilt' ? 'launch-jar' : 'generated-args',
    managerOwned: [...MANAGER_OWNED_PATHS],
    warnings,
    resolution: [
      { field: 'mc', source: 'manifest.json minecraft.version' },
      { field: 'loader', source: `manifest.json minecraft.modLoaders[].id ("${primary?.id}")` },
      { field: 'files', source: 'manifest.json files[] projectID/fileID → provider coordinates (a CF manifest carries no URLs)' },
      { field: 'side', source: 'manifest.json required flag only; CF has no side data' },
      { field: 'payload', source: 'overrides/ layer' },
    ],
    evidenceGrade: 'E3',
    evidenceNote: 'real CurseForge server-pack archives resolve (3 of 4 cached cfpack zips), but no CurseForge pack has been installed end-to-end through this adapter yet, so resolve parity only.',
  };
}

/**
 * Runtime facts a CF author server pack states about itself, read from the ServerPackCreator
 * `variables.txt` that authors ship inside the distribution.
 *
 * Measured, not assumed: 2 of the 4 real cached CF server packs
 * (`.app-data/cache/cfpack/829758-server-7243901.zip`, `466901-server-9266268.zip`) carry this file, and it
 * declares `MINECRAFT_VERSION`, `MODLOADER`, `MODLOADER_VERSION` as plain `KEY=value` lines. That is
 * machine-readable declared metadata, so reading it is evidence — not the guessing that `plain.serverzip`
 * correctly refuses to do. Values are only accepted when non-empty and structurally valid.
 */
export interface CfVariablesEvidence {
  mc: string | null;
  loader: LoaderFamily | null;
  loaderVersion: string | null;
}

export function readCfVariables(text: string | null): CfVariablesEvidence | null {
  if (text === null) return null;
  const values = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    values.set(match[1]!, match[2]!.trim().replace(/^"(.*)"$/, '$1'));
  }
  const mc = (values.get('MINECRAFT_VERSION') ?? '').trim();
  const loaderRaw = (values.get('MODLOADER') ?? '').trim();
  const loaderVersion = (values.get('MODLOADER_VERSION') ?? '').trim();
  if (mc === '' && loaderRaw === '') return null;
  return {
    mc: /^\d+\.\d+(?:\.\d+)?$/.test(mc) ? mc : null,
    loader: cfLoaderFamily(loaderRaw),
    loaderVersion: loaderVersion === '' ? null : loaderVersion,
  };
}

/**
 * Build the canonical recipe for a CurseForge AUTHOR server pack (research §2 row 11).
 *
 * This shape has no manifest: the whole archive IS the server tree, so the payload becomes one root override
 * layer and the recipe carries no download list. `mc` is required — a payload dump with no version evidence
 * must never be guessed into a runtime. `loader` may fall back to the shape's documented default (Forge,
 * which is what the engine itself uses when no launch jar is present) but only when metadata evidence exists
 * to anchor the pack; it is recorded in `resolution` so the fallback is visible.
 */
export function buildCurseForgeServerPackRecipe(
  inspection: CfInspection,
  entryNames: readonly string[],
  variables: CfVariablesEvidence | null = null,
): PackRecipe {
  if (inspection.classification !== 'supportedServerPack') {
    throw appError('validation',
      `CurseForge inspector classified this archive as "${inspection.classification}": ${inspection.reason}`);
  }
  const lower = entryNames.map((name) => name.replaceAll('\\', '/').toLowerCase());
  const mc = (variables?.mc ?? inspection.minecraftVersion ?? '').trim();
  const loader = variables?.loader ?? cfLoaderFamily(inspection.loader);

  if (!mc) {
    throw appError('validation',
      'This server pack states no Minecraft version that this adapter can read, so it cannot be installed '
      + 'safely. If it carries a ServerPackCreator manifest.json (files[] + minecraftVersion + modloader + '
      + 'serverPackCreatorVersion), that is a different format (research §2 row 12) with no adapter yet — '
      + `recorded as DV-04/DV-05 (C4 scope). Inspected: ${inspection.reason}`);
  }
  if (!loader || loader === 'hybrid') {
    throw appError('validation',
      `CurseForge server pack declares loader "${variables?.loader ?? inspection.loader ?? '(none)'}", `
      + 'which is not a supported server loader.');
  }

  const warnings: RecipeWarning[] = [{
    rule: 'curseforge.manifest-less-serverpack',
    message: `${inspection.reason} The archive tree is applied as a single root layer; verified boot decides the rest.`,
  }];
  if (variables?.mc) {
    warnings.push({
      rule: 'curseforge.metadata-from-variables-txt',
      message: 'the pack ships a ServerPackCreator variables.txt; MINECRAFT_VERSION/MODLOADER/MODLOADER_VERSION were read from it as declared metadata.',
    });
  }
  if (inspection.nestedZip) {
    warnings.push({
      rule: 'curseforge.nested-zip',
      message: `this archive is a thin wrapper around one nested server pack ("${inspection.nestedZip}"); the engine unwraps it.`,
    });
  }

  const hasLibraries = lower.some((name) => name.startsWith('libraries/'));
  const hasLaunchJar = lower.some((name) => /^(fabric|quilt)-server-launch/.test(name));
  const hasServerJar = lower.some((name) => /^(server\.jar|minecraft_server[^/]*\.jar)$/.test(name));
  const hasShippedStartScript = lower.some((name) => !name.includes('/') && /^(start|run|startserver)\.(sh|bat|ps1)$/.test(name));
  const launchShape: PackRecipe['launchShape'] = hasLaunchJar
    ? 'launch-jar'
    : hasLibraries
      ? 'generated-args'
      : hasServerJar
        ? 'server-jar'
        : hasShippedStartScript
          ? 'vendor-script'
          : 'runnable-jar';

  const overrides: OverrideLayer[] = [{ prefix: '', order: 1 }];
  return {
    formatId: 'curseforge.serverpack',
    name: inspection.name.replace(/\.zip$/i, ''),
    mc,
    loader,
    loaderVersion: variables?.loaderVersion ?? inspection.loaderVersion,
    javaMajor: null,
    // No download list: the payload is already inside the archive.
    files: [],
    overrides,
    launchShape,
    managerOwned: [...MANAGER_OWNED_PATHS],
    warnings,
    resolution: [
      {
        field: 'mc',
        source: variables?.mc
          ? 'variables.txt MINECRAFT_VERSION (declared inside the pack)'
          : 'CurseForge inspector + archive artifact inference',
      },
      {
        field: 'loader',
        source: variables?.loader
          ? 'variables.txt MODLOADER (declared inside the pack)'
          : `CurseForge inspector ("${inspection.loader ?? 'none'}")`,
      },
      { field: 'payload', source: 'whole archive tree applied as the root override layer (no manifest, no download list)' },
    ],
    evidenceGrade: 'E3',
    evidenceNote: 'real CurseForge server-pack archives resolve (3 of 4 cached cfpack zips), but no CurseForge pack has been installed end-to-end through this adapter yet, so resolve parity only.',
  };
}

/** Root markers that belong to ANOTHER format. Presence means "not ours", whatever else is in the zip. */
const FOREIGN_FORMAT_MARKERS: readonly string[] = [
  'modrinth.index.json',
  'pack.toml',
  'modpack.toml',
  'mmc-pack.json',
  'instance.json',
  'mcbbs.packmeta',
  'gdlpack.json',
  'server-manifest.json',
];

/**
 * Structural evidence that this archive is a CF AUTHOR server pack (row 11) — and only that.
 *
 * Two gates, in order:
 *  1. Another format's marker means "not ours": an archive that states its own format IS that format.
 *     A zipped packwiz or Prism instance also contains `mods/`, and this adapter sits above them (85 vs
 *     60/55), so claiming them here would be exactly the mis-detection the research §2 preamble warns of.
 *  2. Real loader/version evidence must exist: the engine's own `inferServerPackMetadata` (imported, never
 *     copied) or the declared `variables.txt`. A bare `mods/` dump is NOT enough — `plain.serverzip` owns
 *     that shape and must keep owning it.
 */
export function looksLikeCfAuthorServerPack(names: readonly string[], variables: CfVariablesEvidence | null = null): boolean {
  const lower = names.map((name) => name.replaceAll('\\', '/').toLowerCase());
  if (lower.some((name) => FOREIGN_FORMAT_MARKERS.includes(name))) return false;
  if (variables?.mc) return true;
  return inferServerPackMetadata([...names]) !== null;
}

export const curseForgeClientAdapter: PackAdapter = {
  id: 'curseforge.client',
  displayName: 'CurseForge client pack (manifest.json)',
  shapes: ['archive'],
  // Below Modrinth (90): an .mrpack is fully self-describing. Above every payload-only adapter, because a
  // validated CF manifest carries real metadata that `plain.serverzip` cannot see.
  priority: 88,

  async detect(input: DetectInput): Promise<boolean> {
    if (input.shape !== 'archive') return false;
    return isCurseForgeManifest(await input.index.readJson<unknown>('manifest.json'));
  },

  async resolve(input: DetectInput, io: AdapterIo): Promise<PackRecipe> {
    if (input.shape !== 'archive') {
      throw appError('validation', `curseforge adapter cannot handle a "${input.shape}" input.`);
    }
    const manifest = await input.index.readJson<unknown>('manifest.json');
    if (manifest !== null && isServerPackCreatorManifest(manifest)) {
      throw appError('validation',
        'This archive is ServerPackCreator output (manifest.json with files[]/minecraftVersion/modloader), '
        + 'which is a distinct format with no adapter yet — recorded as DV-04/DV-05 (C4 scope). It is not '
        + 'installed through the CurseForge client adapter.');
    }
    if (!isCurseForgeManifest(manifest)) {
      throw appError('validation',
        'manifest.json is not a CurseForge manifest (needs manifestType "minecraftModpack", manifestVersion 1, '
        + 'minecraft.version and minecraft.modLoaders[]).');
    }
    io.log(`[curseforge] client pack "${manifest.name ?? '(unnamed)'}" ${manifest.files?.length ?? 0} manifest files`);
    const archiveName = input.path ? input.path.split(/[\\/]/).pop() ?? 'curseforge.zip' : 'curseforge.zip';
    return buildCurseForgeClientRecipe(manifest, archiveName);
  },
};

export const curseForgeServerPackAdapter: PackAdapter = {
  id: 'curseforge.serverpack',
  displayName: 'CurseForge author server pack (no manifest)',
  shapes: ['archive'],
  // Just below the client adapter: same family, but its evidence is weaker (artifacts, not a manifest).
  priority: 87,

  async detect(input: DetectInput): Promise<boolean> {
    if (input.shape !== 'archive') return false;
    const index = input.index;
    // A manifest of any kind makes this a manifest format, never the manifest-less row 11 shape.
    if (index.names.has('manifest.json')) return false;
    const names = index.entries.filter((entry) => !entry.isDir).map((entry) => entry.name);
    const variables = index.names.has('variables.txt')
      ? readCfVariables(await index.readText('variables.txt'))
      : null;
    return looksLikeCfAuthorServerPack(names, variables);
  },

  async resolve(input: DetectInput, io: AdapterIo): Promise<PackRecipe> {
    if (input.shape !== 'archive') {
      throw appError('validation', `curseforge server-pack adapter cannot handle a "${input.shape}" input.`);
    }
    const index = input.index;
    const names = index.entries.filter((entry) => !entry.isDir).map((entry) => entry.name);
    const variables = index.names.has('variables.txt')
      ? readCfVariables(await index.readText('variables.txt'))
      : null;

    // When the pack declares its own runtime, no engine call is needed — but when it does not, the
    // classification MUST still come from the proven inspector rather than being re-derived here.
    let inspection: CfInspection;
    if (variables?.mc && variables.loader) {
      inspection = {
        name: input.path ? input.path.split(/[\\/]/).pop() ?? 'serverpack.zip' : 'serverpack.zip',
        classification: 'supportedServerPack',
        reason: 'Server pack with declared variables.txt metadata.',
        minecraftVersion: variables.mc,
        loader: variables.loader,
        loaderVersion: variables.loaderVersion,
      };
    } else {
      if (!input.path) {
        throw appError('validation',
          'This server pack states no runtime of its own, so classification must be delegated to the engine\'s '
          + 'inspectStagedZip, which needs the archive path — none was supplied with this input.');
      }
      inspection = await inspectStagedZip(input.path);
    }
    io.log(`[curseforge] server pack "${inspection.name}": ${inspection.classification} — ${inspection.reason}`);
    return buildCurseForgeServerPackRecipe(inspection, names, variables);
  },
};
