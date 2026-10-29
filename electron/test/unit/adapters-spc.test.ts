// C4 tests: the ServerPackCreator output adapter (research §2 row 12).
//
// Schema taken from a REAL archive, not assumed: `.app-data/cache/cfpack/466901-server-9296268.zip` unwraps to a
// root `manifest.json` of
//   { files: [...3642...], minecraftVersion: "1.20.1", modloader: "Fabric",
//     modloaderVersion: "0.19.3", serverPackCreatorVersion: "..." }
// Cross-checked against two independent sources inside the same archive/ecosystem: the inner `variables.txt`
// (MINECRAFT_VERSION=1.20.1 / MODLOADER=Fabric / MODLOADER_VERSION=0.19.3) and the Modrinth client pack
// (fabric 0.19.3 / MC 1.20.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSpcManifest, serverPackCreatorAdapter } from '../../services/adapters/serverpackcreator';
import { AdapterRegistry, validateRecipe } from '../../services/adapters/registry';
import { ADAPTERS } from '../../services/adapters/index';
import type { ArchiveIndex, DetectInput } from '../../services/adapters/types';

function fakeArchive(files: Record<string, string | object>): ArchiveIndex {
  const names = Object.keys(files);
  const asText = (name: string): string | null => {
    const value = files[name];
    if (value === undefined) return null;
    return typeof value === 'string' ? value : JSON.stringify(value);
  };
  return {
    entries: names.map(name => ({ name, size: 1, isDir: false })),
    names: new Set(names),
    readText: async (name: string) => asText(name),
    readJson: async <T = unknown>(name: string): Promise<T | null> => {
      const text = asText(name);
      if (text === null) return null;
      try { return JSON.parse(text) as T; } catch { return null; }
    },
    under: (prefix: string) => names.filter(name => name.toLowerCase().startsWith(prefix.toLowerCase())),
  };
}

const noopIo = { log: (): void => {}, fetchJson: async <T = unknown>(): Promise<T> => ({}) as T };
const registry = new AdapterRegistry(ADAPTERS);

// ---- the real manifest shape ----

test('readSpcManifest: reads the exact shape the real 1 GB archive ships', () => {
  const real = {
    files: new Array(3642).fill({}),
    minecraftVersion: '1.20.1',
    modloader: 'Fabric',
    modloaderVersion: '0.19.3',
    serverPackCreatorVersion: 'some-version',
  };
  const runtime = readSpcManifest(real);
  assert.ok(runtime);
  assert.equal(runtime.mc, '1.20.1');
  assert.equal(runtime.loader, 'fabric');
  assert.equal(runtime.loaderVersion, '0.19.3');
  assert.equal(runtime.fileCount, 3642);
});

test('readSpcManifest: loader names normalise (case, spaces, legacy aliases)', () => {
  const base = { files: [], minecraftVersion: '1.20.1' };
  assert.equal(readSpcManifest({ ...base, modloader: 'Forge' })?.loader, 'forge');
  assert.equal(readSpcManifest({ ...base, modloader: 'NeoForge' })?.loader, 'neoforge');
  assert.equal(readSpcManifest({ ...base, modloader: 'Fabric' })?.loader, 'fabric');
  assert.equal(readSpcManifest({ ...base, modloader: 'Quilt' })?.loader, 'quilt');
  assert.equal(readSpcManifest({ ...base, modloader: 'LegacyFabric' })?.loader, 'fabric');
});

test('readSpcManifest: rejects a CurseForge manifest (rows 11/12 are different formats)', () => {
  // A CurseForge client manifest must never be read as SPC output.
  const curseforge = {
    manifestType: 'minecraftModpack',
    manifestVersion: 1,
    name: 'x',
    version: '1',
    files: [{ projectID: 1, fileID: 2, required: true }],
    minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] },
  };
  assert.equal(readSpcManifest(curseforge), null, 'a CF manifest has no minecraftVersion, so it must be declined');
});

test('readSpcManifest: rejects partial/garbage manifests rather than guessing', () => {
  assert.equal(readSpcManifest(null), null);
  assert.equal(readSpcManifest({}), null);
  assert.equal(readSpcManifest({ files: [] }), null, 'no minecraftVersion');
  assert.equal(readSpcManifest({ files: [], minecraftVersion: '1.20.1' }), null, 'no modloader');
  assert.equal(readSpcManifest({ files: [], minecraftVersion: '  ', modloader: 'Forge' }), null, 'blank version');
});

// ---- detection + recipe ----

test('serverpackcreator: claims only an archive whose manifest.json is SPC output', async () => {
  const spc = fakeArchive({ 'manifest.json': { files: [], minecraftVersion: '1.20.1', modloader: 'Fabric' }, 'mods/a.jar': 'x' });
  assert.equal(await serverPackCreatorAdapter.detect({ shape: 'archive', index: spc }), true);

  const cf = fakeArchive({
    'manifest.json': { manifestType: 'minecraftModpack', manifestVersion: 1, files: [], minecraft: { version: '1.20.1', modLoaders: [] } },
  });
  assert.equal(await serverPackCreatorAdapter.detect({ shape: 'archive', index: cf }), false);

  const narrow = fakeArchive({ 'mods/a.jar': 'x' });
  assert.equal(await serverPackCreatorAdapter.detect({ shape: 'archive', index: narrow }), false);
});

test('serverpackcreator: refuses a non-archive shape explicitly', async () => {
  await assert.rejects(
    () => serverPackCreatorAdapter.resolve({ shape: 'httpTree', baseUrl: 'https://x.test' } as DetectInput, noopIo),
    /cannot handle a "httpTree" input/,
  );
});

test('serverpackcreator: recipe carries the declared runtime, one root layer, and a rule id', async () => {
  const archive = fakeArchive({
    'manifest.json': { files: [1, 2, 3], minecraftVersion: '1.20.1', modloader: 'Fabric', modloaderVersion: '0.19.3' },
    'mods/a.jar': 'x',
  });
  const recipe = await serverPackCreatorAdapter.resolve({ shape: 'archive', index: archive }, noopIo);
  assert.equal(recipe.formatId, 'serverpackcreator');
  assert.equal(recipe.mc, '1.20.1');
  assert.equal(recipe.loader, 'fabric');
  assert.equal(recipe.loaderVersion, '0.19.3');
  // The archive IS the payload: no download list, one root override layer.
  assert.equal(recipe.files.length, 0);
  assert.deepEqual(recipe.overrides.map(layer => layer.prefix), ['']);
  assert.ok(recipe.warnings.some(w => w.rule === 'spc.manifest-derived'), 'derivation must be stated');
  assert.ok(recipe.resolution.some(entry => entry.field === 'mc'), 'resolution must record provenance');
  validateRecipe(recipe);
});

test('serverpackcreator: a Quilt pack is flagged with the policy reason, not silently accepted', async () => {
  const archive = fakeArchive({
    'manifest.json': { files: [], minecraftVersion: '1.20.2', modloader: 'Quilt', modloaderVersion: '0.21.0' },
  });
  const recipe = await serverPackCreatorAdapter.resolve({ shape: 'archive', index: archive }, noopIo);
  assert.equal(recipe.loader, 'quilt');
  assert.ok(recipe.warnings.some(w => w.rule === 'spc.quilt-policy'));
});

// ---- registry: row 12 wins over row 11, and never steals another format ----

test('registry: an SPC manifest archive is claimed by serverpackcreator, not by a CurseForge adapter', async () => {
  const archive = fakeArchive({
    'manifest.json': { files: [], minecraftVersion: '1.20.1', modloader: 'Fabric', modloaderVersion: '0.19.3' },
  });
  const candidates = (await registry.candidates({ shape: 'archive', index: archive })).map(adapter => adapter.id);
  assert.equal(candidates[0], 'serverpackcreator', `expected serverpackcreator first, got ${candidates.join(',')}`);
});

test('registry: a plain mrpack is still claimed by modrinth, not by serverpackcreator', async () => {
  const archive = fakeArchive({
    'modrinth.index.json': { formatVersion: 1, game: 'minecraft', versionId: '1', name: 'x', files: [], dependencies: { minecraft: '1.20.1' } },
  });
  const candidates = (await registry.candidates({ shape: 'archive', index: archive })).map(adapter => adapter.id);
  assert.equal(candidates[0], 'modrinth.mrpack');
  assert.equal(candidates.includes('serverpackcreator'), false);
});
