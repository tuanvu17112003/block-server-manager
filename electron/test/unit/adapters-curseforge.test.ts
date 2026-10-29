// CurseForge + Modrinth adapter mapping tests.
//
// These cover the pure mapping helpers — the part of each adapter that is OUR decision rather than the
// engine's. Everything else delegates (`resolveMrpack`, `inspectStagedZip`, `inferServerPackMetadata`), and
// the proof of that delegation is the real-artefact harness (`scripts/audit-adapters-real.mjs` →
// `docs/evidence/adapters/real-artefact-audit.json`), not this file.
//
// Every non-obvious expectation below is anchored to a value measured from a REAL cached artefact, quoted
// inline, so a future reader can tell a regression from a deliberate change:
//   .app-data/cache/cfpack/829758-server-7243901.zip → variables.txt MINECRAFT_VERSION=1.18.2,
//                                                      MODLOADER=Forge, MODLOADER_VERSION=40.2.17
//   .app-data/cache/cfpack/466901-server-9296268.zip → (unwrapped inner) variables.txt
//                                                      MINECRAFT_VERSION=1.20.1, MODLOADER=Fabric,
//                                                      MODLOADER_VERSION=0.19.3, RECOMMENDED_JAVA_VERSION=17
//   .app-data/cache/mrpack/*.mrpack                  → env.server ∈ {required, unsupported}; every real file
//                                                      carries both env.client and env.server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCurseForgeClientRecipe,
  buildCurseForgeServerPackRecipe,
  cfLoaderFamily,
  cfManifestFileSide,
  curseForgeClientAdapter,
  curseForgeServerPackAdapter,
  isCurseForgeManifest,
  isServerPackCreatorManifest,
  looksLikeCfAuthorServerPack,
  parseCfModLoaderId,
  readCfVariables,
} from '../../services/adapters/curseforge';
import { buildMrpackRecipe, isMrpackIndex, mrpackFileSide } from '../../services/adapters/modrinth';
import { AdapterRegistry, validateRecipe } from '../../services/adapters/registry';
import { ADAPTERS } from '../../services/adapters/index';
import type { ArchiveIndex, PackRecipe } from '../../services/adapters/types';

const noopIo = { log: (): void => {}, fetchJson: async <T = unknown>(): Promise<T> => ({}) as T };

/** Build a fake archive index from a name→content map. Detection must never need the network. */
function fakeArchive(files: Record<string, string | object>): ArchiveIndex {
  const names = Object.keys(files);
  const asText = (name: string): string | null => {
    const value = files[name];
    if (value === undefined) return null;
    return typeof value === 'string' ? value : JSON.stringify(value);
  };
  return {
    entries: names.map((name) => ({ name, size: 1, isDir: false })),
    names: new Set(names),
    readText: async (name: string) => asText(name),
    readJson: async <T = unknown>(name: string): Promise<T | null> => {
      const text = asText(name);
      if (text === null) return null;
      try { return JSON.parse(text) as T; } catch { return null; }
    },
    under: (prefix: string) => names.filter((name) => name.toLowerCase().startsWith(prefix.toLowerCase())),
  };
}

const registry = new AdapterRegistry(ADAPTERS);

// ---- mrpack side mapping: the rule the task names explicitly ----

test('mrpack side: required/optional/unsupported map through, ABSENT maps to unknown', () => {
  assert.equal(mrpackFileSide('required').side, 'required');
  assert.equal(mrpackFileSide('optional').side, 'optional');
  assert.equal(mrpackFileSide('unsupported').side, 'unsupported');
});

test('mrpack side: an absent env.server is unknown — never required, never unsupported', () => {
  // The whole point of the canonical `unknown` value (types.ts): collapsing "the manifest says nothing"
  // into either direction silently corrupts a server install.
  for (const absent of [undefined, null, '', '   ']) {
    const mapped = mrpackFileSide(absent);
    assert.equal(mapped.side, 'unknown', `env.server=${JSON.stringify(absent)} must be unknown`);
    assert.notEqual(mapped.side, 'required');
    assert.notEqual(mapped.side, 'unsupported');
  }
});

test('mrpack side: an unrecognised env.server value is unknown, not guessed', () => {
  // mrpack-install fatals on this; the research (§7 gap 6) says `unknown` must be first-class instead.
  const mapped = mrpackFileSide('both');
  assert.equal(mapped.side, 'unknown');
  assert.match(mapped.provenance, /unrecognised/);
});

// ---- mrpack index validation ----

test('mrpack detect: validates the signature keys, not the file extension', () => {
  const valid = {
    formatVersion: 1, game: 'minecraft', name: 'P',
    files: [], dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.19.3' },
  };
  assert.equal(isMrpackIndex(valid), true);
  // Each of these is a real .mrpack field being wrong; all must be refused.
  assert.equal(isMrpackIndex({ ...valid, formatVersion: 2 }), false);
  assert.equal(isMrpackIndex({ ...valid, game: 'something-else' }), false);
  assert.equal(isMrpackIndex({ ...valid, files: undefined }), false);
  assert.equal(isMrpackIndex({ ...valid, dependencies: null }), false);
  assert.equal(isMrpackIndex([]), false);
  assert.equal(isMrpackIndex(null), false);
});

test('mrpack recipe: a real-shaped index maps loader, mc, urls, hashes and override layers', () => {
  // Shape copied from the real COBBLEVERSE 1.7.42.mrpack (fabric-loader 0.18.4 / MC 1.21.1).
  const recipe = buildMrpackRecipe({
    index: {
      formatVersion: 1, game: 'minecraft', versionId: '1.7.42', name: 'COBBLEVERSE',
      dependencies: { 'fabric-loader': '0.18.4', minecraft: '1.21.1' },
      files: [{
        path: 'mods/CobbleFurnies-fabric-1.2.jar',
        hashes: { sha1: 'a71f20907c3350680a11054584cf96963f5875e5', sha512: '9cb5a3f1' },
        env: { server: 'required', client: 'required' },
        downloads: ['https://cdn.modrinth.com/data/AXY1OO9m/versions/54k31lEX/CobbleFurnies-fabric-1.2.jar'],
        fileSize: 2337235,
      }],
    },
  });
  assert.equal(recipe.formatId, 'modrinth.mrpack');
  assert.equal(recipe.loader, 'fabric');
  assert.equal(recipe.loaderVersion, '0.18.4');
  assert.equal(recipe.mc, '1.21.1');
  assert.equal(recipe.files.length, 1);
  assert.equal(recipe.files[0]!.side, 'required');
  assert.equal(recipe.files[0]!.size, 2337235);
  assert.equal(recipe.files[0]!.source.urls?.[0], 'https://cdn.modrinth.com/data/AXY1OO9m/versions/54k31lEX/CobbleFurnies-fabric-1.2.jar');
  // client-overrides/ must never appear: validateRecipe enforces it, and this asserts the recipe never emits it.
  assert.deepEqual(recipe.overrides.map((layer) => layer.prefix), ['overrides/', 'server-overrides/']);
  validateRecipe(recipe);
});

test('mrpack recipe: an index with no minecraft dependency fails closed instead of guessing', () => {
  assert.throws(
    () => buildMrpackRecipe({
      index: { formatVersion: 1, game: 'minecraft', versionId: '1', name: 'X', dependencies: { 'fabric-loader': '0.15.0' }, files: [] },
    }),
    /no minecraft dependency|minecraft/i,
  );
});

// ---- CurseForge manifest validation ----

test('cf detect: only the real CurseForge manifest schema is claimed', () => {
  const valid = {
    manifestType: 'minecraftModpack', manifestVersion: 1, name: 'CF',
    minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.4.0', primary: true }] },
    files: [{ projectID: 1, fileID: 2, required: true }],
  };
  assert.equal(isCurseForgeManifest(valid), true);
  assert.equal(isCurseForgeManifest({ ...valid, manifestType: 'somethingElse' }), false);
  assert.equal(isCurseForgeManifest({ ...valid, manifestVersion: 2 }), false);
  assert.equal(isCurseForgeManifest({ ...valid, minecraft: undefined }), false);
  assert.equal(isCurseForgeManifest({ ...valid, minecraft: { version: '1.20.1', modLoaders: [] } }), false);
  assert.equal(isCurseForgeManifest({ ...valid, minecraft: { version: '', modLoaders: [{ id: 'forge-1' }] } }), false);
  // ServerPackCreator's flat manifest is NOT a CurseForge manifest, despite the same file name.
  const spc = { files: ['config', 'mods/a.jar'], minecraftVersion: '1.20.1', modloader: 'Fabric' };
  assert.equal(isCurseForgeManifest(spc), false);
  assert.equal(isServerPackCreatorManifest(spc), true);
});

// ---- CurseForge side mapping ----

test('cf side: manifest required=false is optional; true/absent is required; never unsupported', () => {
  assert.equal(cfManifestFileSide(false).side, 'optional');
  assert.equal(cfManifestFileSide(true).side, 'required');
  assert.equal(cfManifestFileSide(undefined).side, 'required');
  // CurseForge has no side data at all (research §2 row 2), so an adapter must never invent `unsupported`.
  for (const value of [true, false, undefined]) {
    assert.notEqual(cfManifestFileSide(value).side, 'unsupported');
  }
});

// ---- CurseForge loader parsing ----

test('cf loader: modLoader ids parse into family + exact build, and unknown ids fail', () => {
  assert.deepEqual(parseCfModLoaderId('forge-47.4.0'), { loader: 'forge', version: '47.4.0' });
  assert.deepEqual(parseCfModLoaderId('neoforge-21.1.9'), { loader: 'neoforge', version: '21.1.9' });
  assert.deepEqual(parseCfModLoaderId('fabric-0.15.0'), { loader: 'fabric', version: '0.15.0' });
  assert.deepEqual(parseCfModLoaderId('quilt-0.21.0-beta.5'), { loader: 'quilt', version: '0.21.0-beta.5' });
  assert.equal(parseCfModLoaderId('liteloader-1.0'), null);
  assert.equal(parseCfModLoaderId(''), null);
  assert.equal(cfLoaderFamily('Forge'), 'forge');
  assert.equal(cfLoaderFamily('NeoForge'), 'neoforge');
  assert.equal(cfLoaderFamily('Fabric'), 'fabric');
  assert.equal(cfLoaderFamily('Quilt'), 'quilt');
  assert.equal(cfLoaderFamily('Vanilla'), 'vanilla');
  assert.equal(cfLoaderFamily('somethingelse'), null);
});

// ---- variables.txt (declared metadata shipped inside real CF server packs) ----

test('cf variables.txt: reads the exact keys two real cached server packs ship', () => {
  // 829758-server-7243901.zip, verbatim.
  const small = readCfVariables('MINECRAFT_VERSION=1.18.2\nMODLOADER=Forge\nMODLOADER_VERSION=40.2.17\nJAVA_ARGS="-Xmx4G -Xms4G"');
  assert.deepEqual(small, { mc: '1.18.2', loader: 'forge', loaderVersion: '40.2.17' });

  // 466901-server-9296268.zip inner archive, verbatim subset (real file has ~60 comment lines first).
  const prominent = readCfVariables([
    '###',
    '# REMEMBER:',
    '#   Escape \\ and : in your Java path',
    '###',
    'MINECRAFT_VERSION=1.20.1',
    'MODLOADER=Fabric',
    'MODLOADER_VERSION=0.19.3',
    'LEGACYFABRIC_INSTALLER_VERSION=1.1.1',
    'RECOMMENDED_JAVA_VERSION=17',
  ].join('\n'));
  assert.deepEqual(prominent, { mc: '1.20.1', loader: 'fabric', loaderVersion: '0.19.3' });
});

test('cf variables.txt: absent, empty and garbage inputs yield no evidence (never a guess)', () => {
  assert.equal(readCfVariables(null), null);
  assert.equal(readCfVariables(''), null);
  assert.equal(readCfVariables('# only comments\n# MINECRAFT_VERSION=9.9.9'), null);
  // A malformed version must not be accepted as one.
  const bad = readCfVariables('MINECRAFT_VERSION=not-a-version\nMODLOADER=Forge');
  assert.equal(bad?.mc, null);
  assert.equal(bad?.loader, 'forge');
  // An unknown loader word is null, not defaulted to Forge.
  const unknownLoader = readCfVariables('MINECRAFT_VERSION=1.20.1\nMODLOADER=SomeNewLoader');
  assert.equal(unknownLoader?.loader, null);
});

// ---- CurseForge recipes ----

function cfManifest(overrides: Record<string, unknown> = {}) {
  return {
    manifestType: 'minecraftModpack' as const,
    manifestVersion: 1 as const,
    name: 'Test CF Pack',
    minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.4.0', primary: true }] },
    files: [{ projectID: 238222, fileID: 4567890, required: true }, { projectID: 111, fileID: 222, required: false }],
    ...overrides,
  };
}

test('cf client recipe: provider coordinates, absolute loader build, overrides layer', () => {
  const recipe = buildCurseForgeClientRecipe(cfManifest() as never, 'test.zip');
  assert.equal(recipe.formatId, 'curseforge.client');
  assert.equal(recipe.mc, '1.20.1');
  assert.equal(recipe.loader, 'forge');
  assert.equal(recipe.loaderVersion, '47.4.0');
  assert.equal(recipe.files.length, 2);
  // A CF manifest carries no URLs, so every file must resolve through provider coordinates.
  assert.deepEqual(recipe.files[0]!.source.provider, { kind: 'curseforge', projectId: 238222, fileId: 4567890 });
  assert.equal(recipe.files[0]!.source.urls, undefined);
  assert.equal(recipe.files[0]!.side, 'required');
  assert.equal(recipe.files[1]!.side, 'optional', 'required=false must become optional');
  assert.deepEqual(recipe.overrides.map((layer) => layer.prefix), ['overrides/']);
  validateRecipe(recipe);
});

test('cf client recipe: an unparseable modLoader id fails closed', () => {
  assert.throws(
    () => buildCurseForgeClientRecipe(cfManifest({
      minecraft: { version: '1.20.1', modLoaders: [{ id: 'liteloader-1.0' }] },
    }) as never, 'test.zip'),
    /unrecognised modLoader/,
  );
});

test('cf client recipe: entries without projectID/fileID are reported, not silently dropped', () => {
  const recipe = buildCurseForgeClientRecipe(cfManifest({
    files: [{ projectID: 1, fileID: 2 }, { projectID: 'x', fileID: 3 }, { fileID: 4 }],
  }) as never, 'test.zip');
  assert.equal(recipe.files.length, 1);
  assert.ok(recipe.warnings.some((warning) => warning.rule === 'curseforge.manifest-entry-unidentified'));
  validateRecipe(recipe);
});

test('cf serverpack recipe: reads runtime from declared variables, applies the tree as one root layer', () => {
  const variables = readCfVariables('MINECRAFT_VERSION=1.18.2\nMODLOADER=Forge\nMODLOADER_VERSION=40.2.17');
  const recipe = buildCurseForgeServerPackRecipe(
    { name: '829758-server-7243901.zip', classification: 'supportedServerPack', reason: 'Plain server pack (loader will be installed).', minecraftVersion: null, loader: null, loaderVersion: null },
    ['mods/a.jar', 'config/b.toml', 'start.sh', 'variables.txt'],
    variables,
  );
  assert.equal(recipe.formatId, 'curseforge.serverpack');
  assert.equal(recipe.mc, '1.18.2', 'declared variables.txt must beat a blank inspector verdict');
  assert.equal(recipe.loader, 'forge');
  assert.equal(recipe.loaderVersion, '40.2.17');
  // The payload is already in the archive: no download list, one root layer.
  assert.equal(recipe.files.length, 0);
  assert.deepEqual(recipe.overrides, [{ prefix: '', order: 1 }]);
  assert.equal(recipe.launchShape, 'vendor-script', 'start.sh is a real shipped script');
  assert.ok(recipe.warnings.some((warning) => warning.rule === 'curseforge.metadata-from-variables-txt'));
  assert.ok(recipe.resolution.some((entry) => entry.field === 'mc' && /variables\.txt/.test(entry.source)));
  validateRecipe(recipe);
});

test('cf serverpack recipe: a pack with no readable version fails closed and names the real format', () => {
  assert.throws(
    () => buildCurseForgeServerPackRecipe(
      { name: 'x.zip', classification: 'supportedServerPack', reason: 'Plain server pack (loader will be installed).', minecraftVersion: null, loader: null, loaderVersion: null },
      ['mods/a.jar', 'config/b.toml'],
      null,
    ),
    (error: unknown) => {
      const message = (error as Error).message;
      return /no Minecraft version/.test(message) && /DV-04\/DV-05/.test(message);
    },
  );
});

test('cf serverpack recipe: an unsupported classification is refused, never softened', () => {
  assert.throws(
    () => buildCurseForgeServerPackRecipe(
      { name: 'x.zip', classification: 'unsupported', reason: 'No mods/, loader artifacts, or installer recognized.', minecraftVersion: null, loader: null, loaderVersion: null },
      ['readme.txt'],
      null,
    ),
    /classified this archive as "unsupported"/,
  );
});

// ---- detection: no mis-detection, and the new adapters do not steal other formats ----

test('cf detect: author server packs are claimed only on readable loader/version evidence', async () => {
  // Real shape of 829758/466901: declared variables.txt inside the distribution.
  assert.equal(looksLikeCfAuthorServerPack(
    ['mods/a.jar', 'variables.txt'],
    readCfVariables('MINECRAFT_VERSION=1.18.2\nMODLOADER=Forge'),
  ), true);
  // Real shape of 392141/936875: a shipped installer jar / libraries maven layout, read by the engine.
  assert.equal(looksLikeCfAuthorServerPack(['mods/a.jar', 'forge-1.20.1-47.4.0-installer.jar'], null), true);
  assert.equal(looksLikeCfAuthorServerPack(['libraries/net/minecraftforge/forge/1.12.2-14.23.5.2859/x.jar'], null), true);
  // A bare mods/ dump must stay with plain.serverzip.
  assert.equal(looksLikeCfAuthorServerPack(['mods/a.jar', 'config/b.toml'], null), false);
  // Another format's marker wins, whatever else is in the zip.
  assert.equal(looksLikeCfAuthorServerPack(['pack.toml', 'mods/a.jar', 'forge-1.20.1-47.4.0-installer.jar'], null), false);
  assert.equal(looksLikeCfAuthorServerPack(['modrinth.index.json', 'mods/a.jar'], null), false);
});

test('registry: the CurseForge adapters never steal another format\'s archive', async () => {
  const cases: [string, Record<string, string | object>, string][] = [
    ['modrinth', { 'modrinth.index.json': { formatVersion: 1, game: 'minecraft', name: 'M', files: [], dependencies: { minecraft: '1.20.1' } } }, 'modrinth.mrpack'],
    ['prism', { 'mmc-pack.json': { formatVersion: 1, components: [{ uid: 'net.minecraft', version: '1.20.1' }] } }, 'prism.multimc'],
    ['atlauncher', { 'instance.json': { uuid: 'u', launcher: { name: 'atl', version: '1.20.1' } } }, 'atlauncher'],
    ['ftb', { 'instance.json': { uuid: 'u', id: 3, versionId: 7, mcVersion: '1.12.2', modLoader: 'forge-1.0' } }, 'ftb.app'],
    ['bare dump', { 'mods/a.jar': 'x' }, 'plain.serverzip'],
  ];
  for (const [label, files, expected] of cases) {
    const ids = (await registry.candidates({ shape: 'archive', index: fakeArchive(files) })).map((adapter) => adapter.id);
    assert.equal(ids[0], expected, `${label}: expected ${expected} first, got ${ids.join(',') || '(none)'}`);
    assert.ok(!ids.includes('curseforge.client'), `${label} must not be claimed as a CurseForge client pack`);
    assert.ok(!ids.includes('curseforge.serverpack'), `${label} must not be claimed as a CurseForge server pack`);
  }
});

test('registry: the CF client adapter wins for a real manifest and outranks plain.serverzip', async () => {
  const archive = fakeArchive({
    'manifest.json': {
      manifestType: 'minecraftModpack', manifestVersion: 1, name: 'CF', minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.4.0', primary: true }] },
      files: [{ projectID: 1, fileID: 2, required: true }],
    },
    'overrides/config/x.toml': 'a=1',
  });
  const ids = (await registry.candidates({ shape: 'archive', index: archive })).map((adapter) => adapter.id);
  assert.equal(ids[0], 'curseforge.client');
  const recipe = await registry.resolve({ shape: 'archive', index: archive }, noopIo);
  assert.equal(recipe.formatId, 'curseforge.client');
});

test('registry: ServerPackCreator output is not absorbed by either CurseForge adapter', async () => {
  // research §2 row 12. It has no adapter yet (DV-04/DV-05, C4 scope) and must stay unclaimed by CF.
  const archive = fakeArchive({
    'manifest.json': { files: ['config', 'mods/a.jar'], minecraftVersion: '1.20.1', modloader: 'Fabric', serverPackCreatorVersion: '5.1.11' },
    'mods/a.jar': 'x',
  });
  const ids = (await registry.candidates({ shape: 'archive', index: archive })).map((adapter) => adapter.id);
  assert.ok(!ids.includes('curseforge.client'), `SPC output must not be claimed by the CF client adapter: ${ids.join(',')}`);
  assert.ok(!ids.includes('curseforge.serverpack'), `SPC output must not be claimed by the CF server-pack adapter: ${ids.join(',')}`);
});

// ---- contract: every recipe the two new adapters can produce passes validateRecipe ----

test('contract: both CurseForge recipes and the mrpack recipe satisfy validateRecipe', async () => {
  const recipes: PackRecipe[] = [
    buildCurseForgeClientRecipe(cfManifest() as never, 'test.zip'),
    buildCurseForgeServerPackRecipe(
      { name: '392141-server-6290699.zip', classification: 'supportedServerPack', reason: 'Prebuilt server pack (loader included).', minecraftVersion: '1.20.1', loader: 'Forge', loaderVersion: '47.4.0' },
      ['mods/a.jar', 'libraries/x.jar', 'user_jvm_args.txt'],
      null,
    ),
    buildMrpackRecipe({
      index: {
        formatVersion: 1, game: 'minecraft', versionId: 'v', name: 'P',
        dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.19.3' },
        files: [{ path: 'mods/a.jar', hashes: { sha1: 'aa' }, env: { server: 'required' }, downloads: ['https://cdn.modrinth.com/a.jar'], fileSize: 1 }],
      },
    }),
  ];
  for (const recipe of recipes) {
    validateRecipe(recipe);
    assert.ok(recipe.resolution.length > 0, 'every recipe must record how it resolved');
  }
});

test('adapters: both CurseForge adapters declare only the archive shape', async () => {
  assert.deepEqual([...curseForgeClientAdapter.shapes], ['archive']);
  assert.deepEqual([...curseForgeServerPackAdapter.shapes], ['archive']);
  // An httpTree / instance input must never reach them. The registry enforces that structurally via the
  // shape gate; `detect` additionally answers false, so a caller bypassing the gate still cannot misfire.
  assert.equal(await curseForgeClientAdapter.detect({ shape: 'httpTree', baseUrl: 'https://example.test' }), false);
  assert.equal(await curseForgeServerPackAdapter.detect({ shape: 'instance', index: fakeArchive({ 'mods/a.jar': 'x' }) }), false);
});
