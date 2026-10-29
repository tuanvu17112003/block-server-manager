// Adapter layer entry point: the registered adapters + helpers the pipeline uses.
//
// Registration order does not matter (the registry sorts by `priority` descending), but the priorities are the
// detection order derived in docs/research/2026-10-29-p1c-format-census.md Â§5: formats with machine-readable
// metadata first, payload-only archives last. `instance.json` is claimed by three formats, which is why every
// detector validates keys and the order is explicit rather than incidental.
import { fetchTrusted } from '../installer/core';
import type { AdapterIo } from './types';
import { AdapterRegistry } from './registry';
import { ftbAdapter, FTB_ALLOWED_HOSTS } from './ftb';
import { packwizAdapter } from './packwiz';
import { modrinthAdapter } from './modrinth';
import { prismAdapter } from './prism';
import { atlauncherAdapter } from './atlauncher';
import { serverZipAdapter } from './serverzip';

/** All adapters, highest priority first (the registry re-sorts defensively). */
export const ADAPTERS = [
  modrinthAdapter,     // 90 — highest: manifest carries per-file sides + full CDN URLs
  packwizAdapter,      // 60 â€” declarative, the only archive format with per-file side data
  prismAdapter,        // 55 â€” mmc-pack.json
  atlauncherAdapter,   // 50 â€” instance.json carrying a `launcher` object
  ftbAdapter,          // 45/20 â€” instance.json with numeric pack ids, or the provider API
  serverZipAdapter,    // 20 â€” no metadata at all, deliberately last
];

/** The shared registry instance used by the pipeline. */
export const adapterRegistry = new AdapterRegistry(ADAPTERS);

/**
 * Production `AdapterIo`: one allow-listed fetch helper so an adapter can never reach an arbitrary host,
 * and logging that flows into the installer log rather than stdout.
 */
export function createAdapterIo(log: (message: string) => void): AdapterIo {
  return {
    log,
    async fetchJson<T = unknown>(url: string, allowedHosts: readonly string[]): Promise<T> {
      const response = await fetchTrusted(url, allowedHosts, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`adapter fetch failed: HTTP ${response.status} for ${url}`);
      }
      return await response.json() as T;
    },
  };
}

export { AdapterRegistry, buildArchiveIndex } from './registry';
export { validateRecipe } from './registry';
export * from './types';
export {
  ftbAdapter, FTB_ALLOWED_HOSTS, buildFtbRecipe, ftbFileSide, parseFtbModLoader, pickFtbVersion, ftbJavaMajor,
  isFtbPrerelease, inferFtbLoaderFromFiles, resolveFtbDestPath, coerceJavaMajor, isMinecraftVersionString,
  APP_JAVA_MAJORS,
} from './ftb';
export { modrinthAdapter, mrpackFileSide, mrpackRuntime, buildMrpackRecipe, isMrpackIndex } from './modrinth';
export { packwizAdapter, isValidPackwizPack, isPackwizFormat, packwizFileSide, packwizLoader } from './packwiz';
export { prismAdapter, validateMmcPack, readMmcRuntime, MMC_FORMAT_VERSION, MMC_MINECRAFT_UID } from './prism';
export { atlauncherAdapter, readAtlInstance, readAtlLoader, readAtlMc } from './atlauncher';
export { serverZipAdapter, readServerZipEvidence, looksLikeServerZip } from './serverzip';
export { parseToml, tomlAt, tomlString, tomlTable, TomlParseError } from './toml';

