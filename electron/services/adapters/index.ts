// Adapter layer entry point: the registered adapters + helpers the pipeline uses.
//
// Phase P1 registers the FTB adapter first (the format this app could not open at all and the one that
// needs no API key). Subsequent phases add the remaining formats from
// docs/research/2026-10-29-universal-modpack-install.md §2 without touching the pipeline.
import { fetchTrusted } from '../installer/core';
import type { AdapterIo } from './types';
import { AdapterRegistry } from './registry';
import { ftbAdapter, FTB_ALLOWED_HOSTS } from './ftb';

/** All adapters, highest priority first (the registry re-sorts defensively). */
export const ADAPTERS = [ftbAdapter];

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
export { ftbAdapter, FTB_ALLOWED_HOSTS, buildFtbRecipe, ftbFileSide, parseFtbModLoader, pickFtbVersion, ftbJavaMajor } from './ftb';
