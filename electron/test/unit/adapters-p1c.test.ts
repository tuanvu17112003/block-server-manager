// P1c adapter tests: TOML subset, detection (no mis-detection across three `instance.json` formats), and the
// canonical recipe each archive format produces.
//
// Every fixture shape is taken from docs/research/2026-10-29-p1c-format-census.md, which quotes the serializers
// of PrismLauncher, ATLauncher and packwiz. No network: the archive index is faked from an in-memory map, which
// is exactly the boundary the adapters are designed around.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToml, TomlParseError, tomlString, tomlTable } from '../../services/adapters/toml';
import { packwizAdapter, packwizFileSide, packwizLoader, isValidPackwizPack } from '../../services/adapters/packwiz';
import { prismAdapter, readMmcRuntime, validateMmcPack } from '../../services/adapters/prism';
import { atlauncherAdapter, readAtlInstance, readAtlLoader, readAtlMc } from '../../services/adapters/atlauncher';
import { readServerZipEvidence, looksLikeServerZip, serverZipAdapter } from '../../services/adapters/serverzip';
import { AdapterRegistry, validateRecipe } from '../../services/adapters/registry';
import { ADAPTERS } from '../../services/adapters/index';
import type { ArchiveIndex, DetectContext, PackRecipe } from '../../services/adapters/types';

/** Build a fake archive index from a name→content map (content strings are what the adapters read). */
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

/** Which adapter claims this archive, in priority order. */
async function detect(archive: ArchiveIndex): Promise<string[]> {
  const ctx: any = { shape: 'archive', index: archive };
  return (await registry.candidates(ctx)).map(adapter => adapter.id);
}

// ---- TOML subset ----

test('parseToml: reads the shapes packwiz actually writes', () => {
  const pack = parseToml(`
name = "My Pack"
pack-format = "packwiz:1.1.0"
# a comment
[index]
file = "index.toml"
hash-format = "sha256"
hash = "abc123"

[versions]
minecraft = "1.20.1"
fabric = "0.15.0"
`);
  assert.equal(tomlString(pack, 'name'), 'My Pack');
  assert.equal(tomlString(pack, 'pack-format'), 'packwiz:1.1.0');
  assert.equal(tomlString(pack, 'index', 'hash-format'), 'sha256');
  assert.equal(tomlString(pack, 'versions', 'minecraft'), '1.20.1');
  assert.equal(tomlString(pack, 'versions', 'fabric'), '0.15.0');
});

test('parseToml: booleans, arrays, literal strings, [[array of tables]]', () => {
  const doc = parseToml(`
literal = 'no \\escapes here'
enabled = true
count = 7
list = [ "a", "b" ]
[[files]]
file = "mods/a.pw.toml"
metafile = true
[[files]]
file = "mods/b.pw.toml"
metafile = true
`);
  assert.equal(tomlString(doc, 'literal'), 'no \\escapes here');
  assert.equal(tomlString(doc, 'enabled'), null, 'boolean is not a string');
  const index = tomlTable(doc, 'files');
  void index;
  const files = doc.files;
  assert.ok(Array.isArray(files));
  assert.equal(files.length, 2);
  assert.equal((files[0] as Record<string, unknown>).file, 'mods/a.pw.toml');
});

test('parseToml: unsupported syntax fails closed instead of half-parsing', () => {
  assert.throws(() => parseToml('key = """multi\nline"""'), TomlParseError);
  assert.throws(() => parseToml('key = { a = 1 }'), TomlParseError);
  assert.throws(() => parseToml('not an assignment'), TomlParseError);
  assert.throws(() => parseToml('a = 1\na = 2'), TomlParseError);
});

// ---- packwiz ----

test('packwiz: side mapping is exact and an absent side means both', () => {
  assert.deepEqual(packwizFileSide('client').side, 'unsupported');
  assert.deepEqual(packwizFileSide('server').side, 'required');
  assert.deepEqual(packwizFileSide('both').side, 'required');
  assert.deepEqual(packwizFileSide(null).side, 'required', 'absent side ⇒ both ⇒ required');
  assert.equal(packwizFileSide('weird').side, 'unknown', 'an unrecognised side is never guessed');
});

test('packwiz: loader comes from [versions], most specific first', () => {
  const versionsOf = (toml: string) => tomlTable(parseToml(toml), 'versions');
  assert.deepEqual(packwizLoader(versionsOf('[versions]\nminecraft="1.20.1"\nneoforge="21.1.9"')), { loader: 'neoforge', version: '21.1.9' });
  assert.deepEqual(packwizLoader(versionsOf('[versions]\nminecraft="1.20.1"\nforge="47.2.0"')), { loader: 'forge', version: '47.2.0' });
  assert.deepEqual(packwizLoader(versionsOf('[versions]\nminecraft="1.20.1"')), { loader: 'vanilla', version: null });
});

test('packwiz: detection requires versions.minecraft, not just the filename', () => {
  // A Cargo.toml-style pack.toml must NOT be claimed.
  assert.equal(isValidPackwizPack(parseToml('name = "crate"\n[dependencies]\nserde = "1"')), false);
  assert.equal(isValidPackwizPack(parseToml('name = "x"\n[versions]\nminecraft = "1.20.1"\n[index]\nfile = "index.toml"')), true);
});

test('packwiz: resolves metafiles into a canonical recipe', async () => {
  const archive = fakeArchive({
    'pack.toml': 'name = "Fabric Pack"\npack-format = "packwiz:1.1.0"\n[versions]\nminecraft = "1.20.1"\nfabric = "0.15.0"',
    'index.toml': '[[files]]\nfile = "mods/sodium.pw.toml"\nmetafile = true\n[[files]]\nfile = "mods/lithium.pw.toml"\nmetafile = true',
    'mods/sodium.pw.toml': 'name = "Sodium"\nfilename = "sodium.jar"\nside = "client"\n[download]\nurl = "https://cdn.test/sodium.jar"\nhash-format = "sha512"\nhash = "aa"',
    'mods/lithium.pw.toml': 'name = "Lithium"\nfilename = "lithium.jar"\nside = "both"\n[download]\nurl = "https://cdn.test/lithium.jar"\nhash-format = "sha1"\nhash = "bb"',
  });
  const recipe = await packwizAdapter.resolve({ shape: 'archive', index: archive }, noopIo);
  assert.equal(recipe.formatId, 'packwiz');
  assert.equal(recipe.mc, '1.20.1');
  assert.equal(recipe.loader, 'fabric');
  assert.equal(recipe.loaderVersion, '0.15.0');
  assert.equal(recipe.files.length, 2);
  const sodium = recipe.files.find(file => file.path.endsWith('sodium.jar'));
  const lithium = recipe.files.find(file => file.path.endsWith('lithium.jar'));
  assert.equal(sodium?.side, 'unsupported', 'side="client" must not install on a server');
  assert.equal(lithium?.side, 'required');
  assert.deepEqual(sodium?.source.urls, ['https://cdn.test/sodium.jar']);
  validateRecipe(recipe);
});

test('packwiz: a pack without index.toml fails with a specific reason', async () => {
  // A valid pack.toml (with pack-format) that references index.toml, but the archive is missing it.
  // packwiz is declarative: pack.toml carries no file list, so this is genuinely uninstallable and must say so.
  const archive = fakeArchive({
    'pack.toml': 'name = "x"\npack-format = "packwiz:1.1.0"\n[index]\nfile = "index.toml"\n[versions]\nminecraft = "1.20.1"',
  });
  await assert.rejects(() => packwizAdapter.resolve({ shape: 'archive', index: archive }, noopIo), /has no index\.toml/);
});

// ---- Prism ----

test('prism: requires formatVersion 1 and a components array', () => {
  assert.equal(validateMmcPack({ formatVersion: 1, components: [{ uid: 'net.minecraft', version: '1.20.1' }] }) !== null, true);
  assert.equal(validateMmcPack({ formatVersion: 2, components: [] }), null, 'wrong formatVersion');
  assert.equal(validateMmcPack({ formatVersion: 1, components: [{ uid: 'net.minecraft' }] }), null, 'missing version');
  assert.equal(validateMmcPack({ formatVersion: 1 }), null, 'missing components');
  assert.equal(validateMmcPack(null), null);
});

test('prism: reads runtime from component uids and flags conflicting loaders', () => {
  const forge = readMmcRuntime([
    { uid: 'net.minecraft', version: '1.20.1' },
    { uid: 'net.minecraftforge', version: '47.2.0' },
  ]);
  assert.equal(forge.mc, '1.20.1');
  assert.equal(forge.loader, 'forge');
  assert.equal(forge.loaderVersion, '47.2.0');

  const fabric = readMmcRuntime([
    { uid: 'net.minecraft', version: '1.20.1' },
    { uid: 'net.fabricmc.fabric-loader', version: '0.15.0' },
  ]);
  assert.equal(fabric.loader, 'fabric');

  const conflicting = readMmcRuntime([
    { uid: 'net.minecraft', version: '1.20.1' },
    { uid: 'net.minecraftforge', version: '47.2.0' },
    { uid: 'net.neoforged', version: '21.1.9' },
  ]);
  assert.equal(conflicting.conflicting.length, 2, 'Prism treats these as mutually exclusive');
});

test('prism: resolves and reports that the payload is a converted client instance', async () => {
  const archive = fakeArchive({
    'mmc-pack.json': { formatVersion: 1, components: [{ uid: 'net.minecraft', version: '1.20.1' }, { uid: 'net.minecraftforge', version: '47.2.0' }] },
    'instance.cfg': 'name=My Prism Pack\nInstanceType=OneSix\n',
  });
  const recipe = await prismAdapter.resolve({ shape: 'archive', index: archive }, noopIo);
  assert.equal(recipe.name, 'My Prism Pack');
  assert.equal(recipe.mc, '1.20.1');
  assert.equal(recipe.loader, 'forge');
  assert.ok(recipe.warnings.some(w => w.rule === 'prism.client-instance-as-server'),
    'converting a client instance must be stated, not hidden');
  validateRecipe(recipe);
});

test('prism: a pack with no net.minecraft component fails closed', async () => {
  const archive = fakeArchive({ 'mmc-pack.json': { formatVersion: 1, components: [{ uid: 'net.minecraftforge', version: '47.2.0' }] } });
  await assert.rejects(() => prismAdapter.resolve({ shape: 'archive', index: archive }, noopIo), /no "net\.minecraft" component/);
});

// ---- ATLauncher vs FTB vs vanilla: three files named instance.json ----

test('atlauncher: distinguishes its instance.json from FTB and from the vanilla launcher', () => {
  const atl = { uuid: 'abc', launcher: { name: 'My ATL Pack', version: '1.20.1', loaderVersion: { type: 'forge', version: '47.2.0' } } };
  assert.ok(readAtlInstance(atl), 'ATLauncher instance with a launcher object must be claimed');
  assert.equal(readAtlMc(readAtlInstance(atl)!.launcher), '1.20.1');
  assert.deepEqual(readAtlLoader(readAtlInstance(atl)!.launcher), { loader: 'forge', loaderVersion: '47.2.0' });

  // FTB App instance.json — numeric ids, mcVersion, modLoader. Must NOT be claimed by ATLauncher.
  const ftb = { uuid: 'x', id: 1, versionId: 2, mcVersion: '1.12.2', modLoader: 'forge-14.23.5.2846' };
  assert.equal(readAtlInstance(ftb), null);

  // Vanilla launcher profile file.
  assert.equal(readAtlInstance({ profiles: { abc: {} } }), null);

  // An FTB-shaped object with a launcher key but FTB's own numeric ids must still be rejected.
  assert.equal(readAtlInstance({ id: 5, versionId: 9, mcVersion: '1.19.2', launcher: { name: 'x' } }), null);
});

test('atlauncher: a CurseForge-sourced instance is redirected to the CurseForge path', async () => {
  const archive = fakeArchive({
    'instance.json': { uuid: 'u', launcher: { name: 'CF via ATL', version: '1.20.1', curseForgeManifest: { minecraft: {} } } },
  });
  await assert.rejects(() => atlauncherAdapter.resolve({ shape: 'archive', index: archive }, noopIo), /CurseForge-sourced/);
});

// ---- plain server zip ----

test('serverzip: derives the runtime from real evidence, in documented order', () => {
  const fromVersionJson = readServerZipEvidence(['mods/a.jar', 'version.json'], { id: '1.20.1' });
  assert.equal(fromVersionJson.mc, '1.20.1');
  assert.equal(fromVersionJson.source, 'version.json');

  const fromMaven = readServerZipEvidence(['libraries/net/minecraftforge/forge/1.12.2-14.23.5.2859/forge-1.12.2-14.23.5.2859-universal.jar'], null);
  assert.equal(fromMaven.mc, '1.12.2');
  assert.equal(fromMaven.loader, 'forge');
  assert.equal(fromMaven.loaderVersion, '14.23.5.2859');

  const fromInstaller = readServerZipEvidence(['forge-1.20.1-47.2.0-installer.jar', 'mods/a.jar'], null);
  assert.equal(fromInstaller.mc, '1.20.1');
  assert.equal(fromInstaller.loader, 'forge');
});

test('serverzip: a payload dump with no version evidence yields no mc (so resolve fails closed)', async () => {
  const evidence = readServerZipEvidence(['mods/a.jar', 'config/x.cfg'], null);
  assert.equal(evidence.mc, null);
  const archive = fakeArchive({ 'mods/a.jar': 'x', 'config/x.cfg': 'y' });
  await assert.rejects(() => serverZipAdapter.resolve({ shape: 'archive', index: archive }, noopIo), /does not state its Minecraft version/);
});

test('serverzip: looks like a server archive only when there is payload or a launcher', () => {
  assert.equal(looksLikeServerZip(['mods/a.jar']), true);
  assert.equal(looksLikeServerZip(['libraries/x.jar']), true);
  assert.equal(looksLikeServerZip(['run.sh']), true);
  assert.equal(looksLikeServerZip(['readme.txt']), false);
});

// ---- registry: no mis-detection across the whole fixture corpus ----

test('registry: every format fixture is claimed by exactly the right adapter', async () => {
  const packwizArchive = fakeArchive({
    'pack.toml': 'name = "pw"\npack-format = "packwiz:1.1.0"\n[versions]\nminecraft = "1.20.1"\nfabric = "0.15.0"',
    'index.toml': '[[files]]\nfile = "mods/a.pw.toml"\nmetafile = true',
    'mods/a.pw.toml': 'name = "A"\nfilename = "a.jar"\nside = "both"\n[download]\nurl = "https://cdn.test/a.jar"',
  });
  const prismArchive = fakeArchive({
    'mmc-pack.json': { formatVersion: 1, components: [{ uid: 'net.minecraft', version: '1.20.1' }] },
  });
  const atlArchive = fakeArchive({
    'instance.json': { uuid: 'u', launcher: { name: 'atl', version: '1.20.1' } },
  });
  const ftbArchive = fakeArchive({
    'instance.json': { uuid: 'u', id: 3, versionId: 7, mcVersion: '1.12.2', modLoader: 'forge-1.0' },
  });
  const bareArchive = fakeArchive({ 'mods/a.jar': 'x' });

  assert.equal((await detect(packwizArchive))[0], 'packwiz');
  assert.equal((await detect(prismArchive))[0], 'prism.multimc');
  assert.equal((await detect(atlArchive))[0], 'atlauncher');
  // FTB's instance.json must reach the FTB adapter, not ATLauncher (which is higher priority).
  const ftbCandidates = await detect(ftbArchive);
  assert.deepEqual(ftbCandidates, ['ftb.app'], `FTB instance must not be claimed by ATLauncher: got ${ftbCandidates.join(',')}`);
  assert.equal((await detect(bareArchive))[0], 'plain.serverzip');
});

test('registry: an archive with no recognizable content is refused with evidence', async () => {
  const empty = fakeArchive({ 'readme.txt': 'hello' });
  await assert.rejects(
    () => registry.resolve({ shape: 'archive', index: empty }, noopIo),
    (error: unknown) => /Unrecognized modpack format/.test((error as Error).message),
  );
});

// ---- contract: every produced recipe passes validateRecipe ----

test('contract: packwiz/prism/atlauncher/serverzip recipes all satisfy validateRecipe', async () => {
  const recipes: PackRecipe[] = [
    await packwizAdapter.resolve({
      shape: 'archive', index: fakeArchive({
        'pack.toml': 'name = "pw"\npack-format = "packwiz:1.1.0"\n[versions]\nminecraft = "1.20.1"',
        'index.toml': '[[files]]\nfile = "mods/a.pw.toml"\nmetafile = true',
        'mods/a.pw.toml': 'name = "A"\nfilename = "a.jar"\n[download]\nurl = "https://cdn.test/a.jar"',
      }),
    }, noopIo),
    await prismAdapter.resolve({
      shape: 'archive', index: fakeArchive({ 'mmc-pack.json': { formatVersion: 1, components: [{ uid: 'net.minecraft', version: '1.19.2' }] } }),
    }, noopIo),
    await atlauncherAdapter.resolve({
      shape: 'archive', index: fakeArchive({ 'instance.json': { uuid: 'u', launcher: { name: 'atl', version: '1.16.5', loaderVersion: { type: 'forge', version: '36.2.34' } } } }),
    }, noopIo),
    await serverZipAdapter.resolve({
      shape: 'archive', index: fakeArchive({ 'libraries/net/minecraftforge/forge/1.12.2-14.23.5.2859/x.jar': 'x', 'mods/a.jar': 'y' }),
    }, noopIo),
  ];
  for (const recipe of recipes) {
    validateRecipe(recipe);
    assert.ok(recipe.formatId);
    assert.ok(recipe.resolution.length > 0, 'every recipe must record how it resolved');
  }
});


