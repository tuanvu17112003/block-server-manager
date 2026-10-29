// C5 tests: packwiz as an HTTP tree (acquisition shape C).
//
// Why this exists: the adapter previously DECLARED `shapes: ['archive', 'httpTree']` while implementing only the
// archive half — `detect` returned false for httpTree and `resolve` threw. That is a declaration the registry
// cannot catch, so it is recorded as DV-22. This file pins the real behaviour.
//
// Shape C is how `packwiz-installer` actually works (research §3.9): `pack.toml` then `index.toml` then each
// `*.pw.toml`, all fetched over HTTP — there is no archive to read them out of. Measured on real packs, an
// index can reference 86–126 metafiles, so this is a genuinely different acquisition path, not a convenience.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKWIZ_PACK_FILES,
  discoverPackwizPackFile,
  packwizAdapter,
} from '../../services/adapters/packwiz';
import { AdapterRegistry, validateRecipe } from '../../services/adapters/registry';
import { ADAPTERS } from '../../services/adapters/index';
import type { ArchiveIndex, DetectInput } from '../../services/adapters/types';

const PACK_TOML = 'name = "Tree pack"\npack-format = "packwiz:1.1.0"\n\n[index]\nfile = "index.toml"\nhash-format = "sha256"\nhash = ""\n\n[versions]\nminecraft = "1.20.1"\nfabric = "0.15.11"\n';

function tree(map: Record<string, string>): { baseUrl: string; fetchText: (url: string) => Promise<string | null> } {
  const baseUrl = 'https://pack.example.test/';
  return {
    baseUrl,
    fetchText: async (url: string) => map[url.startsWith(baseUrl) ? url.slice(baseUrl.length) : url] ?? null,
  };
}

const noopIo = { log: (): void => {}, fetchJson: async <T = unknown>(): Promise<T> => ({}) as T };
const registry = new AdapterRegistry(ADAPTERS);

function fakeArchive(files: Record<string, string>): ArchiveIndex {
  const names = Object.keys(files);
  return {
    entries: names.map(name => ({ name, size: 1, isDir: false })),
    names: new Set(names),
    readText: async (name: string) => files[name] ?? null,
    readJson: async <T = unknown>(name: string): Promise<T | null> => {
      const text = files[name];
      if (text === undefined) return null;
      try { return JSON.parse(text) as T; } catch { return null; }
    },
    under: (prefix: string) => names.filter(name => name.toLowerCase().startsWith(prefix.toLowerCase())),
  };
}

// ---- httpTree: detection ----

test('httpTree: detect is true when pack.toml is served', async () => {
  const { baseUrl, fetchText } = tree({ 'pack.toml': PACK_TOML });
  assert.equal(await packwizAdapter.detect({ shape: 'httpTree', baseUrl, fetchText }), true);
});

test('httpTree: detect falls back to modpack.toml (a real pack name measured in doc 20)', async () => {
  // `.app-data` measurement found packs whose file is `modpack.toml`, not `pack.toml`.
  assert.deepEqual([...PACKWIZ_PACK_FILES], ['pack.toml', 'modpack.toml']);
  const { baseUrl, fetchText } = tree({ 'modpack.toml': PACK_TOML.replace('pack.toml', 'modpack.toml') });
  assert.equal(await packwizAdapter.detect({ shape: 'httpTree', baseUrl, fetchText }), true);
});

test('httpTree: detect is false for a tree with neither pack file', async () => {
  const { baseUrl, fetchText } = tree({ 'index.toml': 'hash-format = "sha256"' });
  assert.equal(await packwizAdapter.detect({ shape: 'httpTree', baseUrl, fetchText }), false);
});

test('httpTree: detect never throws on an unreachable tree', async () => {
  const baseUrl = 'https://down.example.test/';
  const fetchText = async (): Promise<string | null> => { throw new Error('ECONNREFUSED'); };
  assert.equal(await packwizAdapter.detect({ shape: 'httpTree', baseUrl, fetchText }), false);
});

// ---- httpTree: resolution ----

test('httpTree: resolve fetches index.toml then each metafile, mapping sides', async () => {
  const { baseUrl, fetchText } = tree({
    'pack.toml': PACK_TOML,
    'index.toml': 'hash-format = "sha256"\n\n[[files]]\nfile = "mods/server.pw.toml"\nmetafile = true\n\n[[files]]\nfile = "mods/client.pw.toml"\nmetafile = true\n',
    'mods/server.pw.toml': 'name = "S"\nfilename = "server.jar"\nside = "both"\n\n[download]\nurl = "https://cdn.test/s.jar"\nhash-format = "sha1"\nhash = ""\n',
    'mods/client.pw.toml': 'name = "C"\nfilename = "client.jar"\nside = "client"\n\n[download]\nurl = "https://cdn.test/c.jar"\nhash-format = "sha1"\nhash = ""\n',
  });
  const recipe = await packwizAdapter.resolve({ shape: 'httpTree', baseUrl, fetchText }, noopIo);
  assert.equal(recipe.formatId, 'packwiz');
  assert.equal(recipe.mc, '1.20.1');
  assert.equal(recipe.loader, 'fabric');
  assert.equal(recipe.loaderVersion, '0.15.11');
  assert.equal(recipe.files.length, 2);
  // packwiz side=client means the file is not for the server; it becomes unsupported, not silently kept.
  const byPath = new Map(recipe.files.map(f => [f.path, f]));
  assert.equal(byPath.get('mods/server.jar')?.side, 'required');
  assert.equal(byPath.get('mods/client.jar')?.side, 'unsupported');
  validateRecipe(recipe);
});

test('httpTree: a missing index.toml fails closed and says why', async () => {
  const { baseUrl, fetchText } = tree({ 'pack.toml': PACK_TOML });
  await assert.rejects(
    () => packwizAdapter.resolve({ shape: 'httpTree', baseUrl, fetchText }, noopIo),
    /has no index\.toml/,
  );
});

test('httpTree: a missing metafile is a per-file warning, not a pack-level failure', async () => {
  const { baseUrl, fetchText } = tree({
    'pack.toml': PACK_TOML,
    'index.toml': 'hash-format = "sha256"\n\n[[files]]\nfile = "mods/gone.pw.toml"\nmetafile = true\n\n[[files]]\nfile = "mods/ok.pw.toml"\nmetafile = true\n',
    'mods/ok.pw.toml': 'name = "OK"\nfilename = "ok.jar"\n\n[download]\nurl = "https://cdn.test/ok.jar"\nhash-format = "sha1"\nhash = ""\n',
  });
  const recipe = await packwizAdapter.resolve({ shape: 'httpTree', baseUrl, fetchText }, noopIo);
  assert.equal(recipe.files.length, 1, 'the reachable metafile must still be planned');
  assert.ok(recipe.warnings.some(w => w.rule === 'packwiz.metafile-missing'));
});

test('httpTree: a metafile with no download URL is reported, never planned as a local path', async () => {
  const { baseUrl, fetchText } = tree({
    'pack.toml': PACK_TOML,
    'index.toml': 'hash-format = "sha256"\n\n[[files]]\nfile = "mods/nourl.pw.toml"\nmetafile = true\n',
    'mods/nourl.pw.toml': 'name = "N"\nfilename = "n.jar"\n',
  });
  const { baseUrl: b2, fetchText: f2 } = tree({
    'pack.toml': PACK_TOML,
    'index.toml': 'hash-format = "sha256"\n\n[[files]]\nfile = "mods/nourl.pw.toml"\nmetafile = true\n\n[[files]]\nfile = "mods/ok.pw.toml"\nmetafile = true\n',
    'mods/nourl.pw.toml': 'name = "N"\nfilename = "n.jar"\n',
    'mods/ok.pw.toml': 'name = "OK"\nfilename = "ok.jar"\n\n[download]\nurl = "https://cdn.test/ok.jar"\nhash-format = "sha1"\nhash = ""\n',
  });
  void baseUrl; void fetchText;
  const recipe = await packwizAdapter.resolve({ shape: 'httpTree', baseUrl: b2, fetchText: f2 }, noopIo);
  assert.ok(recipe.warnings.some(w => w.rule === 'packwiz.metafile-no-url'));
  assert.equal(recipe.files.length, 1);
});

test('httpTree: an empty [[files]] list fails closed rather than producing an empty recipe', async () => {
  const { baseUrl, fetchText } = tree({ 'pack.toml': PACK_TOML, 'index.toml': 'hash-format = "sha256"\n' });
  await assert.rejects(
    () => packwizAdapter.resolve({ shape: 'httpTree', baseUrl, fetchText }, noopIo),
    /empty index\.toml/,
  );
});

test('httpTree: discoverPackwizPackFile reports which pack file was used', async () => {
  const { baseUrl, fetchText } = tree({ 'modpack.toml': 'name = "m"' });
  const found = await discoverPackwizPackFile(baseUrl, fetchText);
  assert.equal(found?.file, 'modpack.toml');
});

// ---- archive half must keep working (no regression from the httpTree work) ----

test('archive: packwiz still resolves a zipped pack after the httpTree work', async () => {
  const archive = fakeArchive({
    'pack.toml': PACK_TOML,
    'index.toml': 'hash-format = "sha256"\n\n[[files]]\nfile = "mods/a.pw.toml"\nmetafile = true\n',
    'mods/a.pw.toml': 'name = "A"\nfilename = "a.jar"\n\n[download]\nurl = "https://cdn.test/a.jar"\nhash-format = "sha1"\nhash = ""\n',
  });
  const recipe = await packwizAdapter.resolve({ shape: 'archive', index: archive }, noopIo);
  assert.equal(recipe.files.length, 1);
  validateRecipe(recipe);
});

test('registry: packwiz claims both an archive and an http tree, and nothing else does', async () => {
  const archive = fakeArchive({
    'pack.toml': PACK_TOML,
    'index.toml': 'hash-format = "sha256"\n\n[[files]]\nfile = "mods/a.pw.toml"\nmetafile = true\n',
    'mods/a.pw.toml': 'name = "A"\nfilename = "a.jar"\n\n[download]\nurl = "https://cdn.test/a.jar"\nhash-format = "sha1"\nhash = ""\n',
  });
  const fromArchive = (await registry.candidates({ shape: 'archive', index: archive } as DetectInput)).map(a => a.id);
  assert.equal(fromArchive[0], 'packwiz');

  const { baseUrl, fetchText } = tree({ 'pack.toml': PACK_TOML });
  const fromTree = (await registry.candidates({ shape: 'httpTree', baseUrl, fetchText } as DetectInput)).map(a => a.id);
  assert.deepEqual(fromTree, ['packwiz'], 'only packwiz declares the httpTree shape');
});
