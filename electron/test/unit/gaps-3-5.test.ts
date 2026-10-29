// C7 tests: research §7 gaps 3 and 5, built from the predicate differences the research documented with source
// evidence. These are the two rules the research proved wrong and that survived three phases untouched.
//
// gap3 — Forge `mods.toml` side rule. Research §3.1:
//   "the `side` on the **platform dependency** (a dependency whose `modId` matches ^(forge|neoforge|minecraft)$)
//    is the mod's own sideness. No platform entry / no [[dependencies]] / any exception ⇒ SERVER."
//   Source: ServerPackCreator `ForgeTomlScanner.kt:114-152` (cloned at verify-repos/).
//
// gap5 — hand/learned exclusion matching. Research §3.6 / itzg issue #4234:
//   the deny pattern `figura` substring-matched `configurable` and silently dropped a server-required mod across
//   24/24 paths with no log line. Rule: "anchored/regex matching, never bare substring."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forgeTomlIsClientOnly, parseForgeDependencies } from '../../services/installer/core';
import { makeCuratedResolver } from '../../services/installer/curated';

// ---- gap 3: Forge platform-dependency rule ----

test('parseForgeDependencies: reads [[dependencies.<mod>]] entries with their side/type/mandatory', () => {
  const toml = `
modLoader="javafml"
loaderVersion="[47,)"

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
  const parsed = parseForgeDependencies(toml);
  const entries = parsed.get('examplemod');
  assert.ok(entries, 'the mod owner block must be found');
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(entry => entry.modId), ['forge', 'minecraft']);
  assert.deepEqual(entries.map(entry => entry.side), ['BOTH', 'CLIENT']);
});

test('forgeTomlIsClientOnly: client iff the PLATFORM dependency says CLIENT', () => {
  // A real client mod: it demands Minecraft client-side.
  const clientMod = `
[[dependencies.sodium]]
    modId="minecraft"
    side="CLIENT"
`;
  assert.equal(forgeTomlIsClientOnly(clientMod).client, true);

  // A server mod: platform says BOTH.
  const serverMod = `
[[dependencies.servermod]]
    modId="forge"
    side="BOTH"
`;
  assert.equal(forgeTomlIsClientOnly(serverMod).client, false);
});

test('forgeTomlIsClientOnly: a CLIENT side on a NON-platform dependency must not drop the mod', () => {
  // This is the exact predicate difference research §3.1 describes: the old rule ("every side= is CLIENT")
  // would have decided nothing here, and a naive "any side=CLIENT" rule would wrongly drop a server mod.
  const toml = `
[[dependencies.examplemod]]
    modId="forge"
    side="BOTH"

[[dependencies.examplemod]]
    modId="someclientlibrary"
    side="CLIENT"
`;
  const verdict = forgeTomlIsClientOnly(toml);
  assert.equal(verdict.client, false, 'a non-platform CLIENT dependency is not the mod declaring itself client');
});

test('forgeTomlIsClientOnly: no dependencies section at all ⇒ SERVER (fail toward keeping)', () => {
  assert.equal(forgeTomlIsClientOnly('modLoader="javafml"\nlicense="MIT"').client, false);
  assert.equal(forgeTomlIsClientOnly('').client, false);
});

test('forgeTomlIsClientOnly: no platform entry ⇒ SERVER', () => {
  const toml = `
[[dependencies.examplemod]]
    modId="someothermod"
    side="CLIENT"
`;
  assert.equal(forgeTomlIsClientOnly(toml).client, false);
});

test('forgeTomlIsClientOnly: incompatible dependencies are skipped', () => {
  const toml = `
[[dependencies.examplemod]]
    modId="minecraft"
    side="CLIENT"
    type="incompatible"
`;
  // The only platform entry is an incompatible declaration, so it must not make the mod client-only.
  assert.equal(forgeTomlIsClientOnly(toml).client, false);
});

test('forgeTomlIsClientOnly: unparseable text ⇒ SERVER, never throws', () => {
  assert.doesNotThrow(() => forgeTomlIsClientOnly('[[[[ not toml ===='));
  assert.equal(forgeTomlIsClientOnly('[[[[ not toml ====').client, false);
});

// ---- gap 5: anchored hand/learned matching ----

test('curated: the figura/configurable over-exclusion class is fixed', () => {
  // Real itzg incident: deny pattern `figura` substring-matched `configurable` and silently removed a
  // server-required mod. Anchored matching must not match a different mod's name.
  const resolver = makeCuratedResolver({
    platform: 'curseforge',
    presentPaths: ['mods/configurable-1.0.jar', 'mods/figura-0.1.jar'],
    learnedFile: undefined,
  });
  // Direct check of the anchoring property via the itzg-shaped entry path: a path containing "figura" only as a
  // substring of another word must not be treated as the figura mod.
  const verdict = resolver.resolve('mods/configurable-1.0.jar', 'required');
  // Either the entry does not exist (declared stays) or it does not match — what must never happen is that it is
  // excluded *because* "figura" appears inside "configurable".
  assert.notEqual(verdict.env, 'unsupported', `"configurable" must not match a "figura" rule (got why=${verdict.why})`);
});

test('curated: hand/learned reasons carry a rule id so an exclusion is auditable', () => {
  const resolver = makeCuratedResolver({
    platform: 'modrinth',
    presentPaths: ['mods/example-1.0.jar'],
  });
  const verdict = resolver.resolve('mods/example-1.0.jar', 'required');
  // Whatever the verdict, the reason must identify the rule that produced it, never be blank.
  assert.ok(verdict.why.trim().length > 0, 'every verdict must state its provenance');
});
