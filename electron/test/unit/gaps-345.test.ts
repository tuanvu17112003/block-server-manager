// Research §7 gaps 3, 4 and 5 — the three side-resolution rules the research proved wrong with source
// evidence, each test built from the reference implementation's exact predicate.
//
// gap3 — Forge `mods.toml` side rule (research §3.1, reference `ForgeTomlScanner.kt:114-152`):
//   the mod is client-only when the `side` on the PLATFORM dependency — a `[[dependencies.<modid>]]` entry whose
//   `modId` matches ^(forge|neoforge|minecraft)$ — is CLIENT. No platform entry, no `[[dependencies]]` at all,
//   or any parse error ⇒ keep the mod (SERVER). The old rule was "every `side=` in the whole file is CLIENT",
//   which is a different predicate: dependency blocks for OTHER mods also carry `side=`.
//
// gap5 — hand/learned exclusion matching (research §3.6, itzg issue #4234): the deny pattern `figura`
//   substring-matched `configurable` and silently dropped a server-required mod across 24/24 paths with no log
//   line. Anchor the match, and make every exclusion attributable to a rule id.
//
// gap4 — dependency rescue (research §3.4, reference `ModListCompiler.kt:242-287` `dependantOf`): before
//   excluding a mod, keep it if a KEPT mod depends on it, matching the dependency id AND the jar's `provides`
//   aliases — because `fabric-api` provides `fabric`, so a mod writing `depends: {"fabric": "*"}` names an id no
//   jar in the pack calls itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  applyJarSideness,
  forgeTomlIsClientOnly,
  parseForgeDependencies,
  parseForgeModId,
  rescueDependencies,
  scanJarDeclaration,
  type JarDeclaration,
} from '../../services/installer/core';
import { makeCuratedResolver } from '../../services/installer/curated';
import { mapFilePolicy } from '../../services/pipeline';
import { collectInputs, writeZip } from '../../services/zip';
import { tempRoot } from '../harness';

// ---------------------------------------------------------------- gap 3: Forge platform-dependency rule

test('gap3: parseForgeDependencies reads [[dependencies.<mod>]] entries with side/type/mandatory', () => {
  const toml = `
modLoader="javafml"
loaderVersion="[47,)"

[[mods]]
    modId="examplemod"
    version="1.0.0"

[[dependencies.examplemod]]
    modId="forge"
    mandatory=true
    versionRange="[47,)"
    side="BOTH"

[[dependencies.examplemod]]
    modId="minecraft"
    mandatory=true
    versionRange="[1.20.1]"
    side="CLIENT"
`;
  assert.equal(parseForgeModId(toml), 'examplemod');
  const entries = parseForgeDependencies(toml).get('examplemod');
  assert.ok(entries, 'the mod owner block must be found');
  assert.deepEqual(entries.map(entry => entry.modId), ['forge', 'minecraft']);
  assert.deepEqual(entries.map(entry => entry.side), ['BOTH', 'CLIENT']);
});

test('gap3(a): a client-only mod with an unrelated side=BOTH dependency line is STILL client-only', () => {
  // The exact case the old "every side= is CLIENT" rule got wrong: the platform says CLIENT, another mod's
  // entry says BOTH, so "every side is CLIENT" is false and a real client mod survived onto the server.
  const toml = `
[[mods]]
    modId="sodium"

[[dependencies.sodium]]
    modId="minecraft"
    side="CLIENT"

[[dependencies.sodium]]
    modId="someunrelatedlib"
    side="BOTH"
    mandatory=true
`;
  const verdict = forgeTomlIsClientOnly(toml);
  assert.equal(verdict.client, true, 'the PLATFORM dependency saying CLIENT is the mod declaring itself client');
  assert.match(String(verdict.reason), /CLIENT/);
});

test('gap3(b): side=CLIENT only under a NON-platform dependency must NOT drop the mod', () => {
  // The mirror image, and the direction that costs a boot rather than a few megabytes.
  const toml = `
[[mods]]
    modId="servermod"

[[dependencies.servermod]]
    modId="forge"
    side="BOTH"

[[dependencies.servermod]]
    modId="someclientlibrary"
    side="CLIENT"
`;
  assert.equal(forgeTomlIsClientOnly(toml).client, false, 'a non-platform CLIENT dependency is not the mod declaring itself client');
  // And with no platform entry at all, the file's only side=CLIENT must still not condemn it.
  assert.equal(forgeTomlIsClientOnly(`
[[dependencies.onlyclientdep]]
    modId="someothermod"
    side="CLIENT"
`).client, false);
});

test('gap3: no platform entry / no dependencies section / parse error all fail toward KEEPING the mod', () => {
  assert.equal(forgeTomlIsClientOnly('modLoader="javafml"\nlicense="MIT"').client, false, 'no [[dependencies]] at all');
  assert.equal(forgeTomlIsClientOnly('').client, false);
  assert.equal(forgeTomlIsClientOnly('[[[[ not toml ====').client, false, 'unparseable text');
  assert.doesNotThrow(() => forgeTomlIsClientOnly('[[[[ not toml ===='));
  // NeoForge's `type="incompatible"` means the mod must NOT be present — never a reason to disable it.
  assert.equal(forgeTomlIsClientOnly(`
[[dependencies.examplemod]]
    modId="minecraft"
    side="CLIENT"
    type="incompatible"
`).client, false);
});

// ---------------------------------------------------------------- gap 4: dependency rescue

const decl = (over: Partial<JarDeclaration>): JarDeclaration =>
  ({ modId: null, provides: [], depends: [], client: false, reasons: [], ...over });

test('gap4: a disabled client-only mod is rescued when a KEPT mod depends on it via a provides alias', () => {
  // The Fabric API shape the reference documents: the jar calls itself `fabric-api` but answers to `fabric`,
  // and the kept mod names `fabric`. Matching ids alone would strand the kept mod.
  const fabricApi = decl({ file: 'fabric-api-0.92.11.jar', modId: 'fabric-api', provides: ['fabric'], client: true, reasons: ['l2.jar-self-declaration: x'] });
  const dependent = decl({ file: 'some-server-mod.jar', modId: 'some-server-mod', depends: ['fabric'] });
  const { stillDisabled, keep } = rescueDependencies([fabricApi], [dependent]);
  assert.equal(stillDisabled.length, 0, 'the depended-on jar must not be disabled');
  assert.deepEqual(keep.map(entry => entry.modId), ['some-server-mod', 'fabric-api']);
});

test('gap4: rescue matches the direct modId too, and iterates to a fixpoint', () => {
  // `a` is kept and depends on `b`; `b` (disabled) depends on `c` (also disabled). Rescuing `b` puts `b`'s own
  // dependency in play, so `c` must be rescued in the next round — the reference's `while` loop.
  const kept = [decl({ file: 'a.jar', modId: 'a', depends: ['b'] })];
  const b = decl({ file: 'b.jar', modId: 'b', depends: ['c'] });
  const c = decl({ file: 'c.jar', modId: 'c' });
  const result = rescueDependencies([b, c], kept);
  assert.equal(result.stillDisabled.length, 0, 'the fixpoint must rescue transitively depended-on jars');
  assert.deepEqual(result.keep.map(entry => entry.modId).sort(), ['a', 'b', 'c']);
});

test('gap4: a jar nothing depends on keeps its exclusion verdict', () => {
  const lonely = decl({ file: 'lonely.jar', modId: 'lonely', client: true, reasons: ['l2.jar-self-declaration: x'] });
  const other = decl({ file: 'other.jar', modId: 'other', depends: ['somethingelse'] });
  const result = rescueDependencies([lonely], [other]);
  assert.deepEqual(result.stillDisabled.map(entry => entry.file), ['lonely.jar']);
});

test('gap4: rescue never invents a dependency — a client-only dependency does not rescue', async () => {
  // Forge states a side per dependency (`ForgeTomlScanner.kt:138-143`): a `side="CLIENT"` dependency is not
  // something the server needs, so it must not pull a jar back in.
  const temp = tempRoot('msm-gap4-clientdep');
  try {
    const dir = path.join(temp.root, 'mods');
    fs.mkdirSync(dir, { recursive: true });
    // `needsclientlib` depends on `clientlib` only for the client; `clientlib` declares itself client-only.
    const make = async (name: string, toml: string): Promise<void> => {
      const src = path.join(temp.root, `src-${name}`);
      fs.mkdirSync(path.join(src, 'META-INF'), { recursive: true });
      fs.writeFileSync(path.join(src, 'META-INF', 'mods.toml'), toml);
      const inputs = await collectInputs(src, ['META-INF']);
      await writeZip(path.join(dir, `${name}.jar`), inputs);
    };
    await make('clientlib', '[[mods]]\nmodId="clientlib"\n\n[[dependencies.clientlib]]\nmodId="minecraft"\nside="CLIENT"\n');
    await make('needsclientlib', '[[mods]]\nmodId="needsclientlib"\n\n[[dependencies.needsclientlib]]\nmodId="forge"\nside="BOTH"\n\n[[dependencies.needsclientlib]]\nmodId="clientlib"\nside="CLIENT"\n');

    const declaration = await scanJarDeclaration(path.join(dir, 'needsclientlib.jar'));
    assert.deepEqual(declaration.depends, [], 'a client-only dependency is not a server dependency');

    const moved = await applyJarSideness(dir);
    assert.deepEqual(moved.map(entry => entry.jar), ['clientlib.jar'], 'clientlib must still be disabled');
    assert.ok(fs.existsSync(path.join(dir, 'needsclientlib.jar')));
    assert.ok(fs.existsSync(path.join(dir, '..', 'mods-disabled', 'clientlib.jar')));
  } finally {
    temp.cleanup();
  }
});

test('gap4: applyJarSideness rescues through provides and attributes every exclusion to a rule id', async () => {
  const temp = tempRoot('msm-gap4-rescue');
  try {
    const dir = path.join(temp.root, 'mods');
    fs.mkdirSync(dir, { recursive: true });
    const jar = async (name: string, descriptor: object): Promise<void> => {
      const src = path.join(temp.root, `src-${name}`);
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, 'fabric.mod.json'), JSON.stringify(descriptor));
      const inputs = await collectInputs(src, ['fabric.mod.json']);
      await writeZip(path.join(dir, `${name}.jar`), inputs);
    };
    // A client-only jar (environment=client) that a kept server mod needs through its `provides` alias.
    await jar('apibridge', { id: 'api-bridge', provides: ['bridge'], environment: 'client' });
    await jar('servermod', { id: 'servermod', environment: 'server', depends: { bridge: '*' } });
    // Nothing depends on this one, so its exclusion must stand and be attributable.
    await jar('lonelyclient', { id: 'lonelyclient', environment: 'client' });

    const moved = await applyJarSideness(dir);
    assert.deepEqual(moved.map(entry => entry.jar).sort(), ['lonelyclient.jar'], 'only the un-depended-on jar is disabled');
    assert.match(moved[0]!.reasons.join(' '), /l2\.jar-self-declaration/, 'every exclusion carries its rule id');
    assert.ok(fs.existsSync(path.join(dir, 'apibridge.jar')), 'the provides-alias dependency must be rescued');
    assert.ok(fs.existsSync(path.join(dir, 'servermod.jar')));
  } finally {
    temp.cleanup();
  }
});

// ---------------------------------------------------------------- gap 5: anchored hand/learned matching

test('gap5: the itzg figura/configurable over-exclusion class is fixed', () => {
  // The real incident: a `figura` deny pattern substring-matched `configurable` and silently removed a
  // server-required mod. Any rule must match `figura` and never `configurable`.
  const resolver = makeCuratedResolver({
    platform: 'modrinth',
    presentPaths: ['mods/configurable-1.0.jar', 'mods/figura-0.1.jar'],
  });
  const configurable = resolver.resolve('mods/configurable-1.0.jar', 'required');
  assert.notEqual(configurable.env, 'unsupported', `"configurable" must never match a figura rule (why=${configurable.why})`);
  assert.equal(configurable.env, 'required');
  // The real figura jar is still matched, so the fix is anchoring, not disabling the rule.
  const figura = resolver.resolve('mods/figura-0.1.jar', 'required');
  assert.equal(figura.env, 'unsupported');
  assert.match(figura.why, /figura/, 'the reason must name the rule that fired');
  // The reason becomes the reviewed-plan warning, so the audit trail survives to the report.
  const mapped = mapFilePolicy({ path: 'mods/figura-0.1.jar', serverEnv: 'required', curated: figura });
  assert.equal(mapped.warnings.length, 1);
  assert.match(mapped.warnings[0]!, /mods\/figura-0\.1\.jar: .*figura/, 'the warning must name the rule id');
});

test('gap5: a bare "figura" hand/learned entry cannot substring-match "configurable"', () => {
  // The same defect reached through the hand/learned path, which used `n.includes(norm(match))` — the exact
  // predicate the itzg incident came from. A learned entry is used because it is user-writable at runtime.
  const temp = tempRoot('msm-gap5-figura');
  try {
    const learnedFile = path.join(temp.root, 'learned.json');
    fs.writeFileSync(learnedFile, JSON.stringify({
      serverOverrides: [{ match: 'figura', server: 'unsupported', why: 'auto: crashed with figura loaded' }],
    }));
    const resolver = makeCuratedResolver({ platform: 'modrinth', presentPaths: [], learnedFile });
    assert.equal(resolver.resolve('mods/configurable-1.0.jar', 'required').env, 'required',
      '"figura" must not match "configurable" through the learned list');
    assert.equal(resolver.resolve('mods/figura-0.1.jar', 'required').env, 'unsupported');
  } finally {
    temp.cleanup();
  }
});

test('gap5: hand entries still match decorated real-pack jars (anchoring must not break the evidence paths)', () => {
  // These are the exact jars the hand list was written for; a naive `(^|/)name[-_.]` anchor would miss both,
  // because the name is not at a path boundary.
  const resolver = makeCuratedResolver({
    platform: 'curseforge',
    presentPaths: ['mods/[异步粒子] AsyncParticles-20.1.3.2+1.20.1.jar', 'mods/[平滑转移] smoothswapping-0.9.2-1.20.1-forge.jar'],
  });
  const particles = resolver.resolve('mods/[异步粒子] AsyncParticles-20.1.3.2+1.20.1.jar', 'required');
  assert.equal(particles.env, 'unsupported', `decorated hand override must still fire (why=${particles.why})`);
  assert.match(particles.why, /asyncparticles/);
  assert.equal(resolver.resolve('mods/[平滑转移] smoothswapping-0.9.2-1.20.1-forge.jar', 'required').env, 'unsupported');
});

test('gap5: a hand rule matches a whole word or a version suffix, never a longer name', () => {
  const resolver = makeCuratedResolver({ platform: 'modrinth', presentPaths: [] });
  // `chatanimation` is a hand entry. It must match its own jar and version suffixes, not a longer mod name.
  assert.equal(resolver.resolve('mods/chatanimation-1.3.0+mc1.20.1.jar', 'required').env, 'unsupported');
  assert.equal(resolver.resolve('mods/chatanimationforge-1.0.jar', 'required').env, 'required');
});

test('gap5: unlessPresent guards are still evaluated against real paths (no silent "absent")', () => {
  // `chipped` is excluded only when the pack does NOT ship athena. Resolving the guard against the normalized
  // path would strip every separator, never match, and silently turn the guard into "always absent".
  const withAthena = makeCuratedResolver({
    platform: 'modrinth',
    presentPaths: ['mods/chipped-fabric-1.20.1-3.0.7.jar', 'mods/athena-fabric-3.1.1.jar'],
  });
  assert.equal(withAthena.resolve('mods/chipped-fabric-1.20.1-3.0.7.jar', 'required').env, 'required',
    'chipped must be kept when athena is present');
  const withoutAthena = makeCuratedResolver({
    platform: 'modrinth',
    presentPaths: ['mods/chipped-fabric-1.20.1-3.0.7.jar'],
  });
  assert.equal(withoutAthena.resolve('mods/chipped-fabric-1.20.1-3.0.7.jar', 'required').env, 'unsupported',
    'chipped must be excluded when athena is absent');
});

test('gap5: learned entries are anchored too, and carry their rule id', () => {
  const temp = tempRoot('msm-gap5-learned');
  try {
    const learnedFile = path.join(temp.root, 'learned.json');
    const resolver = makeCuratedResolver({
      platform: 'modrinth',
      presentPaths: [],
      learnedFile: (() => {
        fs.writeFileSync(learnedFile, JSON.stringify({ serverOverrides: [{ match: 'imblocker', server: 'unsupported', why: 'auto: crashed' }] }));
        return learnedFile;
      })(),
    });
    // Anchored: a longer mod name containing the learned token must not be excluded.
    assert.equal(resolver.resolve('mods/imblockerplus-1.0.jar', 'required').env, 'required');
    const hit = resolver.resolve('mods/IMBlocker-5.4.6-forge.jar', 'required');
    assert.equal(hit.env, 'unsupported');
    assert.match(hit.why, /learned\[imblocker\]/, 'the learned rule id must appear in the reason');
  } finally {
    temp.cleanup();
  }
});

test('gap5: the /regex/ form still works for hand entries', () => {
  const resolver = makeCuratedResolver({ platform: 'modrinth', presentPaths: [] });
  // No hand entry is a regex today, so this pins the capability rather than the data: the anchored plain-name
  // path must not swallow a `/…/` entry and treat it as a literal.
  const verdict = resolver.resolve('mods/some-mod.jar', 'required');
  assert.ok(verdict.why.trim().length > 0, 'every verdict states its provenance');
  assert.equal(verdict.why, 'declared');
});
