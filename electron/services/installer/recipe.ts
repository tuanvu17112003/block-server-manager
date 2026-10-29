// Install a canonical `PackRecipe` into a staging directory.
//
// This is the format-agnostic half of P1b: once an adapter has produced a recipe, every format installs
// through this one function. The rules it enforces are the ones the research identified as generic:
//  - the loader is installed from the recipe's exact loader + version (never from a filename),
//  - files whose side resolves to `unsupported` are skipped and counted, never silently dropped,
//  - `optional` files are installed by default and can be excluded by the reviewed plan,
//  - `unknown` is treated as a server candidate (the L2/L3 boot layers decide later),
//  - downloads are hash/size verified with ordered URL failover (mirrors included),
//  - manager-owned state (eula.properties.ops...) is never written by a pack.
import fs from 'node:fs';
import path from 'node:path';
import { appError } from '../store';
import { downloadFirstAvailable, installLoader, log, type DownloadCandidate } from './core';
import type { PackRecipe, PlannedFile } from '../adapters/types';
import { MANAGER_OWNED_PATHS, isSafeRelativePath } from '../adapters/types';

export interface InstallRecipeOpts {
  recipe: PackRecipe;
  dir: string;
  javaExe: string;
  cacheDir: string;
  /** Reviewed-plan exclusions (exact recipe paths). Wins over every other signal. */
  excludeFiles?: Set<string>;
  /** Reviewed-plan force-includes for optional files that would otherwise be skipped. */
  includeFiles?: Set<string>;
  onProgress?: (event: { stage: string; pct?: number }) => void;
  signal?: AbortSignal;
}

export interface InstallRecipeResult {
  installed: number;
  skippedUnsupported: number;
  skippedOptional: number;
  skippedUserExcluded: number;
  warnings: string[];
}

/** Which planned files a server install will actually fetch, given the reviewed plan. */
export function planRecipeFiles(
  recipe: PackRecipe,
  opts: { excludeFiles?: Set<string>; includeFiles?: Set<string> } = {},
): { install: PlannedFile[]; skippedUnsupported: number; skippedOptional: number; skippedUserExcluded: number } {
  const exclude = opts.excludeFiles ?? new Set<string>();
  const include = opts.includeFiles ?? new Set<string>();
  const install: PlannedFile[] = [];
  let skippedUnsupported = 0;
  let skippedOptional = 0;
  let skippedUserExcluded = 0;

  for (const file of recipe.files) {
    // A pack must never own manager state, whatever the adapter claims.
    if (MANAGER_OWNED_PATHS.includes(file.path.toLowerCase())) continue;
    if (exclude.has(file.path)) { skippedUserExcluded += 1; continue; }
    if (file.side === 'unsupported') { skippedUnsupported += 1; continue; }
    if (file.side === 'optional' && !include.has(file.path)) { skippedOptional += 1; continue; }
    // `required` and `unknown` both install; boot verification is what separates them later.
    install.push(file);
  }
  return { install, skippedUnsupported, skippedOptional, skippedUserExcluded };
}

/** Download one planned file into the staging tree, verifying every hash the recipe carries. */
async function fetchPlannedFile(
  file: PlannedFile,
  dir: string,
  cacheDir: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const dest = path.join(dir, file.path);
  if (!isSafeRelativePath(file.path)) throw appError('validation', `Unsafe recipe path "${file.path}".`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const candidates: DownloadCandidate[] = (file.source.urls ?? []).map(url => ({
    url,
    ...(file.sha1 ? { sha1: file.sha1 } : {}),
    ...(file.sha512 ? { sha512: file.sha512 } : {}),
    ...(typeof file.size === 'number' && file.size > 0 ? { size: file.size } : {}),
  }));
  if (candidates.length === 0) {
    throw appError('validation', `Recipe file "${file.path}" has no download URL.`);
  }
  await downloadFirstAvailable(candidates, { dest, signal });

  // A downloaded jar that is actually an HTML error page is the classic silent poison. But a *declared*
  // zero-byte file is legitimate: empty config files exist in real packs (e.g. FTB Stoneblock 2 ships
  // three of them, each with the SHA-1 of the empty string `da39a3ee…`). Only reject an empty result when
  // the recipe said it should have bytes; the hash verification above already catches content lies.
  const stat = fs.statSync(dest);
  const expectsBytes = typeof file.size === 'number' && file.size > 0;
  if (stat.size === 0 && expectsBytes) {
    throw appError('io', `Downloaded an empty file for "${file.path}" (expected ${file.size} bytes).`);
  }
  if (expectsBytes && stat.size !== file.size) {
    throw appError('io', `Size mismatch for "${file.path}": expected ${file.size}, got ${stat.size}.`);
  }
  void cacheDir;
}

/** Install a recipe: loader first (so the tree is bootable), then every planned file. */
export async function installRecipe(opts: InstallRecipeOpts): Promise<InstallRecipeResult> {
  const { recipe, dir, javaExe, cacheDir, signal } = opts;
  const warnings: string[] = [];
  const onProgress = opts.onProgress ?? (() => {});

  if (!dir || dir.trim() === '') throw appError('validation', 'Install directory is required.');
  fs.mkdirSync(dir, { recursive: true });

  // ---- loader: exact family + version from the recipe, never inferred from a file name ----
  onProgress({ stage: `installing ${recipe.loader}${recipe.loaderVersion ? ` ${recipe.loaderVersion}` : ''}`, pct: 5 });
  if (recipe.loader !== 'vanilla') {
    await installLoader(
      recipe.loader as never,
      dir,
      recipe.mc,
      recipe.loaderVersion,
      javaExe,
      cacheDir,
      signal ? { signal } : {},
    );
    log(`[recipe] loader ${recipe.loader} ${recipe.loaderVersion ?? '(latest)'} installed for MC ${recipe.mc}`);
  } else {
    log('[recipe] vanilla pack: no loader to install');
  }

  // ---- payload ----
  const plan = planRecipeFiles(recipe, {
    ...(opts.excludeFiles ? { excludeFiles: opts.excludeFiles } : {}),
    ...(opts.includeFiles ? { includeFiles: opts.includeFiles } : {}),
  });

  let installed = 0;
  const total = plan.install.length;
  for (const file of plan.install) {
    if (signal?.aborted) throw appError('cancelled', 'Install cancelled.');
    await fetchPlannedFile(file, dir, cacheDir, signal);
    installed += 1;
    if (installed % 25 === 0 || installed === total) {
      onProgress({ stage: `downloading files ${installed}/${total}`, pct: 10 + Math.round((installed / Math.max(total, 1)) * 80) });
    }
  }

  if (plan.skippedUnsupported > 0) warnings.push(`${plan.skippedUnsupported} client-only files skipped (declared server-unsupported)`);
  if (plan.skippedOptional > 0) warnings.push(`${plan.skippedOptional} optional files skipped`);
  if (plan.skippedUserExcluded > 0) warnings.push(`${plan.skippedUserExcluded} files excluded by the reviewed plan`);

  return {
    installed,
    skippedUnsupported: plan.skippedUnsupported,
    skippedOptional: plan.skippedOptional,
    skippedUserExcluded: plan.skippedUserExcluded,
    warnings,
  };
}
