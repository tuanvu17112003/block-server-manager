// Publish left by an interrupted install: recover it or clear it, never leave it invisible.
//
// This test was written after inspecting a real machine where three failed installs had left four
// `<serverId>.publishing-<uuid>` folders, 106-112 MB each. Nothing showed them in the UI and nothing ever deleted them —
// roughly 430 MB of orphaned server copies, and in three of the four cases the copy was COMPLETE and only the final
// rename had failed. Those installs had been abandoned as failures while the data was sitting on disk.
//
// Two outcomes are correct and they differ:
//   - final folder absent  -> the tree is complete, rename it into place (recover a successful install)
//   - final folder present -> the leftover is stale, delete it (reclaim the space)
//
// Deleting in the first case would destroy work the user waited minutes for. Renaming in the second would collide with a
// real server. Getting the condition backwards is the whole risk, so both branches are pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoverInterruptedPublishes, publishStagedDirectory } from '../../services/install-transaction';

function makeServersRoot(): { base: string; serversDir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-recover-'));
  const serversDir = path.join(base, 'servers');
  fs.mkdirSync(serversDir, { recursive: true });
  return { base, serversDir };
}

function makeLeftover(serversDir: string, serverId: string): string {
  const name = `${serverId}.publishing-11111111-2222-3333-4444-555555555555`;
  const dir = path.join(serversDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.jar'), 'jar-bytes');
  fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=test');
  return dir;
}

test('a complete leftover with no final folder is RECOVERED, not deleted', () => {
  // This is the case that matters most: the install actually succeeded as far as the data goes, and the user was told it
  // failed. Deleting here would throw away a finished server.
  const { base, serversDir } = makeServersRoot();
  const serverId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const leftover = makeLeftover(serversDir, serverId);
  try {
    // A record exists, so the recovered folder will be visible in the UI.
    const result = recoverInterruptedPublishes(base, (id) => id === serverId);
    assert.equal(result.recovered.length, 1, 'the leftover must be recovered');
    assert.equal(result.removed.length, 0, 'it must not be deleted');
    assert.equal(fs.existsSync(leftover), false, 'the leftover directory is consumed by the rename');
    assert.equal(fs.existsSync(path.join(serversDir, serverId, 'server.jar')), true, 'the files must now be in place');
    assert.equal(fs.readFileSync(path.join(serversDir, serverId, 'server.properties'), 'utf8'), 'motd=test');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a leftover whose record is gone is KEPT, never renamed into an invisible folder', () => {
  // The bug a real run of this function exposed: leftovers were renamed into servers/<id> while the store had no record
  // for them, producing folders no screen could show. Three were created that way before it was noticed. Renaming without
  // a record manufactures the exact orphan state this function exists to fix, so it must not happen.
  const { base, serversDir } = makeServersRoot();
  const serverId = '99999999-8888-7777-6666-555555555555';
  const leftover = makeLeftover(serversDir, serverId);
  try {
    const result = recoverInterruptedPublishes(base, () => false);
    assert.equal(result.recovered.length, 0, 'must not rename without a record');
    assert.equal(result.unclaimed.length, 1, 'the leftover is reported as unclaimed');
    assert.equal(fs.existsSync(leftover), true, 'the leftover stays where it is');
    assert.equal(fs.existsSync(path.join(serversDir, serverId)), false, 'no invisible folder is created');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a leftover whose server was already published is REMOVED', () => {
  // Renaming here would collide with a live server directory; the leftover is a stale partial copy.
  const { base, serversDir } = makeServersRoot();
  const serverId = 'ffffffff-1111-2222-3333-444444444444';
  const finalDir = path.join(serversDir, serverId);
  fs.mkdirSync(finalDir, { recursive: true });
  fs.writeFileSync(path.join(finalDir, 'server.jar'), 'published');
  const leftover = makeLeftover(serversDir, serverId);
  try {
    const result = recoverInterruptedPublishes(base, () => true);
    assert.equal(result.removed.length, 1, 'stale leftover must be removed');
    assert.equal(result.recovered.length, 0, 'nothing to recover');
    assert.equal(fs.existsSync(leftover), false);
    assert.equal(fs.readFileSync(path.join(finalDir, 'server.jar'), 'utf8'), 'published', 'the real server is untouched');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('ordinary server folders are never touched', () => {
  // The function scans the servers directory, so a bug in the name check could rewrite real servers. It must not.
  const { base, serversDir } = makeServersRoot();
  const realId = '12345678-1234-1234-1234-123456789abc';
  const realDir = path.join(serversDir, realId);
  fs.mkdirSync(realDir, { recursive: true });
  fs.writeFileSync(path.join(realDir, 'server.jar'), 'real');
  try {
    const result = recoverInterruptedPublishes(base);
    assert.deepEqual(result, { recovered: [], removed: [], skipped: [], unclaimed: [] });
    assert.equal(fs.readFileSync(path.join(realDir, 'server.jar'), 'utf8'), 'real');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('several leftovers are handled independently', () => {
  const { base, serversDir } = makeServersRoot();
  const recoverable = 'aaaa1111-0000-0000-0000-000000000001';
  const stale = 'bbbb2222-0000-0000-0000-000000000002';
  makeLeftover(serversDir, recoverable);
  fs.mkdirSync(path.join(serversDir, stale), { recursive: true });
  makeLeftover(serversDir, stale);
  try {
    const result = recoverInterruptedPublishes(base);
    assert.equal(result.recovered.length, 1);
    assert.equal(result.removed.length, 1);
    assert.ok(result.recovered[0].startsWith(recoverable));
    assert.ok(result.removed[0].startsWith(stale));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a missing servers directory is not an error', () => {
  // Runs at startup, before anything else has necessarily created the data root. It must not throw.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-recover-empty-'));
  try {
    assert.deepEqual(recoverInterruptedPublishes(base, () => true), { recovered: [], removed: [], skipped: [], unclaimed: [] });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ---- the publish ladder itself ----

test('publish moves a normal tree into place and leaves no temp behind', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-normal-'));
  const from = path.join(base, 'staging');
  const to = path.join(base, 'servers', 'id-1');
  fs.mkdirSync(from, { recursive: true });
  fs.writeFileSync(path.join(from, 'server.jar'), 'x');
  try {
    publishStagedDirectory(from, to);
    assert.equal(fs.existsSync(path.join(to, 'server.jar')), true);
    assert.equal(fs.existsSync(from), false, 'staging is consumed');
    // No .publishing-* sibling may survive a successful publish.
    const leftovers = fs.readdirSync(path.join(base, 'servers')).filter((n) => n.includes('.publishing-'));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('publishing into a pre-created destination keeps the tree shape (no nested dir)', () => {
  // The file-by-file rung creates the destination first. `cpSync(from, to)` with `to` existing would produce
  // to/<basename>/..., so the implementation must copy children instead. This pins that.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-shape-'));
  const from = path.join(base, 'src');
  const to = path.join(base, 'dst');
  fs.mkdirSync(from, { recursive: true });
  fs.writeFileSync(path.join(from, 'a.jar'), 'a');
  fs.mkdirSync(path.join(from, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(from, 'mods', 'm.jar'), 'm');
  fs.mkdirSync(to, { recursive: true });
  try {
    publishStagedDirectory(from, to);
    assert.equal(fs.existsSync(path.join(to, 'a.jar')), true, 'a.jar must be directly inside dst');
    assert.equal(fs.existsSync(path.join(to, 'src')), false, 'must not nest the source basename');
    assert.equal(fs.existsSync(path.join(to, 'mods', 'm.jar')), true, 'subdirectories must be preserved');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
