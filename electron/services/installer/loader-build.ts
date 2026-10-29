// Loader-build resolution: which exact loader build to install, and what to do when boot says it is wrong.
//
// Research context (docs/research/2026-10-29-universal-modpack-install.md §4 and §10): a pack's manifest is
// the authority on *which* loader family it needs, but it is frequently silent on the exact **build**. The
// three surveyed implementations answer this differently:
//   - itzg: no Java/loader gate at all; the helper installs what metadata says and fails at runtime.
//   - ServerPackCreator: generated start script downloads the loader, and the **console decides** — a boot
//     failure is classified by an ordered rule ladder before any conclusion is drawn.
//   - mrpack-install: pins a ServerStarterJar so the generated argfiles are honoured.
//
// The rule adopted here follows SPC's philosophy but keeps it bounded and evidence-driven:
//   1. A build the pack *declares* is authoritative and is never overridden or escalated.
//   2. When no build is declared, resolve candidates from the provider's own promotion feed, preferring
//      `recommended` over `latest` (a "latest" Forge build is frequently a regression for old packs).
//   3. Only when (2) applies AND the boot failed with a *loader-level* signature may a further candidate be
//      tried, with a hard budget. A mod-level crash must never trigger escalation — that would hide a real
//      pack defect behind a loader change.
import { appError } from '../store';
import { log } from './core';

/** Loader families whose build can be escalated when the pack does not declare one. */
const ESCALATABLE: ReadonlySet<string> = new Set(['forge', 'neoforge']);

/**
 * Boot-failure signatures that mean "the loader itself did not start", as opposed to "the loader started and
 * a mod broke". Only these may escalate a loader build.
 *
 * These strings are taken from real captured output (see docs/evidence/adapters and doc 16): the FTB Omnia
 * failure produced `MixinTransformationService` / `TransformationServicesHandler`, and the researched itzg
 * issues report `Could not find main class cpw.mods.bootstraplauncher.BootstrapLauncher`.
 */
const LOADER_LEVEL_SIGNATURES: readonly { rule: string; pattern: RegExp }[] = [
  { rule: 'loader.bootstrap-missing', pattern: /could not find main class\s+cpw\.mods\.bootstraplauncher/i },
  { rule: 'loader.modlauncher-init', pattern: /TransformationServicesHandler|TransformationServiceDecorator/i },
  { rule: 'loader.mixin-service-init', pattern: /MixinTransformationService|MixinLaunchPlugin/i },
  { rule: 'loader.module-path', pattern: /module-path|\bmodule not found\b|Unrecognized option: *--module/i },
  { rule: 'loader.class-version', pattern: /UnsupportedClassVersionError|class file version|has been compiled by a more recent version/i },
  { rule: 'loader.legacy-classpath', pattern: /legacyClassPath/i },
  { rule: 'loader.argfile', pattern: /@(unix|win)_args\.txt|could not open .*_args\.txt/i },
  { rule: 'loader.installer-incomplete', pattern: /libraries\\|libraries\/.*(missing|not found)/i },
];

/**
 * Signatures that mean the loader is fine and a *mod* (or the pack) is broken. These veto escalation even if a
 * loader-level signature also appears, because a mixin crash is frequently reported through loader frames.
 */
const MOD_LEVEL_SIGNATURES: readonly { rule: string; pattern: RegExp }[] = [
  { rule: 'mod.missing-dependency', pattern: /Missing or unsupported mandatory dependencies|MissingModsException|requires .* which is missing/i },
  { rule: 'mod.mixin-apply', pattern: /Mixin apply failed|MixinApplyError|mixin.*\.json.*(failed|error)/i },
  { rule: 'mod.duplicate', pattern: /Duplicate mods found|duplicate mod/i },
  { rule: 'mod.crash-report', pattern: /---- Minecraft Crash Report ----/i },
  { rule: 'mod.registry', pattern: /Registry (Object|remap)|Failed to create registry entry/i },
];

export type BootFailureClass =
  | { kind: 'loader'; rule: string }
  | { kind: 'mod'; rule: string }
  | { kind: 'unknown' };

/**
 * Classify a boot failure from its console tail.
 *
 * Mod-level evidence wins over loader-level evidence: a mod crash routinely prints loader/mixin service frames,
 * so treating those frames alone as a loader problem would escalate a build for a pack that is simply broken.
 */
export function classifyBootFailure(tail: readonly string[]): BootFailureClass {
  const text = tail.join('\n');
  if (text.trim() === '') return { kind: 'unknown' };
  for (const signature of MOD_LEVEL_SIGNATURES) {
    if (signature.pattern.test(text)) return { kind: 'mod', rule: signature.rule };
  }
  for (const signature of LOADER_LEVEL_SIGNATURES) {
    if (signature.pattern.test(text)) return { kind: 'loader', rule: signature.rule };
  }
  return { kind: 'unknown' };
}

export interface LoaderBuildPlan {
  /** Builds to try, in order. Always at least one for a resolvable loader. */
  candidates: string[];
  /** Where the primary candidate came from, for the report. */
  source: 'declared' | 'provider-recommended' | 'provider-latest' | 'resolved';
  /** True when the pack itself declared the build, so escalation is forbidden. */
  declared: boolean;
  /** Extra boot attempts allowed. Zero when the pack declared its build. */
  maxEscalations: number;
}

/** Promotion-feed shape shared by Forge and NeoForge. */
interface Promotions { promos?: Record<string, string> }

/**
 * Build the ordered candidate list for a loader.
 *
 * `fetchPromotions` is injected so this stays pure and unit-testable. `provider` picks the feed; the ordering
 * rule is the same for both: recommended first, then latest, then any remaining builds we know of.
 */
export function planLoaderBuilds(input: {
  loader: string;
  mc: string;
  declaredVersion: string | null;
  promotions: Promotions | null;
  /** Hard cap on total candidates, including the primary. Default 3. */
  maxCandidates?: number;
}): LoaderBuildPlan {
  const declared = (input.declaredVersion ?? '').trim();
  if (declared !== '') {
    return { candidates: [declared], source: 'declared', declared: true, maxEscalations: 0 };
  }

  const promos = input.promotions?.promos ?? {};
  const recommended = promos[`${input.mc}-recommended`]?.trim();
  const latest = promos[`${input.mc}-latest`]?.trim();
  const ordered = [recommended, latest].filter((value): value is string => Boolean(value && value !== ''));

  if (ordered.length === 0) {
    // No declared build and no provider answer: this is unresolvable, not something a boot loop can fix.
    throw appError('validation',
      `${input.loader} publishes no build for Minecraft ${input.mc}, and the pack does not declare one.`);
  }
  const unique = [...new Set(ordered)].slice(0, Math.max(1, input.maxCandidates ?? 3));
  const escalated = ESCALATABLE.has(input.loader) ? unique.length - 1 : 0;
  return {
    candidates: unique,
    source: recommended ? 'provider-recommended' : 'provider-latest',
    declared: false,
    maxEscalations: escalated,
  };
}

/**
 * Decide whether the next boot attempt should use the next loader build.
 * Returns the build to try, or null when the failure is not escalatable.
 */
export function nextLoaderBuild(
  plan: LoaderBuildPlan,
  attempt: number,
  failure: BootFailureClass,
): { build: string; rule: string } | null {
  if (plan.declared) return null;
  if (failure.kind !== 'loader') return null;
  if (attempt >= plan.maxEscalations) return null;
  const build = plan.candidates[attempt + 1];
  return build ? { build, rule: failure.rule } : null;
}

/** Human-readable explanation for the report when escalation is refused. */
export function explainNoEscalation(plan: LoaderBuildPlan, failure: BootFailureClass): string {
  if (plan.declared) return 'the pack declares this exact loader build, so it is authoritative and never overridden';
  if (failure.kind === 'mod') return `a mod failed (${failure.rule}), which a loader change cannot fix`;
  if (failure.kind === 'unknown') return 'the failure does not identify the loader as the cause';
  return 'no further loader builds are available for this Minecraft version';
}

/** Log one escalation decision. Kept separate so the message stays consistent across callers. */
export function logEscalation(from: string, to: string, rule: string, attempt: number, max: number): void {
  log(`[loader] boot failed at the loader level (${rule}); escalating build ${from} -> ${to} `
    + `(attempt ${attempt + 1}/${max})`);
}
