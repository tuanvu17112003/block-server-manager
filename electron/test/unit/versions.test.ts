// ADR-0007 full version catalogue unit tests (WP-3.1).
// Pure mappers are tested with inline fixtures that mirror the live provider payloads verified on
// 2026-10-26; the network wrappers are exercised with a stubbed global fetch (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORGE_SPECIFIC_LIMIT,
  compareVersionsDesc,
  isNeoForgeLegacyMc,
  isSnapshotLikeVersion,
  loadersResolve,
  mapFabricLoaders,
  mapForgeCatalogue,
  mapNeoForgeCatalogue,
  mapPaperVersions,
  mapVanillaVersions,
  neoforgeFamilyPrefix,
  parseMavenVersions,
  validateLoaderPin,
  type LoaderChoiceDto,
} from '../../services/versions';
import { neoforgeInstallerCandidates } from '../../services/installer/core';

const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

/** Route fetchOk calls to inline fixtures; anything unstubbed fails closed (404). */
function stubCatalogueFetch(routes: Record<string, () => Response>): { calls: string[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    for (const [needle, make] of Object.entries(routes)) {
      if (url.includes(needle)) return make();
    }
    return new Response(`unstubbed ${url}`, { status: 404 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

// ---------- Vanilla ----------

test('mapVanillaVersions: keeps release+snapshot with their type, never old_beta/old_alpha', () => {
  const manifest = {
    latest: { release: '26.3', snapshot: '26.4-snapshot-5' },
    versions: [
      { id: '26.4-snapshot-5', type: 'snapshot', releaseTime: '2026-10-20T10:00:00+00:00', url: 'https://x' },
      { id: '26.3', type: 'release', releaseTime: '2026-10-10T10:00:00+00:00' },
      { id: '1.21.4', type: 'release', releaseTime: '2024-12-03T10:00:00+00:00' },
      { id: 'b1.7.3', type: 'old_beta', releaseTime: '2011-07-08T00:00:00+00:00' },
      { id: 'a1.2.6', type: 'old_alpha', releaseTime: '2010-12-02T00:00:00+00:00' },
      { id: '26.3', type: 'release' }, // duplicate id is dropped
      { id: '', type: 'release' },
      'garbage',
    ],
  };
  const versions = mapVanillaVersions(manifest);
  assert.deepEqual(versions.map((version) => version.id), ['26.4-snapshot-5', '26.3', '1.21.4']);
  assert.deepEqual(versions.map((version) => version.versionType), ['snapshot', 'release', 'release']);
  assert.equal(versions[0].releaseTime, '2026-10-20T10:00:00+00:00');
  assert.ok(!versions.some((version) => version.id.startsWith('b1.') || version.id.startsWith('a1.')));
  assert.deepEqual(mapVanillaVersions(null), []);
});

// ---------- Paper ----------

test('mapPaperVersions: 1.21.1 stays a release (UNSUPPORTED is advisory), pre/rc ids are snapshots', () => {
  const fill = {
    versions: [
      { version: { id: '26.3', support: { status: 'SUPPORTED' } }, builds: [223, 222] },
      { version: { id: '1.21.1', support: { status: 'UNSUPPORTED' } }, builds: Array.from({ length: 128 }, (_, index) => index) },
      { version: { id: '1.21.11-rc3', support: { status: 'UNSUPPORTED' } }, builds: [31, 30] },
      { version: { id: '1.21.11-pre5', support: { status: 'UNSUPPORTED' } }, builds: [14] },
      { version: { id: '26.2-rc-2', support: { status: 'UNSUPPORTED' } }, builds: [2] },
      { version: { id: '26.4-snapshot-5', support: { status: 'UNSUPPORTED' } }, builds: [] },
    ],
  };
  const versions = mapPaperVersions(fill);
  const byId = new Map(versions.map((version) => [version.id, version]));
  assert.equal(byId.get('1.21.1')?.versionType, 'release', 'Paper 1.21.1 must not be labelled snapshot');
  assert.equal(byId.get('1.21.1')?.support, 'UNSUPPORTED');
  assert.equal(byId.get('26.3')?.versionType, 'release');
  assert.equal(byId.get('1.21.11-rc3')?.versionType, 'snapshot');
  assert.equal(byId.get('1.21.11-pre5')?.versionType, 'snapshot');
  assert.equal(byId.get('26.2-rc-2')?.versionType, 'snapshot');
  assert.ok(!byId.has('26.4-snapshot-5'), 'a version with no builds is not installable');
  assert.ok(versions.every((version) => version.releaseTime === ''));
  // Bare-array payload tolerance (older Fill shape) and malformed entries.
  assert.equal(mapPaperVersions([{ version: { id: '1.21.4', support: { status: 'UNSUPPORTED' } }, builds: [1] }]).length, 1);
  assert.deepEqual(mapPaperVersions('garbage'), []);
  assert.equal(isSnapshotLikeVersion('1.21.11-rc3'), true);
  assert.equal(isSnapshotLikeVersion('1.21.11'), false);
});

// ---------- Fabric ----------

test('mapFabricLoaders: all loader versions, stable first, provider order preserved inside a group', () => {
  const fabric = [
    { loader: { version: '0.20.0', stable: false } },
    { loader: { version: '0.20.1', stable: true } },
    { loader: { version: '0.19.5', stable: false } },
    { version: '0.18.0', stable: true }, // flat `/v2/versions/loader` shape
    { loader: { version: '0.19.5', stable: false } }, // duplicate
    { loader: { version: '', stable: true } },
    'garbage',
  ];
  const loaders = mapFabricLoaders(fabric);
  assert.deepEqual(loaders.map((loader) => loader.version), ['0.20.1', '0.18.0', '0.20.0', '0.19.5']);
  assert.deepEqual(loaders.map((loader) => loader.stable), [true, true, false, false]);
  assert.deepEqual(mapFabricLoaders(null), []);
});

// ---------- Forge ----------

test('mapForgeCatalogue: promoted builds first (bare versions), full catalogue capped and non-stable', () => {
  const builds = Array.from({ length: 25 }, (_, index) => `1.21.1-52.1.${index}`);
  const promotions = { promos: { '1.21.1-recommended': '52.1.20', '1.21.1-latest': '52.1.24', '1.20.1-recommended': '47.4.28' } };
  const catalogue = { '1.21.1': builds, '1.20.1': ['1.20.1-47.4.28'] };
  const choices = mapForgeCatalogue(promotions, catalogue, '1.21.1');
  assert.equal(choices[0].loader, 'Forge');
  assert.equal(choices[0].version, '52.1.20');
  assert.equal(choices[0].stable, true);
  assert.match(choices[0].label, /recommended/);
  assert.equal(choices[1].version, '52.1.24');
  assert.match(choices[1].label, /latest/);
  const specific = choices.filter((choice) => choice.stable === false);
  assert.equal(specific.length, FORGE_SPECIFIC_LIMIT);
  // Bare build ids only (the installer rebuilds `{mc}-{version}` into the exact catalogue artifact).
  assert.ok(choices.every((choice) => !String(choice.version).startsWith('1.21.1-')));
  assert.match(String(specific[0].label), /specific version/);
  // Recommended/latest are excluded from the specific list and the newest remaining builds come first.
  assert.ok(!specific.some((choice) => choice.version === '52.1.20' || choice.version === '52.1.24'));
  assert.equal(specific[0].version, '52.1.23');
  assert.deepEqual(mapForgeCatalogue(promotions, catalogue, ''), []);
});

test('compareVersionsDesc: numeric segments descending, suffixed builds after the plain build', () => {
  const sorted = ['21.1.80', '21.1.265', '26.3.0.0-beta', '26.3.0.99', '52.1.9', '52.1.20']
    .sort(compareVersionsDesc);
  assert.deepEqual(sorted, ['52.1.20', '52.1.9', '26.3.0.99', '26.3.0.0-beta', '21.1.265', '21.1.80']);
});

// ---------- NeoForge mapping matrix ----------

test('neoforgeFamilyPrefix: documented mapping table only (1.20.1 legacy, 1.20.2+ modern, 26.x full)', () => {
  assert.equal(neoforgeFamilyPrefix('1.20.1'), '1.20.1-47.');
  assert.equal(neoforgeFamilyPrefix('1.20.2'), '20.2.');
  assert.equal(neoforgeFamilyPrefix('1.20.4'), '20.4.');
  assert.equal(neoforgeFamilyPrefix('1.20.6'), '20.6.');
  assert.equal(neoforgeFamilyPrefix('1.21'), '21.0.');
  assert.equal(neoforgeFamilyPrefix('1.21.1'), '21.1.');
  assert.equal(neoforgeFamilyPrefix('1.21.4'), '21.4.');
  assert.equal(neoforgeFamilyPrefix('26.3'), '26.3.');
  assert.equal(neoforgeFamilyPrefix('26.1.2'), '26.1.2.');
  assert.equal(neoforgeFamilyPrefix('26.4-snapshot-5'), null);
  assert.equal(isNeoForgeLegacyMc('1.20.1'), true);
  assert.equal(isNeoForgeLegacyMc('1.20.2'), false);
});

test('mapNeoForgeCatalogue: 1.20.1 uses legacy 1.20.1-47.x only (no modern fallback)', () => {
  const catalogue = {
    legacyVersions: ['1.20.1-47.1.104', '1.20.1-47.1.106', '1.20.1-47.1.105', '47.1.82'],
    modernVersions: ['21.1.265', '20.4.253'],
  };
  const choices = mapNeoForgeCatalogue(catalogue, '1.20.1');
  assert.deepEqual(choices.map((choice) => choice.version), ['1.20.1-47.1.106', '1.20.1-47.1.105', '1.20.1-47.1.104']);
  assert.ok(choices.every((choice) => choice.loader === 'NeoForge' && choice.stable === true));
});

test('mapNeoForgeCatalogue: 1.20.2+/1.21.x use the {minor}.{patch}. modern family', () => {
  const modernVersions = ['20.4.253', '20.4.250', '20.4.0-beta', '21.1.265', '21.1.80', '26.3.0.99'];
  const for1204 = mapNeoForgeCatalogue({ modernVersions }, '1.20.4');
  assert.deepEqual(for1204.map((choice) => choice.version), ['20.4.253', '20.4.250', '20.4.0-beta']);
  assert.equal(for1204[2].stable, false);
  assert.match(String(for1204[2].label), /\(beta\)/);

  const for1211 = mapNeoForgeCatalogue({ modernVersions }, '1.21.1');
  assert.deepEqual(for1211.map((choice) => choice.version), ['21.1.265', '21.1.80']);
  assert.ok(for1211.some((choice) => choice.version === '21.1.265'), 'NeoForge must appear for MC 1.21.1');

  const for121 = mapNeoForgeCatalogue({ modernVersions: ['21.0.167', '21.1.80'] }, '1.21');
  assert.deepEqual(for121.map((choice) => choice.version), ['21.0.167']);
});

test('mapNeoForgeCatalogue: 26.x family is mcVersion + ".", betas labelled but installable', () => {
  const modernVersions = ['26.3.0.0-beta', '26.3.0.99', '26.2.0.93', '26.1.2.124'];
  const for263 = mapNeoForgeCatalogue({ modernVersions }, '26.3');
  assert.deepEqual(for263.map((choice) => choice.version), ['26.3.0.99', '26.3.0.0-beta']);
  assert.equal(for263[0].stable, true);
  assert.equal(for263[1].stable, false);
  assert.match(String(for263[1].label), /\(beta\)/);

  const for2612 = mapNeoForgeCatalogue({ modernVersions }, '26.1.2');
  assert.deepEqual(for2612.map((choice) => choice.version), ['26.1.2.124']);
  assert.deepEqual(mapNeoForgeCatalogue({ modernVersions }, '26.4-snapshot-5'), []);
});

test('parseMavenVersions: extracts every <version> from a metadata XML document', () => {
  const xml = '<metadata><versioning><versions><version>21.1.265</version><version> 21.1.80 </version><version></version></versions></versioning></metadata>';
  assert.deepEqual(parseMavenVersions(xml), ['21.1.265', '21.1.80']);
  assert.deepEqual(parseMavenVersions(''), []);
});

// ---------- NeoForge installer coordinates ----------

test('neoforgeInstallerCandidates: legacy 1.20.1 vs modern full-version artifact URLs', () => {
  const legacy = neoforgeInstallerCandidates('1.20.1', '47.1.106');
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].artifact, 'forge');
  assert.equal(legacy[0].mavenVersion, '1.20.1-47.1.106');
  assert.equal(legacy[0].url, 'https://maven.neoforged.net/releases/net/neoforged/forge/1.20.1-47.1.106/forge-1.20.1-47.1.106-installer.jar');
  assert.equal(legacy[0].name, 'neoforge-legacy-1.20.1-47.1.106-installer.jar');
  // Persisted full legacy pins are accepted unchanged.
  assert.deepEqual(neoforgeInstallerCandidates('1.20.1', '1.20.1-47.1.106'), legacy);

  const modern = neoforgeInstallerCandidates('1.21.1', '21.1.80');
  assert.equal(modern.length, 1);
  assert.equal(modern[0].artifact, 'neoforge');
  assert.equal(modern[0].url, 'https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.80/neoforge-21.1.80-installer.jar');
  assert.equal(modern[0].name, 'neoforge-21.1.80-installer.jar');
  assert.ok(!modern[0].url.includes('1.21.1-21.1.80'), 'modern NeoForge must not carry the MC prefix');

  const modern26 = neoforgeInstallerCandidates('26.3', '26.3.0.99');
  assert.equal(modern26[0].url, 'https://maven.neoforged.net/releases/net/neoforged/neoforge/26.3.0.99/neoforge-26.3.0.99-installer.jar');

  // Legacy-form pin passed for a modern MC is normalised to the modern coordinate.
  assert.equal(neoforgeInstallerCandidates('1.21.1', '1.21.1-21.1.80')[0].mavenVersion, '21.1.80');
  assert.deepEqual(neoforgeInstallerCandidates('1.21.1', ''), []);
  assert.deepEqual(neoforgeInstallerCandidates('', '21.1.80'), []);
});

// ---------- validateLoaderPin ----------

const PIN_CHOICES: LoaderChoiceDto[] = [
  { loader: 'Vanilla', version: null, label: 'Vanilla 1.21.1', stable: true },
  { loader: 'Paper', version: '133', label: 'Paper build 133 (STABLE)', stable: true },
  { loader: 'Fabric', version: '0.20.1', label: 'Fabric Loader 0.20.1', stable: true },
  { loader: 'Fabric', version: '0.20.0', label: 'Fabric Loader 0.20.0 (non-stable)', stable: false },
  { loader: 'Forge', version: '52.1.20', label: 'Forge 52.1.20 (recommended)', stable: true },
  { loader: 'NeoForge', version: '21.1.265', label: 'NeoForge 21.1.265', stable: true },
];

test('validateLoaderPin: accepts exact catalogue pins and empty pins, rejects arbitrary values', () => {
  const ok = (loader: string, pin: string | null) => validateLoaderPin(loader, '1.21.1', pin, PIN_CHOICES).ok;
  assert.equal(ok('Vanilla', null), true);
  assert.equal(ok('Vanilla', '1.21.1'), true);
  assert.equal(ok('paper', '133'), true);
  assert.equal(ok('Fabric', '0.20.1'), true);
  assert.equal(ok('Fabric', '0.20.0'), true, 'non-stable catalogue builds are installable pins');
  assert.equal(ok('Forge', '52.1.20'), true);
  assert.equal(ok('NeoForge', '21.1.265'), true);
  // Empty pin means "no pin" (provider default/latest).
  assert.equal(ok('Paper', ''), true);
  assert.equal(ok('NeoForge', null), true);

  const rejected = (loader: string, pin: string | null, choices: LoaderChoiceDto[] = PIN_CHOICES) => {
    const result = validateLoaderPin(loader, '1.21.1', pin, choices);
    assert.equal(result.ok, false, `${loader} ${pin} should be rejected`);
    assert.ok(typeof result.message === 'string' && result.message.length > 0);
  };
  rejected('Paper', '1.21.1'); // old UI sent the MC version as the Paper "version"
  rejected('NeoForge', '1.21.1-21.1.265');
  rejected('Fabric', '0.19.9');
  rejected('Forge', '52.0.0');
  rejected('Vanilla', 'nonsense');
  rejected('Quilt', '1.0'); // not a supported loader
  rejected('NeoForge', '21.1.265', []); // catalogue unavailable -> fail closed
});

test('validateLoaderPin: a real NeoForge catalogue pin round-trips for legacy and modern MCs', () => {
  const legacyChoices = mapNeoForgeCatalogue({ legacyVersions: ['1.20.1-47.1.105', '1.20.1-47.1.106'] }, '1.20.1');
  assert.equal(validateLoaderPin('NeoForge', '1.20.1', '1.20.1-47.1.106', legacyChoices).ok, true);
  assert.equal(validateLoaderPin('NeoForge', '1.20.1', '1.20.1-47.1.104', legacyChoices).ok, false);
  const modernChoices = mapNeoForgeCatalogue({ modernVersions: ['21.1.80', '21.1.265'] }, '1.21.1');
  assert.equal(validateLoaderPin('neoforge', '1.21.1', '21.1.265', modernChoices).ok, true);
});

// ---------- loadersResolve (stubbed provider endpoints) ----------

const PAPER_BUILD = {
  id: 133,
  time: '2025-06-09T10:18:55.778Z',
  channel: 'STABLE',
  downloads: {
    'server:default': {
      name: 'paper-1.21.1-133.jar',
      url: 'https://fill-data.papermc.io/v1/objects/abc/paper-1.21.1-133.jar',
      size: 51_000_000,
      checksums: { sha256: 'a'.repeat(64) },
    },
  },
};
const FABRIC_FIXTURE = [
  { loader: { version: '0.20.0', stable: false } },
  { loader: { version: '0.20.1', stable: true } },
];
const FORGE_PROMOTIONS_FIXTURE = { promos: { '1.21.1-recommended': '52.1.20', '1.21.1-latest': '52.1.20' } };
const FORGE_CATALOGUE_FIXTURE = { '1.21.1': ['1.21.1-52.1.20', '1.21.1-52.1.19', '1.21.1-52.1.18'] };
const NEOFORGE_XML_FIXTURE = '<metadata><versioning><versions>'
  + '<version>21.1.265</version><version>21.1.80</version><version>21.0.167</version>'
  + '</versions></versioning></metadata>';

function baseRoutes(overrides: Record<string, () => Response> = {}): Record<string, () => Response> {
  return {
    'fill.papermc.io/v3/projects/paper/versions/1.21.1/builds': () => json([PAPER_BUILD]),
    'meta.fabricmc.net/v2/versions/loader/1.21.1': () => json(FABRIC_FIXTURE),
    'files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json': () => json(FORGE_PROMOTIONS_FIXTURE),
    'files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json': () => json(FORGE_CATALOGUE_FIXTURE),
    'maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml': () => new Response(NEOFORGE_XML_FIXTURE, { status: 200 }),
    ...overrides,
  };
}

test('loadersResolve("1.21.1"): full catalogue incl. Paper STABLE build id and NeoForge 21.1.x', async () => {
  const stub = stubCatalogueFetch(baseRoutes());
  try {
    const choices = await loadersResolve('1.21.1');
    assert.equal(choices[0].loader, 'Vanilla');
    assert.equal(choices[0].version, null);
    const paper = choices.filter((choice) => choice.loader === 'Paper');
    assert.deepEqual(paper, [{ loader: 'Paper', version: '133', label: 'Paper build 133 (STABLE)', stable: true }]);
    const fabric = choices.filter((choice) => choice.loader === 'Fabric');
    assert.deepEqual(fabric.map((choice) => choice.version), ['0.20.1', '0.20.0']);
    assert.deepEqual(fabric.map((choice) => choice.stable), [true, false]);
    assert.match(String(fabric[1].label), /\(non-stable\)$/);
    const forge = choices.filter((choice) => choice.loader === 'Forge');
    assert.equal(forge[0].version, '52.1.20');
    assert.match(String(forge[0].label), /recommended/);
    const neo = choices.filter((choice) => choice.loader === 'NeoForge');
    assert.deepEqual(neo.map((choice) => choice.version), ['21.1.265', '21.1.80']);
    assert.equal(neo[0].stable, true);
    // Fixed provider order; stable-first ordering inside each provider.
    const order = choices.map((choice) => choice.loader).filter((loader, index, all) => all.indexOf(loader) === index);
    assert.deepEqual(order, ['Vanilla', 'Paper', 'Fabric', 'Forge', 'NeoForge']);
  } finally {
    stub.restore();
  }
});

test('loadersResolve: Paper is omitted when no STABLE artifact-complete build exists (and on 404)', async () => {
  // ALPHA-only builds (e.g. 1.21.11-rc3): no STABLE build -> no Paper choice.
  const alphaOnly = { ...PAPER_BUILD, id: 31, channel: 'ALPHA' };
  const stub = stubCatalogueFetch(baseRoutes({
    'fill.papermc.io/v3/projects/paper/versions/1.21.1/builds': () => json([alphaOnly]),
  }));
  try {
    const choices = await loadersResolve('1.21.1');
    assert.ok(!choices.some((choice) => choice.loader === 'Paper'), 'Paper must be omitted without a STABLE build');
    // The other provider sections still resolve.
    assert.ok(choices.some((choice) => choice.loader === 'NeoForge'));
  } finally {
    stub.restore();
  }
  const missing = stubCatalogueFetch(baseRoutes({
    'fill.papermc.io/v3/projects/paper/versions/1.21.1/builds': () => new Response('{"ok":false}', { status: 404 }),
  }));
  try {
    const choices = await loadersResolve('1.21.1');
    assert.ok(!choices.some((choice) => choice.loader === 'Paper'));
  } finally {
    missing.restore();
  }
});
