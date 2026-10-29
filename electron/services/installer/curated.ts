// L4: curated resolver — community seed (itzg, MIT) + hand overrides + learned entries.
// Port of the spike's core.mjs resolver; precedence proven live (12/12 packs).
import fs from 'node:fs';
import path from 'node:path';

interface OverrideEntry { match: string; server: string; unlessPresent?: string; why?: string }
interface ItzgFile { globalExcludes?: unknown[]; globalForceIncludes?: unknown[]; modpacks?: Record<string, { excludes?: unknown[]; forceIncludes?: unknown[] }> }

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Readable "words" of a path, for the loose matching the hand list has always needed.
 *
 * Jar names in real packs are decorated — `[异步粒子] AsyncParticles-20.1.3.2+1.20.1.jar`,
 * `[平滑转移] smoothswapping-…` — so the hand entries that exist precisely for those jars (`asyncparticles`,
 * `smoothswapping`) only ever matched the **normalized** path, where letters survive and punctuation does not.
 * Anchoring must not lose that: the words below are the normalized path split back into runs, so a match has to
 * cover a whole run instead of any substring of one. That is what stops `figura` matching `configurable`.
 */
const words = (s: string): string[] =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);

/**
 * Determine whether `entry` names the mod at `filePath` — anchored, never a bare substring.
 *
 * The itzg `figura`/`configurable` class of defect (itzg issue #4234: the deny pattern `figura` substring-matched
 * `configurable` and silently dropped a server-required mod across 24/24 paths, with no log line) is what this
 * function exists to make impossible. Two forms, both anchored:
 *
 *   - `/regex/` — used verbatim, exactly as {@link entryTest} and the itzg data already do;
 *   - a plain name — must equal a whole word of the path, or a word with a version suffix (`sodium-0.5.1`,
 *     `figura1.0`), or the whole normalized path (`Cull Less Leaves`, which has no single word to equal).
 *
 * A prefix-either-way comparison is deliberately *not* used: it would let `figura` match `figurafix`, which is a
 * different mod and exactly the over-match this rule removes.
 */
function entryMatches(entry: string, filePath: string): boolean {
  const e = String(entry).trim();
  if (e === '') return false;
  if (e.startsWith('/') && e.endsWith('/') && e.length > 2) return new RegExp(e.slice(1, -1), 'i').test(filePath);
  const target = norm(e);
  if (target === '') return false;
  if (norm(filePath) === target) return true;
  return words(filePath).some((word) => {
    if (word === target) return true;
    if (!word.startsWith(target)) return false;
    // A version or build suffix is not part of the name; a further letter is (`figurafix`, `figurama`).
    return !/[a-z]/.test(word.slice(target.length));
  });
}

function loadJsonIfExists(p: string): unknown {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export interface CuratedVerdict { env: string; why: string; protect: boolean }

export interface CuratedResolver {
  resolve(filePath: string, declared: string): CuratedVerdict;
  readonly protectBasenames: Set<string>;
}

export function makeCuratedResolver(opts: { platform: 'modrinth' | 'curseforge'; packSlug?: string | null; presentPaths: string[]; learnedFile?: string }): CuratedResolver {
  const dataDir = path.join(__dirname, 'data');
  const itzg = (loadJsonIfExists(path.join(dataDir, opts.platform === 'curseforge' ? 'itzg-cf-exclude-include.json' : 'itzg-modrinth-exclude-include.json')) ?? {}) as ItzgFile;
  const hand = ((loadJsonIfExists(path.join(dataDir, 'env-overrides.json')) as { serverOverrides?: OverrideEntry[] })?.serverOverrides ?? []);
  const bundledLearned = ((loadJsonIfExists(path.join(dataDir, 'env-overrides-learned.json')) as { serverOverrides?: OverrideEntry[] })?.serverOverrides ?? []);
  const runtimeLearned = (opts.learnedFile
    ? ((loadJsonIfExists(opts.learnedFile) as { serverOverrides?: OverrideEntry[] })?.serverOverrides ?? [])
    : []);
  const learned = [...bundledLearned, ...runtimeLearned];

  const entryTest = (entry: unknown, p: string): boolean => {
    const e = String(entry);
    if (e.startsWith('/') && e.endsWith('/') && e.length > 2) return new RegExp(e.slice(1, -1), 'i').test(p);
    const esc = e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|/)${esc}[-_.]`, 'i').test(p) || new RegExp(`(^|/)${esc}[.]jar$`, 'i').test(p);
  };

  const force = [...(itzg.globalForceIncludes ?? []), ...(opts.packSlug ? itzg.modpacks?.[opts.packSlug]?.forceIncludes ?? [] : [])];
  const excludes = [...(itzg.globalExcludes ?? []), ...(opts.packSlug ? itzg.modpacks?.[opts.packSlug]?.excludes ?? [] : [])];

  const resolve = (filePath: string, declared: string): CuratedVerdict => {
    // The hand and learned lists match through `entryMatches`, anchored exactly like the itzg `entryTest`
    // above (research §7 gap 5). They previously used bare `n.includes(norm(o.match))`, which is the
    // `figura`/`configurable` over-exclusion class: a hand or learned entry can silently drop a different mod.
    //
    // `unlessPresent` guards ("chipped breaks only when athena is absent") are resolved against the RAW pack
    // paths, never the normalized ones: normalized text has every separator stripped, so its `[-_.]` boundaries
    // can never match and every guard silently evaluates to "not present".
    const hitHand = hand.find(o => entryMatches(o.match, filePath)
      && (!o.unlessPresent || !opts.presentPaths.some(p => entryMatches(o.unlessPresent ?? '', p))));
    if (hitHand) {
      // Every verdict names the rule that produced it, so an exclusion is auditable and revocable.
      return { env: hitHand.server, why: `hand-override[${hitHand.match}]`, protect: hitHand.server === 'required' };
    }
    // The learned list has no `unlessPresent` concept — a learned entry is unconditional by construction.
    const hitLearned = learned.find(o => entryMatches(o.match, filePath));
    if (hitLearned) return { env: hitLearned.server, why: `learned[${hitLearned.match}] ${hitLearned.why ?? ''}`.trim(), protect: false };
    const hitForce = force.find(e => entryTest(e, filePath));
    if (hitForce !== undefined) return { env: 'required', why: `community force-include: ${String(hitForce)}`, protect: true };
    const hitEx = excludes.find(e => entryTest(e, filePath));
    if (hitEx !== undefined) return { env: 'unsupported', why: `community exclude: ${String(hitEx)}`, protect: false };
    return { env: declared, why: 'declared', protect: false };
  };

  const protectBasenames = new Set<string>();
  for (const p of opts.presentPaths) if (resolve(p, 'required').protect) protectBasenames.add(path.basename(p));

  return { resolve, protectBasenames };
}

export function appendLearned(entries: { match: string; why: string }[], learnedFile?: string): void {
  if (!entries.length) return;
  // Runtime learning must never write into the (possibly read-only) app directory: the server
  // process passes a data-root path; the bundled path is only used by tooling/tests.
  const p = learnedFile ?? path.join(__dirname, 'data', 'env-overrides-learned.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const cur = (loadJsonIfExists(p) as { serverOverrides?: OverrideEntry[] }) ?? { comment: 'AUTO-APPENDED by the auto-fix loop.', serverOverrides: [] };
  cur.serverOverrides = cur.serverOverrides ?? [];
  const seen = new Set(cur.serverOverrides.map(o => o.match));
  for (const e of entries) if (!seen.has(e.match)) { cur.serverOverrides.push({ match: e.match, server: 'unsupported', why: e.why }); seen.add(e.match); }
  fs.writeFileSync(p, JSON.stringify(cur, null, 2));
}
