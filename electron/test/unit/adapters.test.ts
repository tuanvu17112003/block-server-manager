// Pack adapter layer tests: registry ordering, recipe validation contract, and the FTB adapter's
// pure mapping functions (verified against the real FTB API response shapes recorded in
// docs/research/2026-10-29-claim-verification.md Â§13). No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdapterRegistry, validateRecipe } from '../../services/adapters/registry';
import {
  buildFtbRecipe, ftbFileSide, ftbJavaMajor, inferFtbLoaderFromFiles, isFtbPrerelease, parseFtbModLoader,
  pickFtbVersion, resolveFtbDestPath,
} from '../../services/adapters/ftb';
import type { DetectContext, PackAdapter, PackRecipe } from '../../services/adapters/types';

/** A no-op IO seam that satisfies the generic `fetchJson<T>` contract. */
const noopIo = {
  log: (): void => {},
  fetchJson: async <T = unknown>(): Promise<T> => ({}) as T,
};

function recipe(overrides: Partial<PackRecipe> = {}): PackRecipe {
  return {
    formatId: 'ftb.app',
    name: 'Test Pack',
    mc: '1.12.2',
    loader: 'forge',
    loaderVersion: '14.23.5.2846',
    javaMajor: 8,
    files: [{ path: 'mods/a.jar', source: { urls: ['https://example.test/a.jar'] }, side: 'required', sideProvenance: 'test' }],
    overrides: [],
    launchShape: 'generated-args',
    managerOwned: ['eula.txt'],
    warnings: [],
    resolution: [],
    ...overrides,
  };
}

// ---- registry ----

test('AdapterRegistry: higher priority wins and only validated matches are returned', async () => {
  const adapter = (id: PackAdapter['id'], priority: number, match: boolean): PackAdapter => ({
    id, displayName: id, inputs: ['archive'], priority,
    detect: () => match,
    resolve: async () => recipe({ formatId: id }),
  });
  const registry = new AdapterRegistry([
    adapter('plain.serverzip', 5, true),
    adapter('modrinth.mrpack', 90, true),
    adapter('packwiz', 50, false),
  ]);

  const candidates = await registry.candidates({});
  assert.deepEqual(candidates.map((c) => c.id), ['modrinth.mrpack', 'plain.serverzip']);
  const resolved = await registry.resolve({}, noopIo);
  assert.equal(resolved.formatId, 'modrinth.mrpack', 'highest priority adapter must win');
});

test('AdapterRegistry: a throwing detector cannot break the others', async () => {
  const registry = new AdapterRegistry([
    { id: 'ftb.app', displayName: 'boom', inputs: ['archive'], priority: 99, detect: () => { throw new Error('boom'); }, resolve: async () => recipe() },
    { id: 'plain.serverzip', displayName: 'ok', inputs: ['archive'], priority: 1, detect: () => true, resolve: async () => recipe() },
  ]);
  const candidates = await registry.candidates({});
  assert.deepEqual(candidates.map((c) => c.id), ['plain.serverzip']);
});

test('AdapterRegistry: an unrecognized archive fails closed with evidence, never "unknown pack"', async () => {
  const registry = new AdapterRegistry([{ ...fakeAdapter(), detect: () => false }]);
  const ctx: DetectContext = {
    archive: {
      entries: [{ name: 'readme.txt', size: 1, isDir: false }],
      names: new Set(['readme.txt']),
      readText: async () => null,
      readJson: async () => null,
      under: () => [],
    },
  };
  await assert.rejects(
    () => registry.resolve(ctx, noopIo),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /Unrecognized modpack format/);
      assert.match(message, /readme\.txt/, 'must report what it actually saw');
      return true;
    },
  );
});

function fakeAdapter(): PackAdapter {
  return { id: 'plain.serverzip', displayName: 'fake', inputs: ['archive'], priority: 1, detect: () => true, resolve: async () => recipe() };
}

// ---- recipe validation contract ----

test('validateRecipe: rejects an empty/guessed Minecraft version', () => {
  assert.throws(() => validateRecipe(recipe({ mc: '' })), /Refusing to guess a runtime/);
  assert.throws(() => validateRecipe(recipe({ mc: 'latest' })), /invalid Minecraft version/);
});

test('validateRecipe: rejects unsafe paths, sourceless files and client-overrides', () => {
  assert.throws(() => validateRecipe(recipe({
    files: [{ path: '../escape.jar', source: { urls: ['https://e.test/a'] }, side: 'required', sideProvenance: 't' }],
  })), /unsafe path/);
  assert.throws(() => validateRecipe(recipe({
    files: [{ path: 'mods/a.jar', source: {}, side: 'required', sideProvenance: 't' }],
  })), /no download source/);
  assert.throws(() => validateRecipe(recipe({ overrides: [{ prefix: 'client-overrides/', order: 1 }] })),
    /client-overrides/);
});

test('validateRecipe: rejects hybrid loaders for new installs', () => {
  assert.throws(() => validateRecipe(recipe({ loader: 'hybrid' })), /hybrid loaders are not supported/);
});

// ---- FTB pure mapping (shapes recorded from the live API) ----

test('parseFtbModLoader: maps FTB target strings onto loader families', () => {
  assert.deepEqual(parseFtbModLoader('forge-14.23.5.2846'), { loader: 'forge', version: '14.23.5.2846' });
  assert.deepEqual(parseFtbModLoader('neoforge-21.1.9'), { loader: 'neoforge', version: '21.1.9' });
  assert.deepEqual(parseFtbModLoader('fabric-0.15.0'), { loader: 'fabric', version: '0.15.0' });
  assert.deepEqual(parseFtbModLoader('quilt-0.20.0'), { loader: 'quilt', version: '0.20.0' });
  assert.deepEqual(parseFtbModLoader('forge'), { loader: 'forge', version: null });
  assert.deepEqual(parseFtbModLoader(null), { loader: 'vanilla', version: null });
  assert.deepEqual(parseFtbModLoader('something-else'), { loader: 'vanilla', version: null });
});

test('ftbFileSide: serveronly wins, clientonly excludes, optional only downgrades shared files', () => {
  assert.equal(ftbFileSide({ serveronly: true, clientonly: false }), 'required');
  assert.equal(ftbFileSide({ serveronly: true, clientonly: true }), 'required', 'serveronly must win over clientonly');
  assert.equal(ftbFileSide({ clientonly: true, serveronly: false }), 'unsupported');
  assert.equal(ftbFileSide({ optional: true, clientonly: false }), 'optional');
  assert.equal(ftbFileSide({}), 'required');
  assert.equal(ftbFileSide({ optional: true, serveronly: true }), 'required', 'optional must not hide a server file');
});

test('ftbJavaMajor: reads the major out of an FTB java target', () => {
  assert.equal(ftbJavaMajor([{ id: -1, name: 'java', type: 'runtime', version: '8.0.312+7' }]), 8);
  assert.equal(ftbJavaMajor([{ id: -1, name: 'java', type: 'runtime', version: '17.0.8' }]), 17);
  assert.equal(ftbJavaMajor([{ id: 1, name: 'forge', type: 'modloader', version: '1.0' }]), null);
  assert.equal(ftbJavaMajor(undefined), null);
});

test('pickFtbVersion: newest by updated, preferring a release — FTB lists versions ASCENDING', () => {
  // Real shape from api.modpacks.ch pack 6 (FTB Omnia): versions[] is oldest-first, and the oldest beta
  // declares no modloader while later releases do. Taking versions[0] installed the wrong build.
  const omnia = {
    id: 6,
    name: 'FTB Omnia',
    versions: [
      { id: 6, name: '1.0.0', type: 'beta', updated: 1585684800 },
      { id: 45, name: '1.0.1', type: 'release', updated: 1586000000 },
      { id: 91, name: '1.7.0', type: 'release', updated: 1596060000 },
    ],
  };
  assert.equal(pickFtbVersion(omnia).id, 91, 'must pick the newest release, not the oldest array entry');
  assert.equal(pickFtbVersion(omnia, 45).id, 45, 'an explicit pin still wins');
  assert.throws(() => pickFtbVersion(omnia, 99), /no version 99/);

  // Newest overall is a beta, but a release exists → prefer the release.
  const withBetaTip = {
    id: 7,
    name: 'x',
    versions: [
      { id: 1, name: '1.0', type: 'release', updated: 100 },
      { id: 2, name: '1.1', type: 'beta', updated: 200 },
    ],
  };
  assert.equal(pickFtbVersion(withBetaTip).id, 1, 'a beta tip must not outrank the newest release');

  // No releases at all → take the newest of any type rather than failing.
  const betaOnly = { id: 8, name: 'y', versions: [{ id: 1, name: 'a', type: 'beta', updated: 100 }, { id: 2, name: 'b', type: 'alpha', updated: 300 }] };
  assert.equal(pickFtbVersion(betaOnly).id, 2);
  assert.equal(isFtbPrerelease(betaOnly.versions[1]!), true);
  assert.equal(isFtbPrerelease(withBetaTip.versions[0]!), false);
  assert.throws(() => pickFtbVersion({ id: 1, name: 'x', versions: [] }), /no versions/);
});

test('buildFtbRecipe: produces the canonical recipe from a real FTB version document', () => {
  // Targets and file shapes exactly as returned by api.modpacks.ch for pack 1 version 2.
  const result = buildFtbRecipe({
    packName: 'FTB Academy 1.12',
    version: {
      id: 2,
      name: '1.1.0',
      targets: [
        { id: 1, name: 'forge', type: 'modloader', version: '14.23.5.2846' },
        { id: 2, name: 'minecraft', type: 'game', version: '1.12.2' },
        { id: -1, name: 'java', type: 'runtime', version: '8.0.312+7' },
      ],
      files: [
        { path: './mods/shared.jar', url: 'https://dist.modpacks.ch/x/shared.jar', sha1: 'abc', size: 10, clientonly: false, serveronly: false },
        { path: './mods/client.jar', url: 'https://dist.modpacks.ch/x/client.jar', sha1: 'def', size: 20, clientonly: true },
        { path: './mods/server.jar', url: 'https://dist.modpacks.ch/x/server.jar', sha1: 'ghi', size: 30, serveronly: true },
        { path: './mods/opt.jar', url: 'https://dist.modpacks.ch/x/opt.jar', optional: true },
        { path: './config/a.cfg', url: 'https://dist.modpacks.ch/x/a.cfg' },
        { path: './mods/thing.jar.meta', url: 'https://dist.modpacks.ch/x/thing.jar.meta' },
      ],
    },
  });

  assert.equal(result.formatId, 'ftb.app');
  assert.equal(result.mc, '1.12.2');
  assert.equal(result.loader, 'forge');
  assert.equal(result.loaderVersion, '14.23.5.2846');
  assert.equal(result.javaMajor, 8, 'FTB declares the runtime, so we must not need a Mojang lookup');
  assert.equal(result.overrides.length, 0, 'FTB lists every payload file explicitly');

  const byPath = new Map(result.files.map((file) => [file.path, file]));
  assert.equal(byPath.get('mods/shared.jar')?.side, 'required');
  assert.equal(byPath.get('mods/client.jar')?.side, 'unsupported');
  assert.equal(byPath.get('mods/server.jar')?.side, 'required');
  assert.equal(byPath.get('mods/opt.jar')?.side, 'optional');
  assert.equal(byPath.get('config/a.cfg')?.side, 'required', 'config belongs on a server');
  assert.equal(byPath.has('mods/thing.jar.meta'), false, '.meta sidecars are FTB bookkeeping');
  assert.equal(result.files.length, 5);

  // The recipe must pass the same structural gate every adapter is held to.
  validateRecipe(result);
});

test('buildFtbRecipe: refuses to guess when the Minecraft target is missing', () => {
  assert.throws(() => buildFtbRecipe({
    packName: 'no-mc',
    version: { id: 1, name: '1', targets: [], files: [{ path: './mods/a.jar', url: 'https://d.test/a.jar' }] },
  }), /does not declare a Minecraft version/);
});

test('buildFtbRecipe: records wins and skips URL-less files with a rule-attributed warning', () => {
  const result = buildFtbRecipe({
    packName: 'warn',
    version: {
      id: 1,
      name: '1',
      targets: [{ id: 2, name: 'minecraft', type: 'game', version: '1.20.1' }],
      files: [
        { path: './mods/a.jar', url: '' },
        { path: './mods/b.jar', url: 'https://d.test/b.jar', mirrors: ['https://m.test/b.jar'], size: 5 },
      ],
    },
  });
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.files[0]!.source.urls, ['https://d.test/b.jar', 'https://m.test/b.jar'], 'mirrors must be kept');
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]!.rule, 'ftb.file-no-url');
});

// ---- two bugs found by running the adapter against real FTB packs ----

test('resolveFtbDestPath: FTB Omnia puts the directory in `path` and the file in `name`', () => {
  // Real shape from api.modpacks.ch pack 6 (FTB Omnia): path="./mods", name="Bookshelf-1.15.2-5.3.9.jar".
  // Using `path` alone dropped all 155 mods and made the pack look vanilla.
  assert.equal(resolveFtbDestPath({ path: './mods', name: 'Bookshelf-1.15.2-5.3.9.jar' }), 'mods/Bookshelf-1.15.2-5.3.9.jar');
  // The common shape must be left untouched.
  assert.equal(resolveFtbDestPath({ path: './mods/shared.jar', name: 'shared.jar' }), 'mods/shared.jar');
  assert.equal(resolveFtbDestPath({ path: '', name: 'x.jar' }), '');
});

test('resolveFtbDestPath: extensionless filenames must not be mistaken for directories', () => {
  // Real shape from FTB Stoneblock 2: path is a DIRECTORY ("config/vanillafix") and the file has no
  // extension ("config_version"). A "has a dot ⇒ file" heuristic treated the directory as a file and a
  // later mkdir collided with EEXIST.
  assert.equal(resolveFtbDestPath({ path: './config/vanillafix', name: 'config_version' }), 'config/vanillafix/config_version');
  assert.equal(resolveFtbDestPath({ path: './config/vanillafix', name: 'methods-stable_39.csv' }), 'config/vanillafix/methods-stable_39.csv');
  // A full path whose name already matches must stay as-is.
  assert.equal(resolveFtbDestPath({ path: './config/mod.toml', name: 'mod.toml' }), 'config/mod.toml');
});

test('buildFtbRecipe: mods without a modloader target are inferred from jar names, warned and recorded', () => {
  // Real shape from FTB Omnia: 155 Forge jars, targets contain only minecraft + java.
  const files = Array.from({ length: 10 }, (_, index) => ({
    version: '1', path: './mods', name: `Mod${index}-1.15.2-forge-1.0.${index}.jar`, url: `https://d.test/m${index}.jar`, type: 'mod',
  }));
  const result = buildFtbRecipe({
    packName: 'FTB Omnia',
    version: { id: 6, name: '1.0.0', targets: [{ id: 5, name: 'minecraft', type: 'game', version: '1.15.2' }], files },
  });
  assert.equal(result.loader, 'forge', 'must not silently become vanilla');
  assert.equal(result.files.length, 10, 'every mod needs its name-derived path');
  assert.ok(result.files.every((file) => /^mods\/.+\.jar$/.test(file.path)), 'paths must include the filename');
  assert.ok(result.warnings.some((entry) => entry.rule === 'ftb.modloader-missing-inferred'), 'inference must be reported');
  assert.ok(result.resolution.some((entry) => entry.field === 'loader' && /inferred from jar names/.test(entry.source)));
});

test('buildFtbRecipe: mods with no modloader and ambiguous jar names fail closed', () => {
  assert.throws(() => buildFtbRecipe({
    packName: 'ambiguous',
    version: {
      id: 1, name: '1',
      targets: [{ id: 2, name: 'minecraft', type: 'game', version: '1.20.1' }],
      files: [
        { path: './mods', name: 'alpha.jar', url: 'https://d.test/a.jar', type: 'mod' },
        { path: './mods', name: 'beta.jar', url: 'https://d.test/b.jar', type: 'mod' },
      ],
    },
  }), /ships mods but declares no modloader/);
});

test('inferFtbLoaderFromFiles: requires a clear winner, never a coin flip', () => {
  const jar = (name: string) => ({ path: './mods', name, url: 'https://d.test/x.jar' });
  assert.equal(inferFtbLoaderFromFiles([jar('a-1.20-forge-1.jar'), jar('b-1.20-forge-2.jar'), jar('c-1.20-forge-3.jar')])?.loader, 'forge');
  assert.equal(inferFtbLoaderFromFiles([jar('a.jar'), jar('b.jar'), jar('c.jar')]), null, 'no loader token ⇒ no guess');
  assert.equal(inferFtbLoaderFromFiles([jar('a-forge-1.jar'), jar('b-fabric-1.jar'), jar('c-fabric-2.jar')]), null, 'split evidence ⇒ no guess');
});
