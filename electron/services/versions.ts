// Provider version/loader catalogue (ADR-0007 / docs/implementation/full-version-catalogue.md).
//
// Every mapper is a pure function over already-fetched provider JSON/XML (unit-tested with inline
// fixtures in electron/test/unit/versions.test.ts); the network functions are thin wrappers.
//
// Catalogue rules (live-verified 2026-10-26):
// - Vanilla: Mojang manifest `release` + `snapshot`; `old_beta`/`old_alpha` are never offered.
// - Paper: Fill v3 `/projects/paper/versions` — every listed MC is a *release* (support status is
//   advisory, e.g. 1.21.1 is UNSUPPORTED yet has 128 STABLE builds); only pre/rc/snapshot ids are
//   `snapshot`. Builds are resolved separately: a Paper choice exists only when a STABLE
//   artifact-complete build exists, and it pins that build id.
// - Fabric: Meta v2 loader list, `stable` is advisory — all loaders are listed, stable first.
// - Forge: promotions (recommended/latest) + the full official per-MC `maven-metadata.json`
//   catalogue (every entry is installable). Choices carry the bare build (e.g. `52.1.20`) because
//   the install coordinate reconstructs the exact artifact as `{mc}-{build}`.
// - NeoForge: documented MC→build-family mapping only (never numeric inference):
//     1.20.1      -> legacy artifact `net/neoforged/forge` versions `1.20.1-47.x`
//     1.20.2+ x.y -> modern family `{minor}.{patch}.`  (1.20.4→20.4., 1.21→21.0., 1.21.1→21.1.)
//     26.x        -> modern family `{mcVersion}.`      (26.3 → 26.3.)
//   Non-beta/alpha/snapshot builds sort first and carry an inline label; betas stay installable.
import { fetchOk, selectPaperBuild, type FillBuild } from './installer/core';

export interface MinecraftVersionDto {
  id: string;
  releaseTime: string;
  versionType: string;
  /** Paper support status (advisory only; additive so `MinecraftVersionDto` stays compatible). */
  support?: string | null;
}

export interface LoaderChoiceDto {
  loader: 'Vanilla' | 'Paper' | 'Fabric' | 'Forge' | 'NeoForge';
  version: string | null;
  label: string;
  stable?: boolean | null;
}

export const MOJANG_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
export const PAPER_VERSIONS_URL = 'https://fill.papermc.io/v3/projects/paper/versions';
export const FABRIC_LOADERS_URL = 'https://meta.fabricmc.net/v2/versions/loader';
export const FORGE_PROMOTIONS_URL = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
export const FORGE_CATALOGUE_URL = 'https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json';
export const FORGE_MAVEN_ROOT = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
export const NEOFORGE_MAVEN_ROOT = 'https://maven.neoforged.net/releases/net/neoforged';
export const NEOFORGE_METADATA_URL = `${NEOFORGE_MAVEN_ROOT}/neoforge/maven-metadata.xml`;
export const NEOFORGE_LEGACY_METADATA_URL = `${NEOFORGE_MAVEN_ROOT}/forge/maven-metadata.xml`;
/** Newest non-promoted Forge builds listed per MC behind the "Show all builds" toggle. */
export const FORGE_SPECIFIC_LIMIT = 10;

// ------------------------------------------------------------------------------------------------
// small shared helpers
// ------------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Pre-release/release-candidate/snapshot Minecraft ids (Paper lists those in the same catalogue). */
export function isSnapshotLikeVersion(id: string): boolean {
  return /-(?:pre|rc|snapshot)(?:\d+|-\d+)*$/i.test(id) || /snapshot/i.test(id);
}

/**
 * Deterministic newest-first ordering for provider build ids: numeric dot segments descending,
 * then qualifiers (a plain numeric build sorts before the same build with `beta`/`alpha`).
 */
export function compareVersionsDesc(a: string, b: string): number {
  const parts = (version: string): (number | string)[] => version
    .toLowerCase()
    .split(/[.+-]/)
    .filter((segment) => segment.length > 0)
    .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
  const left = parts(a);
  const right = parts(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const x = left[index];
    const y = right[index];
    if (x === undefined) return 1; // shorter version sorts after the longer one
    if (y === undefined) return -1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return y - x;
      continue;
    }
    if (typeof x === 'number') return -1; // numeric build before its suffixed variant
    if (typeof y === 'number') return 1;
    if (x !== y) return x < y ? 1 : -1;
  }
  return 0;
}

/** Stable-first deterministic order; ties broken by version then label. */
function sortChoices(choices: LoaderChoiceDto[]): LoaderChoiceDto[] {
  const rank = (choice: LoaderChoiceDto): number => (choice.stable === false ? 1 : 0);
  return choices
    .map((choice, index) => ({ choice, index }))
    .sort((a, b) => (rank(a.choice) - rank(b.choice))
      || compareVersionsDesc(a.choice.version ?? '', b.choice.version ?? '')
      || a.choice.label.localeCompare(b.choice.label)
      || a.index - b.index)
    .map((entry) => entry.choice);
}

// ------------------------------------------------------------------------------------------------
// Minecraft (Vanilla) catalogue
// ------------------------------------------------------------------------------------------------

/** Mojang manifest entries: releases + snapshots only; `old_beta`/`old_alpha` are never offered. */
export function mapVanillaVersions(manifest: unknown): MinecraftVersionDto[] {
  const versions = Array.isArray(manifest)
    ? manifest
    : isRecord(manifest) && Array.isArray(manifest.versions) ? manifest.versions : [];
  const seen = new Set<string>();
  const out: MinecraftVersionDto[] = [];
  for (const entry of versions) {
    if (!isRecord(entry)) continue;
    const id = asString(entry.id);
    const type = asString(entry.type);
    if (!id || (type !== 'release' && type !== 'snapshot') || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, releaseTime: asString(entry.releaseTime), versionType: type });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Paper (Fill v3) catalogue
// ------------------------------------------------------------------------------------------------

interface FillPaperVersionEntry {
  version?: { id?: unknown; support?: { status?: unknown } };
  builds?: unknown;
}

/**
 * Fill v3 `/projects/paper/versions` entries. Paper's support status is advisory: every listed MC
 * is a release for the picker (1.21.1 is UNSUPPORTED yet has 128 STABLE builds — the old mapper
 * labelled it `snapshot` and hid it). Only pre/rc/snapshot ids map to `snapshot`.
 */
export function mapPaperVersions(fillVersions: unknown): MinecraftVersionDto[] {
  const entries: FillPaperVersionEntry[] = Array.isArray(fillVersions)
    ? fillVersions as FillPaperVersionEntry[]
    : isRecord(fillVersions) && Array.isArray(fillVersions.versions)
      ? fillVersions.versions as FillPaperVersionEntry[]
      : [];
  const seen = new Set<string>();
  const out: MinecraftVersionDto[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.version)) continue;
    const id = asString(entry.version.id);
    if (!id || seen.has(id)) continue;
    // A version with an explicitly empty build list has no installable artifact available.
    if (Array.isArray(entry.builds) && entry.builds.length === 0) continue;
    seen.add(id);
    const status = isRecord(entry.version.support) ? asString(entry.version.support.status) : '';
    out.push({
      id,
      releaseTime: '',
      versionType: isSnapshotLikeVersion(id) ? 'snapshot' : 'release',
      support: status || null,
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Fabric (Meta v2) catalogue
// ------------------------------------------------------------------------------------------------

export interface FabricLoader {
  version: string;
  stable: boolean;
}

/** Accepts both `/v2/versions/loader/{mc}` (`{loader:{version,stable}}`) and `/v2/versions/loader`. */
export function mapFabricLoaders(fabricMeta: unknown): FabricLoader[] {
  const entries = Array.isArray(fabricMeta) ? fabricMeta : [];
  const seen = new Set<string>();
  const out: FabricLoader[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const loader = isRecord(entry.loader) ? entry.loader : entry;
    const version = asString(loader.version);
    if (!version || seen.has(version)) continue;
    seen.add(version);
    out.push({ version, stable: loader.stable === true });
  }
  // Stable first; provider order (already newest-first) preserved inside each group.
  return out
    .map((loader, index) => ({ loader, index }))
    .sort((a, b) => (Number(b.loader.stable) - Number(a.loader.stable)) || (a.index - b.index))
    .map((entry) => entry.loader);
}

// ------------------------------------------------------------------------------------------------
// Forge catalogue
// ------------------------------------------------------------------------------------------------

const FORGE_CATALOGUE_PREFIX = (mcVersion: string): string => `${mcVersion}-`;

/**
 * Forge choices: promoted `recommended`/`latest` first (stable), then the newest
 * `FORGE_SPECIFIC_LIMIT` catalogue-only builds (non-stable, behind "Show all builds").
 * `version` is the bare build (`52.1.20`) so the installer rebuilds the exact catalogue artifact
 * as `{mc}-{version}`; labels name the promoted/catalogue role.
 */
export function mapForgeCatalogue(promotions: unknown, mavenCatalogue: unknown, mcVersion: string): LoaderChoiceDto[] {
  const mc = asString(mcVersion);
  if (!mc) return [];
  const promos = isRecord(promotions) && isRecord(promotions.promos) ? promotions.promos : isRecord(promotions) ? promotions : {};
  const recommended = asString(promos[`${mc}-recommended`]);
  const latest = asString(promos[`${mc}-latest`]);

  const prefix = FORGE_CATALOGUE_PREFIX(mc);
  const catalogue = isRecord(mavenCatalogue) && Array.isArray(mavenCatalogue[mc])
    ? mavenCatalogue[mc] as unknown[]
    : Array.isArray(mavenCatalogue) ? mavenCatalogue : [];
  const builds: string[] = [];
  const seen = new Set<string>();
  for (const entry of catalogue) {
    const artifact = asString(entry);
    if (!artifact.startsWith(prefix)) continue;
    const bare = artifact.slice(prefix.length);
    if (!bare || seen.has(bare)) continue;
    seen.add(bare);
    builds.push(bare);
  }

  const choices: LoaderChoiceDto[] = [];
  if (recommended) choices.push({ loader: 'Forge', version: recommended, label: `Forge ${recommended} (recommended)`, stable: true });
  if (latest && latest !== recommended) choices.push({ loader: 'Forge', version: latest, label: `Forge ${latest} (latest)`, stable: true });
  const specific = builds
    .filter((build) => build !== recommended && build !== latest)
    .sort(compareVersionsDesc)
    .slice(0, FORGE_SPECIFIC_LIMIT)
    .map((build): LoaderChoiceDto => ({ loader: 'Forge', version: build, label: `Forge ${build} (specific version)`, stable: false }));
  choices.push(...specific);
  // Promoted entries keep their official recommended→latest order, then the newest catalogue builds.
  return choices;
}

// ------------------------------------------------------------------------------------------------
// NeoForge catalogue (documented MC → build family mapping)
// ------------------------------------------------------------------------------------------------

/** NeoForge MC→family mapping; returns a `<prefix>` string (e.g. `21.1.`) or null when unmapped. */
export function neoforgeFamilyPrefix(mcVersion: string): string | null {
  const mc = asString(mcVersion);
  if (!mc) return null;
  const stableMatch = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(mc);
  if (!stableMatch) return null;
  const major = Number(stableMatch[1]);
  const minor = Number(stableMatch[2]);
  const patch = stableMatch[3] === undefined ? 0 : Number(stableMatch[3]);
  if (major === 1) {
    // 1.20.1 keeps the legacy Forge-style 47.x line under `net/neoforged/forge`.
    if (minor === 20 && patch === 1) return '1.20.1-47.';
    // 1.20.2+ modern scheme omits the leading 1: 20.4., 21.0., 21.1., ...
    return `${minor}.${patch}.`;
  }
  // 26.x+ new scheme uses the full MC version: 26.3 -> 26.3., 26.1.2 -> 26.1.2.
  return `${mc}.`;
}

/** NeoForge legacy artifact (1.20.1 only) keeps the `${mc}-47.x` coordinate. */
export function isNeoForgeLegacyMc(mcVersion: string): boolean {
  return neoforgeFamilyPrefix(mcVersion) === '1.20.1-47.';
}

const NEOFORGE_QUALIFIER = /(beta|alpha|snapshot|pre|rc)/i;

/**
 * Map NeoForge Maven versions to choices for one MC, using the documented family mapping.
 * `catalogue.modernVersions` feeds 1.20.2+ (including 26.x); `catalogue.legacyVersions` feeds
 * 1.20.1 (net/neoforged/forge `1.20.1-47.x`). Non-beta/alpha builds sort first.
 */
export function mapNeoForgeCatalogue(catalogue: unknown, mcVersion: string): LoaderChoiceDto[] {
  const mc = asString(mcVersion);
  const family = neoforgeFamilyPrefix(mc);
  if (!family) return [];
  const record = isRecord(catalogue) ? catalogue : {};
  const list = isNeoForgeLegacyMc(mc) ? record.legacyVersions : record.modernVersions;
  const versions = Array.isArray(list) ? list : [];
  const seen = new Set<string>();
  const choices: LoaderChoiceDto[] = [];
  for (const entry of versions) {
    const version = asString(entry);
    if (!version || !version.startsWith(family) || seen.has(version)) continue;
    seen.add(version);
    const qualifier = NEOFORGE_QUALIFIER.exec(version)?.[1]?.toLowerCase() ?? null;
    choices.push({
      loader: 'NeoForge',
      version,
      label: `NeoForge ${version}${qualifier ? ` (${qualifier})` : ''}`,
      stable: qualifier === null,
    });
  }
  return sortChoices(choices);
}

/** Extract `<version>` values from a Maven `maven-metadata.xml` document. */
export function parseMavenVersions(xml: string): string[] {
  if (typeof xml !== 'string') return [];
  return [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
    .map((match) => match[1].trim())
    .filter((version) => version.length > 0);
}

// ------------------------------------------------------------------------------------------------
// Loader pin validation (used by server_install to reject arbitrary pins)
// ------------------------------------------------------------------------------------------------

export interface LoaderPinValidation { ok: boolean; message: string | null }

const LOADER_BY_KEY: Record<string, LoaderChoiceDto['loader']> = {
  vanilla: 'Vanilla', paper: 'Paper', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge',
};

/**
 * Validate a requested loader build against the provider catalogue resolved for `mcVersion`.
 * An empty pin means "no pin" (the installer resolves the provider's latest/default artifact);
 * a non-empty pin must exactly match a catalogue choice — arbitrary/legacy strings are rejected.
 */
export function validateLoaderPin(
  loader: string,
  mcVersion: string,
  loaderVersion: string | null | undefined,
  choices: LoaderChoiceDto[],
): LoaderPinValidation {
  const display = LOADER_BY_KEY[String(loader ?? '').trim().toLowerCase()];
  const mc = String(mcVersion ?? '').trim();
  if (!display) return { ok: false, message: `Unknown loader "${String(loader ?? '')}".` };
  if (!mc) return { ok: false, message: 'Minecraft version is required.' };
  const pin = loaderVersion === null || loaderVersion === undefined ? '' : String(loaderVersion).trim();
  if (!pin) {
    // No pin requested: single-loader installs resolve the provider's latest/default build.
    return { ok: true, message: null };
  }
  if (display === 'Vanilla') {
    if (pin === mc) return { ok: true, message: null };
    return { ok: false, message: `Vanilla does not accept loader version "${pin}" (expected none or "${mc}").` };
  }
  const available = Array.isArray(choices) ? choices.filter((choice) => choice.loader === display) : [];
  if (available.length === 0) {
    return { ok: false, message: `No ${display} builds are available for Minecraft ${mc}; cannot verify loader version "${pin}".` };
  }
  if (!available.some((choice) => String(choice.version ?? '') === pin)) {
    return { ok: false, message: `${display} ${pin} is not listed in the provider catalogue for Minecraft ${mc}.` };
  }
  return { ok: true, message: null };
}

// ------------------------------------------------------------------------------------------------
// Network resolvers (thin wrappers around the mappers above)
// ------------------------------------------------------------------------------------------------

export async function vanillaVersions(): Promise<MinecraftVersionDto[]> {
  const response = await fetchOk(MOJANG_MANIFEST_URL);
  if (!response.ok) throw new Error(`Mojang version manifest HTTP ${response.status}`);
  return mapVanillaVersions(await response.json());
}

export async function paperVersions(): Promise<MinecraftVersionDto[]> {
  const response = await fetchOk(PAPER_VERSIONS_URL);
  if (!response.ok) throw new Error(`Paper version catalogue HTTP ${response.status}`);
  return mapPaperVersions(await response.json());
}

/** Paper choice: only when a STABLE artifact-complete build exists; pins the build id. */
async function resolvePaperChoices(mc: string): Promise<LoaderChoiceDto[]> {
  const response = await fetchOk(`https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(mc)}/builds`);
  if (!response.ok) return [];
  const builds = await response.json() as FillBuild[];
  const artifact = selectPaperBuild(builds); // throws when no STABLE artifact-complete build
  return [{ loader: 'Paper', version: String(artifact.buildId), label: `Paper build ${artifact.buildId} (STABLE)`, stable: true }];
}

async function resolveFabricChoices(mc: string): Promise<LoaderChoiceDto[]> {
  const response = await fetchOk(`${FABRIC_LOADERS_URL}/${encodeURIComponent(mc)}`);
  if (!response.ok) return [];
  return mapFabricLoaders(await response.json()).map((loader): LoaderChoiceDto => ({
    loader: 'Fabric',
    version: loader.version,
    label: loader.stable ? `Fabric Loader ${loader.version}` : `Fabric Loader ${loader.version} (non-stable)`,
    stable: loader.stable,
  }));
}

/** Forge fails closed when either official source is unavailable (ADR-0007). */
async function resolveForgeChoices(mc: string): Promise<LoaderChoiceDto[]> {
  const [promotionsResponse, catalogueResponse] = await Promise.all([
    fetchOk(FORGE_PROMOTIONS_URL),
    fetchOk(FORGE_CATALOGUE_URL),
  ]);
  if (!promotionsResponse.ok || !catalogueResponse.ok) return [];
  return mapForgeCatalogue(await promotionsResponse.json(), await catalogueResponse.json(), mc);
}

async function resolveNeoForgeChoices(mc: string): Promise<LoaderChoiceDto[]> {
  const family = neoforgeFamilyPrefix(mc);
  if (!family) return [];
  if (isNeoForgeLegacyMc(mc)) {
    const response = await fetchOk(NEOFORGE_LEGACY_METADATA_URL);
    if (!response.ok) return [];
    return mapNeoForgeCatalogue({ legacyVersions: parseMavenVersions(await response.text()) }, mc);
  }
  const response = await fetchOk(NEOFORGE_METADATA_URL);
  if (!response.ok) return [];
  return mapNeoForgeCatalogue({ modernVersions: parseMavenVersions(await response.text()) }, mc);
}

/**
 * Full loader catalogue for one Minecraft version: Vanilla always, then provider sections in a
 * fixed order, each stable-first. A provider section that cannot be resolved is omitted (the UI
 * reports "no provider-verified build" for that loader) instead of breaking the whole picker.
 */
export async function loadersResolve(mcVersion: string): Promise<LoaderChoiceDto[]> {
  const mc = String(mcVersion ?? '').trim();
  const out: LoaderChoiceDto[] = [{ loader: 'Vanilla', version: null, label: `Vanilla ${mc}`, stable: true }];
  if (!mc) return out;
  const sections = await Promise.allSettled([
    resolvePaperChoices(mc),
    resolveFabricChoices(mc),
    resolveForgeChoices(mc),
    resolveNeoForgeChoices(mc),
  ]);
  for (const section of sections) {
    if (section.status === 'fulfilled' && section.value.length > 0) out.push(...section.value);
  }
  return out;
}
