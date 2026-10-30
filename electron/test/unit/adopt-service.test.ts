// End-to-end adoption against real folders on disk and a real store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adoptOrphans, planAdoption } from '../../services/adopt-service';
import { Store } from '../../services/store';

function makeServerFolder(root: string, id: string, port: string, options: { world?: boolean; motd?: string } = {}): string {
  const dir = path.join(root, 'servers', id);
  fs.mkdirSync(path.join(dir, 'versions', '1.20.1'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'libraries', 'net', 'fabricmc', 'fabric-loader', '0.20.1'), { recursive: true });
  if (options.world !== false) {
    fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'level');
  }
  fs.writeFileSync(path.join(dir, 'fabric-server-launch.jar'), 'jar');
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true');
  fs.writeFileSync(
    path.join(dir, 'server.properties'),
    `server-port=${port}\nmotd=${options.motd ?? 'Block Server Manager'}\nlevel-name=world\nmax-players=20\n`,
  );
  return dir;
}

function makeDataRoot(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-e2e-'));
  fs.mkdirSync(path.join(base, 'servers'), { recursive: true });
  return base;
}

test('planning writes nothing and adoption creates records that reference the existing folders', () => {
  const dataRoot = makeDataRoot();
  const store = new Store(dataRoot);
  const id = '11112222-3333-4444-5555-666677778888';
  const folder = makeServerFolder(dataRoot, id, '25534');
  try {
    const before = fs.readFileSync(path.join(folder, 'server.properties'), 'utf8');
    const planned = planAdoption(dataRoot, store);
    assert.equal(planned.plan.length, 1, 'the orphan is planned');
    assert.equal(store.listServers().length, 0, 'planning must not create a record');
    assert.equal(fs.readFileSync(path.join(folder, 'server.properties'), 'utf8'), before, 'planning must not touch files');

    const result = adoptOrphans(dataRoot, store);
    assert.equal(result.adopted.length, 1);
    assert.equal(result.skipped.length, 0);

    const servers = store.listServers();
    assert.equal(servers.length, 1);
    const adopted = servers[0];
    assert.equal(adopted.id, id, 'the record keeps the folder id so the data stays addressable');
    assert.equal(adopted.port, 25534, 'no port change was needed');
    assert.equal(adopted.loader, 'Fabric');
    assert.equal(adopted.mcVersion, '1.20.1');
    assert.equal(adopted.status, 'stopped');
    assert.equal(fs.existsSync(path.join(dataRoot, 'servers', adopted.id, 'world', 'level.dat')), true);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('two orphans sharing a port both get adopted, one with a new port written to disk', () => {
  // The real situation: 74c5b617 and c02d4fe0 were both configured for port 25534. Refusing would leave one unreachable;
  // adopting both without changing the port would leave one unable to bind.
  const dataRoot = makeDataRoot();
  const store = new Store(dataRoot);
  const a = 'aaaa0000-0000-0000-0000-000000000001';
  const b = 'bbbb0000-0000-0000-0000-000000000002';
  const folderA = makeServerFolder(dataRoot, a, '25534');
  const folderB = makeServerFolder(dataRoot, b, '25534');
  try {
    const result = adoptOrphans(dataRoot, store);
    assert.equal(result.adopted.length, 2, 'both are adopted');
    const ports = result.adopted.map((s) => s.port);
    assert.equal(new Set(ports).size, 2, 'they must end up on different ports');

    // The one whose port changed must have the new value persisted, or the next start would conflict again.
    for (const entry of result.plan) {
      const props = fs.readFileSync(path.join(entry.orphan.folder, 'server.properties'), 'utf8');
      assert.match(props, new RegExp(`server-port=${entry.assignedPort}`), 'disk matches the record');
      assert.match(props, /max-players=20/, 'other settings survive the edit');
    }
    assert.ok(fs.existsSync(folderA) && fs.existsSync(folderB), 'both folders untouched');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('adoption is idempotent: running it twice does not duplicate servers', () => {
  const dataRoot = makeDataRoot();
  const store = new Store(dataRoot);
  makeServerFolder(dataRoot, 'cccc0000-0000-0000-0000-000000000003', '25531');
  try {
    const first = adoptOrphans(dataRoot, store);
    assert.equal(first.adopted.length, 1);
    const second = adoptOrphans(dataRoot, store);
    assert.equal(second.adopted.length, 0, 'nothing left to adopt');
    assert.equal(store.listServers().length, 1, 'no duplicate record');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('a folder without server.properties is left alone', () => {
  // A lone server.jar download is not an installation; adopting it would produce a server that cannot start.
  const dataRoot = makeDataRoot();
  const store = new Store(dataRoot);
  const dir = path.join(dataRoot, 'servers', 'dddd0000-0000-0000-0000-000000000004');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.jar'), 'jar');
  try {
    const result = adoptOrphans(dataRoot, store);
    assert.equal(result.adopted.length, 0);
    assert.equal(store.listServers().length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'server.jar')), true, 'the jar is not deleted');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('a port that is already taken by an existing server is avoided', () => {
  const dataRoot = makeDataRoot();
  const store = new Store(dataRoot);
  // An existing, healthy server occupies 25534.
  store.createServer({ name: 'existing', loader: 'Vanilla', mcVersion: '1.20.1', ramMb: 1024, port: 25534 });
  const orphanId = 'eeee0000-0000-0000-0000-000000000005';
  makeServerFolder(dataRoot, orphanId, '25534');
  try {
    const result = adoptOrphans(dataRoot, store);
    assert.equal(result.adopted.length, 1);
    assert.notEqual(result.adopted[0].port, 25534, 'must not reuse a taken port');
    assert.equal(store.listServers().length, 2);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
