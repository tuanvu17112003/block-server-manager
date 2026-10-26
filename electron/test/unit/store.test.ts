// Unit tests for the JSON store durability contract (B-06 lost update, B-07 corrupt wipe, B-28).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store, appError } from '../../services/store';
import { tempRoot } from '../harness';

function input(name: string) {
  return { name, loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024 };
}

test('missing file is a fresh store and the first write persists atomically', () => {
  const temp = tempRoot('msm-store-1');
  try {
    const store = new Store(temp.root);
    assert.deepEqual(store.listServers(), []);
    const created = store.createServer(input('A'));
    assert.ok(created.id);
    const reloaded = new Store(temp.root).listServers();
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0]!.name, 'A');
    assert.ok(fs.existsSync(path.join(temp.root, 'app-data.json')));
  } finally {
    temp.cleanup();
  }
});

test('pushCommand from a stale instance must not erase servers created elsewhere (B-06)', () => {
  const temp = tempRoot('msm-store-2');
  try {
    const writer = new Store(temp.root);   // shared process-manager instance, loaded empty
    const creator = new Store(temp.root);
    creator.createServer(input('Created Elsewhere'));
    writer.pushCommand('some-server', 'say hi'); // must reload before saving
    const servers = new Store(temp.root).listServers().map((server) => server.name);
    assert.deepEqual(servers, ['Created Elsewhere']);
  } finally {
    temp.cleanup();
  }
});

test('two stale instances mutating different sections keep both writes (read-through)', () => {
  const temp = tempRoot('msm-store-3');
  try {
    const first = new Store(temp.root);
    const second = new Store(temp.root);
    const server = first.createServer(input('S'));
    second.addBackup({
      id: 'b1', serverId: server.id, name: 'backup', path: path.join(temp.root, 'b.zip'),
      bytes: 1, kind: 'Manual', note: '', createdAt: new Date().toISOString(),
    });
    const reloaded = new Store(temp.root);
    assert.equal(reloaded.listServers().length, 1);
    assert.equal(reloaded.listBackups(server.id).length, 1);
  } finally {
    temp.cleanup();
  }
});

test('corrupt file is quarantined + rejected loudly instead of silently wiping (B-07)', () => {
  const temp = tempRoot('msm-store-4');
  try {
    const file = path.join(temp.root, 'app-data.json');
    fs.writeFileSync(file, '{ this is not json');
    const store = new Store(temp.root);
    assert.throws(() => store.listServers(), (error: unknown) => (error as { code?: string }).code === 'store-corrupt');
    // Original must still exist, plus a quarantine copy.
    assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json');
    const quarantine = fs.readdirSync(temp.root).filter((name) => name.includes('.corrupt-'));
    assert.equal(quarantine.length, 1);
    // Every later attempt also fails loudly and never overwrites the original.
    assert.throws(() => new Store(temp.root).createServer(input('Nope')));
    assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json');  } finally {
    temp.cleanup();
  }
});

test('invalid rows are dropped on load without breaking the rest', () => {
  const temp = tempRoot('msm-store-5');
  try {
    const file = path.join(temp.root, 'app-data.json');
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 2,
      servers: [{ id: '', name: 'broken' }, { id: 'ok-id', name: 'Good', loader: 'Vanilla', mcVersion: '1.21.1', port: 25565, ramMb: 1024, eulaAccepted: false, status: 'stopped', createdAt: new Date().toISOString() }],
      backups: [{ id: 'bad' }],
    }));
    const servers = new Store(temp.root).listServers();
    assert.equal(servers.length, 1);
    assert.equal(servers[0]!.name, 'Good');
  } finally {
    temp.cleanup();
  }
});

test('deleteServer cascades backups, history, schedules, pending worlds and content metadata', () => {
  const temp = tempRoot('msm-store-6');
  try {
    const store = new Store(temp.root);
    const server = store.createServer(input('Cascade'));
    store.addBackup({
      id: 'b1', serverId: server.id, name: 'x', path: path.join(temp.root, 'x.zip'),
      bytes: 1, kind: 'Manual', note: '', createdAt: new Date().toISOString(),
    });
    store.pushCommand(server.id, 'say hi');
    store.setBackupSchedule(server.id, { auto: true, interval: 'Daily', maxKept: 3, lastRunAt: null });
    store.setPendingWorld(server.id, { name: 'w2', seed: '', levelType: 'normal', createdAt: new Date().toISOString() });
    store.setSetting(`content:${server.id}`, { a: 1 });
    store.deleteServer(server.id);
    const reloaded = new Store(temp.root);
    assert.deepEqual(reloaded.listServers(), []);
    assert.deepEqual(reloaded.listBackups(server.id), []);
    assert.deepEqual(reloaded.commandHistory(server.id), []);
    assert.equal(reloaded.pendingWorld(server.id), null);
    assert.equal(reloaded.getSetting(`content:${server.id}`), null);
    assert.equal(reloaded.backupSchedule(server.id).auto, false);
  } finally {
    temp.cleanup();
  }
});

test('save keeps the previous file as .bak and uses a unique temp file', () => {
  const temp = tempRoot('msm-store-7');
  try {
    const store = new Store(temp.root);
    store.createServer(input('First'));
    store.createServer(input('Second'));
    const files = fs.readdirSync(temp.root);
    assert.ok(files.includes('app-data.json'));
    assert.ok(files.includes('app-data.json.bak'));
    assert.equal(files.some((name) => name.endsWith('.tmp')), false);
    assert.equal(new Store(temp.root).listServers().length, 2);
  } finally {
    temp.cleanup();
  }
});

test('appError code contract is unchanged', () => {
  assert.equal((appError('conflict', 'x') as { code?: string }).code, 'conflict');
});
