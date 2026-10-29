// CurseForge server-pack metadata inference (WP-4.5 / INST-006): no manifest.json must not mean
// "blank MC/loader". Pure function tests, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot } from '../harness';
import { collectInputs, writeZip } from '../../services/zip';
import { inferServerPackMetadata, inspectStagedZip, pickMinecraftVersion } from '../../services/installer/curseforge';

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

// ---- matrix-run regressions (found by the live 12-pack sweep) ----

test('pickMinecraftVersion: CF multi-tag files resolve to the author target, not the first tag', () => {
  // DawnCraft 2.0.16_hf lists 1.18.1/1.18/Forge/1.18.2/1.18-Snapshot; the first numeric tag (1.18.1)
  // installed the wrong Forge and the server died with ClassNotFoundException: JarInJarDependencyLocator.
  assert.equal(pickMinecraftVersion(['1.18.1', '1.18', 'Forge', '1.18.2', '1.18-Snapshot']), '1.18.2');
  assert.equal(pickMinecraftVersion(['1.20.1', 'Forge', '1.20']), '1.20.1');
  assert.equal(pickMinecraftVersion(['Forge', '1.12.2']), '1.12.2');
  assert.equal(pickMinecraftVersion(['1.21.1', 'Fabric']), '1.21.1');
  assert.equal(pickMinecraftVersion([]), null);
  assert.equal(pickMinecraftVersion(undefined), null);
});

test('inspectStagedZip: a nested-ZIP wrapper is unwrapped instead of rejected', async () => {
  // Prominence II CF delivers "…server_pack.zip" inside "466901-server-*.zip" plus a readme.
  const temp = tempRoot('msm-unit-cf-nested');
  try {
    const inner = path.join(temp.root, 'inner');
    fs.mkdirSync(path.join(inner, 'mods'), { recursive: true });
    fs.mkdirSync(path.join(inner, 'libraries'), { recursive: true });
    fs.writeFileSync(path.join(inner, 'mods', 'a.jar'), 'jar');
    fs.writeFileSync(path.join(inner, 'run.bat'), 'java @user_jvm_args.txt');
    fs.writeFileSync(path.join(inner, 'user_jvm_args.txt'), '-Xmx4G');
    fs.writeFileSync(path.join(inner, 'libraries', 'x.txt'), 'x');
    const innerZip = path.join(temp.root, 'ServerPack.zip');
    await writeZip(innerZip, await collectInputs(inner, ['mods', 'run.bat', 'user_jvm_args.txt', 'libraries']));

    // Outer wrapper: exactly one .zip plus a harmless readme.
    const outer = path.join(temp.root, 'outer');
    fs.mkdirSync(outer, { recursive: true });
    fs.copyFileSync(innerZip, path.join(outer, 'ServerPack.zip'));
    fs.writeFileSync(path.join(outer, 'readme.txt'), 'server pack');
    const outerZip = path.join(temp.root, '466901-server.zip');
    await writeZip(outerZip, await collectInputs(outer, ['ServerPack.zip', 'readme.txt']));

    const inspected = await inspectStagedZip(outerZip);
    assert.equal(inspected.classification, 'supportedServerPack');
    assert.ok(String(inspected.reason).includes('unwrapped from nested ZIP'), inspected.reason);
  } finally {
    temp.cleanup();
  }
});

test('inspectStagedZip: ServerPackCreator manifest.json is not mistaken for a CurseForge manifest', async () => {
  // SPC packs ship a manifest.json that is a flat file list; reading minecraft.modLoaders threw a
  // TypeError and aborted the install instead of falling through to layout detection.
  const temp = tempRoot('msm-unit-cf-spc');
  try {
    const src = path.join(temp.root, 'src');
    fs.mkdirSync(path.join(src, 'mods'), { recursive: true });
    fs.mkdirSync(path.join(src, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.4.23'), { recursive: true });
    fs.writeFileSync(path.join(src, 'mods', 'a.jar'), 'jar');
    fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify({ files: ['config', 'mods/a.jar'] }));
    fs.writeFileSync(path.join(src, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.4.23', 'forge-1.20.1-47.4.23-server.jar'), 'jar');
    const zip = path.join(temp.root, 'spc.zip');
    await writeZip(zip, await collectInputs(src, ['mods', 'manifest.json', 'libraries']));

    const inspected = await inspectStagedZip(zip);
    // Falls through to server-pack detection instead of crashing or claiming clientExport.
    assert.notEqual(inspected.classification, 'clientExport');
    assert.equal(inspected.minecraftVersion, '1.20.1');
    assert.equal(inspected.loader, 'Forge');
  } finally {
    temp.cleanup();
  }
});
