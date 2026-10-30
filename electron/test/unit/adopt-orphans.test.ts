// Adopting an orphaned server folder must describe it correctly and must never damage it.
//
// These folders are the only surviving copy of a real installation, so the risks are concrete: adopting with the wrong
// loader means the app launches it the wrong way, adopting with a duplicate port means neither server can start, and
// rewriting server.properties carelessly could destroy settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  chooseFreePort,
  collapseDuplicates,
  findOrphanedServers,
  uniqueName,
  writePortIntoProperties,
} from '../../services/adopt-orphans';

/** Build a fake server folder that looks like a real Fabric 1.20.1 install. */
function makeFabricServer(root: string, id: string, port: string): string {
  const dir = path.join(root, 'servers', id);
  fs.mkdirSync(path.join(dir, 'versions', '1.20.1'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'libraries', 'net', 'fabricmc', 'fabric-loader', '0.20.1'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'level');
  fs.writeFileSync(path.join(dir, 'fabric-server-launch.jar'), 'jar');
  fs.writeFileSync(path.join(dir, 'server.jar'), 'jar');
  fs.writeFileSync(
    path.join(dir, 'server.properties'),
    [
      '#Minecraft server properties',
      'server-port=' + port,
      'motd=Recovered Fabric',
      'level-name=world',
      'max-players=20',
      'difficulty=easy',
      'online-mode=true',
    ].join('\n'),
  );
  return dir;
}

/** A vanilla install: no libraries, just server.jar and a versions folder. */
function makeVanillaServer(root: string, id: string, port: string): string {
  const dir = path.join(root, 'servers', id);
  fs.mkdirSync(path.join(dir, 'versions', '1.20.1'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'level');
  fs.writeFileSync(path.join(dir, 'server.jar'), 'jar');
  fs.writeFileSync(path.join(dir, 'server.properties'), `server-port=${port}\nmotd=Plain\nlevel-name=world\n`);
  return dir;
}

test('detects loader, version and port from real files, not guesses', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-'));
  try {
    makeFabricServer(base, 'aaaa1111-0000-0000-0000-000000000001', '25534');
    makeVanillaServer(base, 'bbbb2222-0000-0000-0000-000000000002', '25531');

    const found = findOrphanedServers(base, () => false);
    assert.equal(found.length, 2);

    const fabric = found.find((s) => s.id.startsWith('aaaa'));
    assert.ok(fabric !== undefined);
    assert.equal(fabric.loader, 'Fabric');
    assert.equal(fabric.loaderVersion, '0.20.1', 'loader version comes from the libraries directory');
    assert.equal(fabric.mcVersion, '1.20.1', 'mc version comes from the versions directory');
    assert.equal(fabric.port, 25534);
    assert.equal(fabric.hasWorld, true);
    assert.equal(fabric.worldName, 'world');
    assert.equal(fabric.name, 'Recovered Fabric');
    assert.ok(fabric.files > 0);
    assert.ok(fabric.bytes > 0);

    const vanilla = found.find((s) => s.id.startsWith('bbbb'));
    assert.ok(vanilla !== undefined);
    assert.equal(vanilla.loader, 'Vanilla');
    assert.equal(vanilla.loaderVersion, null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('servers that already have a record are not offered for adoption', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-'));
  const id = 'cccc3333-0000-0000-0000-000000000003';
  try {
    makeVanillaServer(base, id, '25565');
    assert.equal(findOrphanedServers(base, (x) => x === id).length, 0, 'a recorded server is not an orphan');
    assert.equal(findOrphanedServers(base, () => false).length, 1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('publish leftovers and empty folders are not adopted', () => {
  // `.publishing-` folders have their own recovery path, and an empty folder would become a broken entry in the list.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-'));
  try {
    fs.mkdirSync(path.join(base, 'servers', 'dddd4444-0000-0000-0000-000000000004.publishing-x'), { recursive: true });
    fs.mkdirSync(path.join(base, 'servers', 'eeee5555-0000-0000-0000-000000000005'), { recursive: true });
    assert.deepEqual(findOrphanedServers(base, () => false), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a duplicate port gets a new one instead of refusing to adopt', () => {
  // The real case: two of the three orphans were on port 25534. Refusing to adopt would leave both unreachable.
  const taken = new Set([25534, 25535]);
  assert.equal(chooseFreePort(25534, taken), 25536, 'must skip every taken port and land on the next free one');
  assert.equal(chooseFreePort(25531, taken), 25531, 'a free preferred port is kept as is');
  assert.equal(chooseFreePort(0, new Set([25565])), 25566, 'port 0 means unset, so start the search at the app range');
});

test('rewriting the port preserves every other setting and the line endings', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-'));
  const dir = makeVanillaServer(base, 'ffff6666-0000-0000-0000-000000000006', '25534');
  try {
    // Use CRLF to prove line endings survive; Windows edits quietly converting them would be a real annoyance.
    const file = path.join(dir, 'server.properties');
    fs.writeFileSync(file, 'server-port=25534\r\nmotd=Keep Me\r\ndifficulty=hard\r\n');
    writePortIntoProperties(dir, 25536);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /server-port=25536/);
    assert.match(text, /motd=Keep Me/, 'other settings must be preserved');
    assert.match(text, /difficulty=hard/);
    assert.ok(text.includes('\r\n'), 'CRLF line endings must be preserved');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('port is appended when server.properties has no server-port line', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-'));
  const dir = makeVanillaServer(base, '99999999-0000-0000-0000-000000000007', '25565');
  try {
    const file = path.join(dir, 'server.properties');
    fs.writeFileSync(file, 'motd=No Port Here\n');
    writePortIntoProperties(dir, 25540);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /server-port=25540/);
    assert.match(text, /motd=No Port Here/, 'existing content survives');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('detection never modifies the folder it inspects', () => {
  // The strongest guarantee this feature needs: looking must not change anything.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-'));
  const dir = makeFabricServer(base, '12121212-0000-0000-0000-000000000008', '25534');
  try {
    const before = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
    const beforeFiles = fs.readdirSync(dir).sort().join('|');
    const found = findOrphanedServers(base, () => false);
    assert.equal(found.length, 1, 'the folder is detected');
    assert.equal(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8'), before, 'server.properties untouched');
    assert.equal(fs.readdirSync(dir).sort().join('|'), beforeFiles, 'no files added or removed');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a folder without server.properties is not a server (unfinished jar download)', () => {
  // Two real folders contained only server.jar (49 MB, one file). They are downloads that never finished installing;
  // adopting them would give the user a Start button that cannot work.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-'));
  try {
    const dir = path.join(base, 'servers', 'abababab-0000-0000-0000-000000000009');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'server.jar'), 'jar');
    assert.deepEqual(findOrphanedServers(base, () => false), [], 'a lone jar is not an installed server');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('identical installations collapse to the richest copy', () => {
  // Two 977 MB COBBLEVERSE trees existed with the same modpack descriptor. Adopting both would present two servers the
  // user never deliberately created.
  const keep = {
    id: 'a1', folder: '/x/a1', name: 'A', loader: 'Fabric', mcVersion: '1.20.1', loaderVersion: '0.18.4',
    port: 25565, worldName: 'world', hasWorld: true, bytes: 977 * 1048576, files: 1828, signature: 'same',
  };
  const dup = { ...keep, id: 'a2', folder: '/x/a2', bytes: 500 * 1048576, hasWorld: false };
  const other = { ...keep, id: 'a3', folder: '/x/a3', signature: 'different', bytes: 10, hasWorld: false };
  const result = collapseDuplicates([keep, dup, other]);
  assert.equal(result.keep.length, 2, 'one copy per signature survives');
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].id, 'a2', 'the copy with the world is the one kept');
  assert.deepEqual(result.keep.map((c) => c.id).sort(), ['a1', 'a3']);
});

test('a folder with no install descriptor is NEVER collapsed', () => {
  // This is the correction of a bug a dry run caught. Vanilla installs have no msm-install.json, so their signature is
  // null. The first version of the collapse treated the empty signature as "same install" and merged two genuinely
  // different servers (ports 25531 and 25534) into one entry — hiding a real server. Missing evidence must mean "keep".
  const one = {
    id: 'v1', folder: '/x/v1', name: 'V1', loader: 'Vanilla', mcVersion: '1.20.1', loaderVersion: null,
    port: 25531, worldName: 'world', hasWorld: true, bytes: 106 * 1048576, files: 49, signature: null,
  };
  const two = { ...one, id: 'v2', folder: '/x/v2', port: 25534, bytes: 106 * 1048576, files: 51, signature: null };
  const result = collapseDuplicates([one, two]);
  assert.equal(result.keep.length, 2, 'both vanilla servers survive');
  assert.deepEqual(result.duplicates, [], 'nothing is treated as a duplicate without evidence');
});

test('a worldless copy is kept when it is the only copy', () => {
  const solo = {
    id: 'b1', folder: '/x/b1', name: 'B', loader: 'Vanilla', mcVersion: '1.20.1', loaderVersion: null,
    port: 25566, worldName: 'world', hasWorld: false, bytes: 100, files: 5, signature: 'solo',
  };
  const result = collapseDuplicates([solo]);
  assert.deepEqual(result.keep.map((c) => c.id), ['b1']);
  assert.deepEqual(result.duplicates, []);
});

test('names that collide get a stable disambiguator', () => {
  // Every orphan carried motd="Block Server Manager", the app default, so they would all collide. The store rejects
  // duplicate names, so adoption would have failed on every folder after the first.
  const taken = new Set(['Block Server Manager']);
  const first = uniqueName('Block Server Manager', taken);
  assert.equal(first, 'Block Server Manager (2)');
  taken.add(first);
  const second = uniqueName('Block Server Manager', taken);
  assert.equal(second, 'Block Server Manager (3)');
  assert.equal(uniqueName('Fresh Name', taken), 'Fresh Name', 'a free name is used unchanged');
  assert.equal(uniqueName('   ', taken), 'Recovered server', 'a blank name falls back to a usable one');
});
