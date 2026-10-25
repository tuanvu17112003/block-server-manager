// L4: curated resolver — community seed (itzg, MIT) + hand overrides + learned entries.
// Port of the spike's core.mjs resolver; precedence proven live (12/12 packs).
import fs from 'node:fs';
import path from 'node:path';

interface OverrideEntry { match: string; server: string; unlessPresent?: string; why?: string }
interface ItzgFile { globalExcludes?: unknown[]; globalForceIncludes?: unknown[]; modpacks?: Record<string, { excludes?: unknown[]; forceIncludes?: unknown[] }> }

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function loadJsonIfExists(p: string): unknown {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export interface CuratedVerdict { env: string; why: string; protect: boolean }

export interface CuratedResolver {
  resolve(filePath: string, declared: string): CuratedVerdict;
  readonly protectBasenames: Set<string>;
}

export function makeCuratedResolver(opts: { platform: 'modrinth' | 'curseforge'; packSlug?: string | null; presentPaths: string[] }): CuratedResolver {
  const dataDir = path.join(__dirname, 'data');
  const itzg = (loadJsonIfExists(path.join(dataDir, opts.platform === 'curseforge' ? 'itzg-cf-exclude-include.json' : 'itzg-modrinth-exclude-include.json')) ?? {}) as ItzgFile;
  const hand = ((loadJsonIfExists(path.join(dataDir, 'env-overrides.json')) as { serverOverrides?: OverrideEntry[] })?.serverOverrides ?? []);
  const learned = ((loadJsonIfExists(path.join(dataDir, 'env-overrides-learned.json')) as { serverOverrides?: OverrideEntry[] })?.serverOverrides ?? []);
  const present = new Set(opts.presentPaths.map(norm));

  const entryTest = (entry: unknown, p: string): boolean => {
    const e = String(entry);
    if (e.startsWith('/') && e.endsWith('/') && e.length > 2) return new RegExp(e.slice(1, -1), 'i').test(p);
    const esc = e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|/)${esc}[-_.]`, 'i').test(p) || new RegExp(`(^|/)${esc}[.]jar$`, 'i').test(p);
  };

  const force = [...(itzg.globalForceIncludes ?? []), ...(opts.packSlug ? itzg.modpacks?.[opts.packSlug]?.forceIncludes ?? [] : [])];
  const excludes = [...(itzg.globalExcludes ?? []), ...(opts.packSlug ? itzg.modpacks?.[opts.packSlug]?.excludes ?? [] : [])];

  const resolve = (filePath: string, declared: string): CuratedVerdict => {
    const n = norm(filePath);
    const hitHand = hand.find(o => n.includes(norm(o.match))
      && (!o.unlessPresent || ![...present].some(p => p.includes(norm(o.unlessPresent ?? '')))));
    if (hitHand) return { env: hitHand.server, why: `hand-override: ${hitHand.match}`, protect: hitHand.server === 'required' };
    const hitLearned = learned.find(o => n.includes(norm(o.match)));
    if (hitLearned) return { env: hitLearned.server, why: `learned: ${hitLearned.why ?? ''}`, protect: false };
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

export function appendLearned(entries: { match: string; why: string }[]): void {
  if (!entries.length) return;
  const p = path.join(__dirname, 'data', 'env-overrides-learned.json');
  const cur = (loadJsonIfExists(p) as { serverOverrides?: OverrideEntry[] }) ?? { comment: 'AUTO-APPENDED by the auto-fix loop.', serverOverrides: [] };
  cur.serverOverrides = cur.serverOverrides ?? [];
  const seen = new Set(cur.serverOverrides.map(o => o.match));
  for (const e of entries) if (!seen.has(e.match)) { cur.serverOverrides.push({ match: e.match, server: 'unsupported', why: e.why }); seen.add(e.match); }
  fs.writeFileSync(p, JSON.stringify(cur, null, 2));
}
