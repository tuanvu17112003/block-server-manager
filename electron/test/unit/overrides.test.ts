// WP-4.6 override-layer tests: downloaded pack files win, server-overrides beat overrides,
// user-excluded / curated mods are never re-added, client-overrides are ignored, and manager-owned
// eula.txt/server.properties are never installed from archive overrides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collectInputs, writeZip } from '../../services/zip';
import { applyModrinthOverrides, resolveModrinthFilePolicy, type MrIndex } from '../../services/installer/modrinth';
import { tempRoot } from '../harness';

const MODRINTH_INDEX: MrIndex = {
  formatVersion: 1,
  game: 'minecraft',
  versionId: 'fixture-1',
  name: 'Fixture Pack',
  dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.14' },
  files: [
    { path: 'mods/user-excluded.jar', hashes: {}, downloads: ['https://cdn.modrinth.com/data/user.jar'], fileSize: 1, env: { server: 'optional' } },
    { path: 'mods/unsupported.jar', hashes: {}, downloads: ['https://cdn.modrinth.com/data/unsupported.jar'], fileSize: 1, env: { server: 'required' } },
    { path: 'config/b.toml', hashes: {}, downloads: ['https://cdn.modrinth.com/data/b.toml'], fileSize: 1 },
  ],
};

const FIXTURE_FILES: Record<string, string> = {
  'overrides/config/a.toml': 'base-a',
  'overrides/config/b.toml': 'base-b',
  'overrides/mods/keep.jar': 'base-keep',
  'overrides/mods/overridden.jar': 'base-overridden',
  'overrides/mods/user-excluded.jar': 'base-user-excluded',
  'overrides/mods/unsupported.jar': 'base-unsupported',
  'overrides/eula.txt': 'eula=true',
  'server-overrides/config/a.toml': 'server-a',
  'server-overrides/mods/overridden.jar': 'server-overridden',
  'server-overrides/mods/user-excluded.jar': 'server-user-excluded',
  'server-overrides/server.properties': 'server-port=9999',
  'client-overrides/mods/client-only.jar': 'client-only',
};

async function makeFixture(): Promise<{ root: string; mrpackPath: string; dir: string; cleanup: () => void }> {
  const temp = tempRoot('msm-unit-overrides');
  const src = path.join(temp.root, 'src');
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    const target = path.join(src, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const inputs = await collectInputs(src, ['overrides', 'server-overrides', 'client-overrides']);
  const mrpackPath = path.join(temp.root, 'fixture.mrpack');
  await writeZip(mrpackPath, inputs);
  // The downloaded pack file is placed by the engine before overrides are applied.
  const dir = path.join(temp.root, 'server');
  fs.mkdirSync(path.dirname(path.join(dir, 'config', 'b.toml')), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'b.toml'), 'downloaded-pack-file');
  return { root: temp.root, mrpackPath, dir, cleanup: temp.cleanup };
}

function read(dir: string, rel: string): string | null {
  try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return null; }
}

test('resolveModrinthFilePolicy: explicit reviewed-plan Include wins over curated exclusions (WP-4.5)', () => {
  // Curated L4 unsupported: the default policy excludes the file...
  const excluded = resolveModrinthFilePolicy({ declared: 'required', curated: 'unsupported', userIncluded: false, why: 'curated global exclude' });
  assert.equal(excluded.action, 'skip-unsupported');
  // ...but an explicit Include from the reviewed plan must install it, with a visible warning.
  const included = resolveModrinthFilePolicy({ declared: 'required', curated: 'unsupported', userIncluded: true, why: 'curated global exclude' });
  assert.equal(included.action, 'install');
  assert.match(String(included.warning), /included per reviewed plan despite curated exclusion/);
  // Optional files follow the user's include/exclude choice.
  assert.equal(resolveModrinthFilePolicy({ declared: 'optional', curated: 'optional', userIncluded: false }).action, 'skip-optional');
  assert.equal(resolveModrinthFilePolicy({ declared: 'optional', curated: 'optional', userIncluded: true }).action, 'install');
  assert.equal(resolveModrinthFilePolicy({ declared: 'required', curated: 'required', userIncluded: false }).action, 'install');
  // Unknown curated policy falls back to the declared mrpack environment.
  assert.equal(resolveModrinthFilePolicy({ declared: 'optional', curated: 'bogus', userIncluded: false }).action, 'skip-optional');
});

test('applyModrinthOverrides: layering, protected paths, client-overrides ignored, exclusions honoured', async () => {
  const fixture = await makeFixture();
  try {
    const result = await applyModrinthOverrides({
      mrpackPath: fixture.mrpackPath,
      dir: fixture.dir,
      index: MODRINTH_INDEX,
      includeOptional: () => false, // user chose to exclude the optional mod
      excludeFn: rel => rel === 'mods/unsupported.jar', // curated/server-unsupported
    });

    // server-overrides/ is applied after overrides/ and wins; both beat downloaded files only never.
    assert.equal(read(fixture.dir, 'config/a.toml'), 'server-a');
    assert.equal(read(fixture.dir, 'mods/overridden.jar'), 'server-overridden');
    assert.equal(read(fixture.dir, 'mods/keep.jar'), 'base-keep');
    // Downloaded pack files win over archive overrides.
    assert.equal(read(fixture.dir, 'config/b.toml'), 'downloaded-pack-file');
    // User-excluded optional mods and curated-unsupported mods must not come back from overrides.
    assert.equal(read(fixture.dir, 'mods/user-excluded.jar'), null);
    assert.equal(read(fixture.dir, 'mods/unsupported.jar'), null);
    // client-overrides/ is client-only.
    assert.equal(read(fixture.dir, 'mods/client-only.jar'), null);
    // Manager-owned files are never installed from archive overrides.
    assert.equal(read(fixture.dir, 'eula.txt'), null);
    assert.equal(read(fixture.dir, 'server.properties'), null);

    assert.ok(result.written > 0, 'no override files were written');
    const warnings = result.warnings.join('\n');
    assert.match(warnings, /client-overrides\/ ignored/);
    assert.match(warnings, /eula\.txt: ignored from archive overrides \(manager-owned\)/);
    assert.match(warnings, /server\.properties: ignored from archive overrides \(manager-owned\)/);
    assert.match(warnings, /archive override ignored \(pack file wins\): config\/b\.toml/);
    assert.match(warnings, /user-excluded/);
  } finally {
    fixture.cleanup();
  }
});

test('applyModrinthOverrides: a user-included optional mod keeps the downloaded pack file (overrides never clobber it)', async () => {
  const fixture = await makeFixture();
  try {
    // The engine downloads the user-included optional mod before overrides are applied.
    fs.mkdirSync(path.join(fixture.dir, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(fixture.dir, 'mods', 'user-excluded.jar'), 'downloaded-user-jar');
    await applyModrinthOverrides({
      mrpackPath: fixture.mrpackPath,
      dir: fixture.dir,
      index: MODRINTH_INDEX,
      includeOptional: () => true, // user opted in
      excludeFn: () => false,
    });
    // Pack files win over every archive override layer.
    assert.equal(read(fixture.dir, 'mods/user-excluded.jar'), 'downloaded-user-jar');
    assert.equal(read(fixture.dir, 'mods/unsupported.jar'), null, 'required pack file is not injected from overrides');
    assert.equal(read(fixture.dir, 'config/a.toml'), 'server-a');
  } finally {
    fixture.cleanup();
  }
});

test('applyModrinthOverrides: repeated extraction is idempotent and case-insensitive paths do not duplicate', async () => {
  const fixture = await makeFixture();
  try {
    await applyModrinthOverrides({ mrpackPath: fixture.mrpackPath, dir: fixture.dir, index: MODRINTH_INDEX, includeOptional: () => false, excludeFn: () => false });
    await applyModrinthOverrides({ mrpackPath: fixture.mrpackPath, dir: fixture.dir, index: MODRINTH_INDEX, includeOptional: () => false, excludeFn: () => false });
    const entries = fs.readdirSync(path.join(fixture.dir, 'mods')).map(name => name.toLowerCase());
    assert.equal(new Set(entries).size, entries.length, 'case-insensitive duplicates appeared after re-apply');
    assert.equal(read(fixture.dir, 'config/a.toml'), 'server-a');
  } finally {
    fixture.cleanup();
  }
});
