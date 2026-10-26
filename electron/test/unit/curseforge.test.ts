// CurseForge server-pack metadata inference (WP-4.5 / INST-006): no manifest.json must not mean
// "blank MC/loader". Pure function tests, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferServerPackMetadata } from '../../services/installer/curseforge';

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
