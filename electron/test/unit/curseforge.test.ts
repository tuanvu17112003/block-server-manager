// CurseForge server-pack metadata inference (WP-4.5 / INST-006): no manifest.json must not mean
// "blank MC/loader". Pure function tests, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot } from '../harness';
import { collectInputs, writeZip } from '../../services/zip';
import { inferServerPackMetadata, inspectStagedZip } from '../../services/installer/curseforge';

test('infers modern Forge from a shipped installer JAR name', () => {
  const inferred = inferServerPackMetadata([
    'mods/example.jar',
    'forge-1.20.1-47.4.0-installer.jar',
    'Install.bat',
  ]);
  assert.deepEqual(inferred, { loader: 'forge', mc: '1.20.1', loaderVersion: '47.4.0' });
});

test('infers NeoForge from a shipped installer JAR name', () => {
  const inferred = inferServerPackMetadata(['neoforge-1.21.1-21.1.265-installer.jar']);
  assert.deepEqual(inferred, { loader: 'neoforge', mc: '1.21.1', loaderVersion: '21.1.265' });
});

test('infers old Forge from the maven library layout', () => {
  const inferred = inferServerPackMetadata([
    'libraries/net/minecraftforge/forge/1.12.2-14.23.5.2860/forge-1.12.2-14.23.5.2860-universal.jar',
  ]);
  assert.deepEqual(inferred, { loader: 'forge', mc: '1.12.2', loaderVersion: '14.23.5.2860' });
});

test('infers Fabric from the launch jar + versioned server jar', () => {
  const inferred = inferServerPackMetadata([
    'fabric-server-launch.jar',
    'server.1.21.1.jar',
  ]);
  assert.deepEqual(inferred, { loader: 'fabric', mc: '1.21.1', loaderVersion: null });
});

test('returns null when the archive carries no recognisable metadata', () => {
  assert.equal(inferServerPackMetadata(['mods/a.jar', 'config/x.toml']), null);
});

// ---- prebuilt packs must not be rejected as "blank metadata" (route-A regression) ----

test('inspectStagedZip: a prebuilt Forge pack infers MC from libraries/ instead of staying blank', async () => {
  const temp = tempRoot('msm-unit-cf-inspect');
  try {
    const src = path.join(temp.root, 'src');
    fs.mkdirSync(path.join(src, 'mods'), { recursive: true });
    fs.mkdirSync(path.join(src, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.4.23'), { recursive: true });
    fs.mkdirSync(path.join(src, 'libraries', 'net', 'minecraft', 'server', '1.20.1'), { recursive: true });
    fs.writeFileSync(path.join(src, 'mods', 'a.jar'), 'jar');
    fs.writeFileSync(path.join(src, 'run.bat'), 'java @user_jvm_args.txt');
    fs.writeFileSync(path.join(src, 'user_jvm_args.txt'), '-Xmx4G');
    fs.writeFileSync(
      path.join(src, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.4.23', 'forge-1.20.1-47.4.23-server.jar'),
      'jar',
    );
    const zip = path.join(temp.root, 'prebuilt.zip');
    await writeZip(zip, await collectInputs(src, ['mods', 'libraries', 'run.bat', 'user_jvm_args.txt']));

    const inspected = await inspectStagedZip(zip);
    assert.equal(inspected.classification, 'supportedServerPack');
    assert.equal(inspected.minecraftVersion, '1.20.1');
    assert.equal(inspected.loader, 'Forge');
  } finally {
    temp.cleanup();
  }
});

test('inspectStagedZip: a prebuilt pack with only a versioned server jar still infers MC', async () => {
  const temp = tempRoot('msm-unit-cf-inspect-vanilla');
  try {
    const src = path.join(temp.root, 'src');
    fs.mkdirSync(path.join(src, 'libraries', 'net', 'minecraft', 'server', '1.20.1'), { recursive: true });
    fs.mkdirSync(path.join(src, 'run'), { recursive: true });
    fs.writeFileSync(path.join(src, 'libraries', 'net', 'minecraft', 'server', '1.20.1', 'server-1.20.1.jar'), 'jar');
    fs.writeFileSync(path.join(src, 'run', 'run.bat'), 'java -jar server.jar');
    const zip = path.join(temp.root, 'prebuilt2.zip');
    await writeZip(zip, await collectInputs(src, ['libraries', 'run']));

    const inspected = await inspectStagedZip(zip);
    assert.equal(inspected.minecraftVersion, '1.20.1');
  } finally {
    temp.cleanup();
  }
});
