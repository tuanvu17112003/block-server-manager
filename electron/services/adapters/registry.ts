// Archive index + adapter registry.
//
// One zip listing per input, shared by every adapter — adapters never touch the filesystem or yauzl
// directly, which keeps them pure and unit-testable from fixtures.
import { listZip, readZipEntry } from '../installer/core';
import { appError } from '../store';
import type { ArchiveEntry, ArchiveIndex, DetectContext, PackAdapter, PackFormatId, PackRecipe, AdapterIo } from './types';
import { isSafeRelativePath, normalizePath } from './types';
import { isMinecraftVersionString } from './ftb';

/** Build an `ArchiveIndex` from a zip on disk (one listing, memoized reads). */
export async function buildArchiveIndex(zipPath: string): Promise<ArchiveIndex> {
  const raw = await listZip(zipPath);
  const entries: ArchiveEntry[] = raw.map((entry) => ({
    name: entry.name.replaceAll('\\', '/'),
    size: entry.size,
    isDir: entry.isDir,
  }));
  const byName = new Map<string, ArchiveEntry>();
  for (const entry of entries) byName.set(entry.name, entry);
  const cache = new Map<string, string | null>();

  const readText = async (name: string): Promise<string | null> => {
    const key = `t:${name}`;
    if (cache.has(key)) return cache.get(key) ?? null;
    let text: string | null = null;
    try {
      const buffer = await readZipEntry(zipPath, name);
      text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    } catch {
      text = null;
    }
    cache.set(key, text);
    return text;
  };

  return {
    entries,
    names: new Set(entries.map((entry) => entry.name)),
    readText,
    async readJson<T = unknown>(name: string): Promise<T | null> {
      const text = await readText(name);
      if (text === null) return null;
      try {
        return JSON.parse(text) as T;
      } catch {
        return null;
      }
    },
    under(prefix: string): string[] {
      const normalized = normalizePath(prefix);
      return entries
        .filter((entry) => !entry.isDir && normalizePath(entry.name).startsWith(normalized))
        .map((entry) => entry.name);
    },
  };
}

/**
 * Registry: adapters are evaluated by descending priority and the first **validated** match wins.
 * Providers that need an API call are resolved by the caller, not here, so detection stays cheap.
 */
export class AdapterRegistry {
  private readonly adapters: PackAdapter[] = [];

  constructor(adapters: PackAdapter[]) {
    this.adapters = [...adapters].sort((a, b) => b.priority - a.priority);
  }

  list(): readonly PackAdapter[] {
    return this.adapters;
  }

  get(id: PackFormatId): PackAdapter {
    const found = this.adapters.find((adapter) => adapter.id === id);
    if (!found) throw appError('validation', `No pack adapter registered for format "${id}".`);
    return found;
  }

  /** Which adapters claim this input, in evaluation order. Useful for diagnostics and tests. */
  async candidates(ctx: DetectContext): Promise<PackAdapter[]> {
    const matched: PackAdapter[] = [];
    for (const adapter of this.adapters) {
      try {
        if (await adapter.detect(ctx)) matched.push(adapter);
      } catch {
        // A throwing detector must never break detection of other formats.
      }
    }
    return matched;
  }

  /**
   * Detect and resolve in one step. Fails closed with a precise message listing what was checked,
   * so an unsupported archive is never reported as "unknown pack" with no evidence.
   */
  async resolve(ctx: DetectContext, io: AdapterIo): Promise<PackRecipe> {
    const matched = await this.candidates(ctx);
    if (matched.length === 0) {
      const evidence = ctx.archive
        ? `checked ${ctx.archive.entries.length} entries; root files: ${rootEvidence(ctx.archive)}`
        : 'no archive or provider metadata supplied';
      throw appError('validation', `Unrecognized modpack format (${evidence}).`);
    }
    const adapter = matched[0]!;
    const recipe = await adapter.resolve(ctx, io);
    validateRecipe(recipe);
    return recipe;
  }
}

/** Root entries that drive format detection, for the failure message. */
function rootEvidence(archive: ArchiveIndex): string {
  const root = archive.entries
    .filter((entry) => !entry.isDir && !entry.name.includes('/'))
    .map((entry) => entry.name)
    .slice(0, 8);
  return root.length > 0 ? root.join(', ') : '(none)';
}

/**
 * Structural validation every recipe must satisfy before the pipeline will touch disk. This is the
 * contract that makes adapters interchangeable: a broken adapter fails here, not mid-install.
 */
export function validateRecipe(recipe: PackRecipe): void {
  if (recipe.name.trim() === '') throw appError('validation', `Adapter ${recipe.formatId} produced an empty pack name.`);
  if (!recipe.mc.trim()) {
    throw appError('validation',
      `Adapter ${recipe.formatId} could not determine the Minecraft version. Refusing to guess a runtime.`);
  }
  // Snapshot / pre-release / alpha names are legitimate Minecraft versions (the FTB corpus contains
  // `18w43b`, `26.3-pre-1`, `26.4-snapshot-6`, `rd-132211`), so the check accepts them rather than requiring
  // a bare `x.y[.z]` and refusing real packs.
  if (!isMinecraftVersionString(recipe.mc)) {
    throw appError('validation', `Adapter ${recipe.formatId} produced an invalid Minecraft version "${recipe.mc}".`);
  }
  if (recipe.loader === 'hybrid') {
    throw appError('validation', `Adapter ${recipe.formatId}: hybrid loaders are not supported for new installs.`);
  }
  for (const file of recipe.files) {
    if (!isSafeRelativePath(file.path)) {
      throw appError('validation', `Adapter ${recipe.formatId} produced an unsafe path "${file.path}".`);
    }
    const hasUrls = (file.source.urls?.length ?? 0) > 0;
    if (!hasUrls && !file.source.provider) {
      throw appError('validation', `Adapter ${recipe.formatId}: file "${file.path}" has no download source.`);
    }
  }
  const clientLayer = recipe.overrides.find((layer) => normalizePath(layer.prefix).startsWith('client-overrides'));
  if (clientLayer) {
    throw appError('validation', `Adapter ${recipe.formatId} tried to apply client-overrides to a server install.`);
  }
}
