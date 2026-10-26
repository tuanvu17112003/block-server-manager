// WP-2.5 unit tests — EULA authority, atomic settings rollback, open-folder containment.
// Pure Node (`node --test` against dist-electron); no Electron APIs are invoked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IpcContext } from '../../ipc';
import { Store, type ServerDto } from '../../services/store';
import {
  readEulaState,
  resolveContainedPath,
  settingsHandlers,
  writeEulaFile,
} from '../../services/properties';

interface TempDir { root: string; cleanup: () => void }

function tempDir(label: string): TempDir {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `msm-props-${label}-`));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function ctxFor(root: string): IpcContext {
  return { dataRoot: root, send: () => undefined, getWindow: () => null };
}

function createServer(root: string, name: string, withFiles = true): { id: string; dir: string } {
  const dto = new Store(root).createServer({ name, loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024 });
  const dir = path.join(root, 'servers', dto.id);
  fs.mkdirSync(dir, { recursive: true });
  if (withFiles) fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=Original\nmax-players=20\n');
  return { id: dto.id, dir };
}

function handlersFor(root: string): {
  handlers: ReturnType<typeof settingsHandlers>;
  stopCalls: () => number;
} {
  let calls = 0;
  const handlers = settingsHandlers(ctxFor(root), async () => { calls += 1; });
  return { handlers, stopCalls: () => calls };
}

function readText(file: string): string { return fs.readFileSync(file, 'utf8'); }

test('readEulaState: missing/false/true/case/BOM matrix and fail-closed unreadable file', () => {
  const { root, cleanup } = tempDir('eula');
  try {
    const dir = path.join(root, 'server');
    assert.deepEqual(readEulaState(dir), { accepted: false, fileExists: false, raw: null });

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'eula.txt'), '# comment\neula=false\n');
    let state = readEulaState(dir);
    assert.equal(state.fileExists, true);
    assert.equal(state.accepted, false);
    assert.match(state.raw ?? '', /eula=false/);

    fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
    assert.equal(readEulaState(dir).accepted, true);
    fs.writeFileSync(path.join(dir, 'eula.txt'), '  EULA = TRUE  \r\n');
    assert.equal(readEulaState(dir).accepted, true);
    fs.writeFileSync(path.join(dir, 'eula.txt'), '\uFEFFeula=true\n');
    assert.equal(readEulaState(dir).accepted, true);
    fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=1\n');
    assert.equal(readEulaState(dir).accepted, false);
    fs.writeFileSync(path.join(dir, 'eula.txt'), 'noteula=true\n');
    assert.equal(readEulaState(dir).accepted, false);

    // A directory named eula.txt is unreadable: report existing but fail closed.
    fs.rmSync(path.join(dir, 'eula.txt'));
    fs.mkdirSync(path.join(dir, 'eula.txt'));
    state = readEulaState(dir);
    assert.equal(state.fileExists, true);
    assert.equal(state.accepted, false);
    assert.equal(state.raw, null);
  } finally {
    cleanup();
  }
});

test('writeEulaFile: atomic write/remove round-trip leaves no temp file', () => {
  const { root, cleanup } = tempDir('eula-write');
  try {
    const dir = path.join(root, 'server');
    writeEulaFile(dir, true);
    assert.equal(readEulaState(dir).accepted, true);
    assert.equal(fs.existsSync(path.join(dir, 'eula.txt.tmp')), false);
    writeEulaFile(dir, false);
    assert.equal(readEulaState(dir).fileExists, false);
  } finally {
    cleanup();
  }
});

test('server_settings_get: stale flags can neither grant nor mask EULA acceptance', async () => {
  const { root, cleanup } = tempDir('get');
  try {
    const { id, dir } = createServer(root, 'Getter');
    const { handlers } = handlersFor(root);
    const ctx = ctxFor(root);
    const get = async (): Promise<boolean> =>
      (await handlers.server_settings_get({ id }, ctx) as { eulaAccepted: boolean }).eulaAccepted;

    // Stale store flag true, no file → not accepted (M-12).
    new Store(root).updateServer(id, { eulaAccepted: true });
    assert.equal(await get(), false);

    // File true but the persisted flag is false → fail closed until the user re-accepts.
    new Store(root).updateServer(id, { eulaAccepted: false });
    writeEulaFile(dir, true);
    assert.equal(await get(), false);

    // Both agree → accepted; then a false file overrides a true flag.
    new Store(root).updateServer(id, { eulaAccepted: true });
    assert.equal(await get(), true);
    writeEulaFile(dir, false);
    assert.equal(await get(), false);

    // The getter must not silently mutate the persisted flag.
    assert.equal(new Store(root).getServer(id)?.eulaAccepted, true);
  } finally {
    cleanup();
  }
});

test('server_settings_update: explicit acceptance writes eula.txt and the flag', async () => {
  const { root, cleanup } = tempDir('accept');
  try {
    const { id, dir } = createServer(root, 'Accept');
    writeEulaFile(dir, false);
    const { handlers } = handlersFor(root);
    const ctx = ctxFor(root);
    const updated = await handlers.server_settings_update(
      { id, values: { motd: 'hello' }, eulaAccepted: true }, ctx,
    ) as ServerDto;
    assert.equal(updated.motd, 'hello');
    assert.equal(readEulaState(dir).accepted, true);
    assert.equal(new Store(root).getServer(id)?.eulaAccepted, true);
    assert.match(readText(path.join(dir, 'server.properties')), /motd=hello/);
  } finally {
    cleanup();
  }
});

test('server_settings_update: unchanged EULA does not stop a running server (M-05)', async () => {
  const { root, cleanup } = tempDir('no-stop');
  try {
    const { id, dir } = createServer(root, 'Running');
    writeEulaFile(dir, true);
    new Store(root).updateServer(id, { eulaAccepted: true, status: 'running' });
    const eulaBefore = fs.readFileSync(path.join(dir, 'eula.txt'));
    const { handlers, stopCalls } = handlersFor(root);
    const ctx = ctxFor(root);

    // The legacy UI always sends eulaAccepted; with no effective change this must not stop.
    await handlers.server_settings_update({ id, values: { motd: 'edited' }, eulaAccepted: true }, ctx);
    assert.equal(stopCalls(), 0);
    assert.match(readText(path.join(dir, 'server.properties')), /motd=edited/);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'eula.txt')), eulaBefore);
  } finally {
    cleanup();
  }
});

test('server_settings_update: explicit revocation while running stops once and removes eula.txt', async () => {
  const { root, cleanup } = tempDir('revoke');
  try {
    const { id, dir } = createServer(root, 'Revoke');
    writeEulaFile(dir, true);
    new Store(root).updateServer(id, { eulaAccepted: true, status: 'running' });
    const { handlers, stopCalls } = handlersFor(root);
    const ctx = ctxFor(root);

    await handlers.server_settings_update({ id, values: {}, eulaAccepted: false }, ctx);
    assert.equal(stopCalls(), 1);
    assert.equal(readEulaState(dir).fileExists, false);
    assert.equal(new Store(root).getServer(id)?.eulaAccepted, false);
  } finally {
    cleanup();
  }
});

test('server_settings_update: name-conflict failure leaves server.properties and eula.txt unchanged', async () => {
  const { root, cleanup } = tempDir('conflict');
  try {
    const { id, dir } = createServer(root, 'Mine');
    writeEulaFile(dir, true);
    new Store(root).createServer({ name: 'Taken', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024 });
    const propsBefore = fs.readFileSync(path.join(dir, 'server.properties'));
    const eulaBefore = fs.readFileSync(path.join(dir, 'eula.txt'));
    const { handlers, stopCalls } = handlersFor(root);
    const ctx = ctxFor(root);

    await assert.rejects(
      async () => handlers.server_settings_update({ id, values: { motd: 'changed' }, name: 'Taken' }, ctx),
      (error: unknown) => (error as { code?: string }).code === 'conflict',
    );
    assert.deepEqual(fs.readFileSync(path.join(dir, 'server.properties')), propsBefore);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'eula.txt')), eulaBefore);
    assert.equal(stopCalls(), 0);
    assert.equal(new Store(root).getServer(id)?.name, 'Mine');
  } finally {
    cleanup();
  }
});

test('server_settings_update: invalid property values leave the file unchanged', async () => {
  const { root, cleanup } = tempDir('invalid');
  try {
    const { id, dir } = createServer(root, 'Invalid');
    const propsBefore = fs.readFileSync(path.join(dir, 'server.properties'));
    const { handlers } = handlersFor(root);
    await assert.rejects(
      async () => handlers.server_settings_update({ id, values: { 'max-players': '9999' } }, ctxFor(root)),
      (error: unknown) => (error as { code?: string }).code === 'validation',
    );
    assert.deepEqual(fs.readFileSync(path.join(dir, 'server.properties')), propsBefore);
  } finally {
    cleanup();
  }
});

test('server_settings_update: a failure after writes rolls server.properties and eula.txt back', async () => {
  const { root, cleanup } = tempDir('rollback');
  const originalUpdate = Store.prototype.updateServer;
  try {
    const { id, dir } = createServer(root, 'Rollback');
    const propsBefore = fs.readFileSync(path.join(dir, 'server.properties'));
    assert.equal(fs.existsSync(path.join(dir, 'eula.txt')), false);

    Store.prototype.updateServer = function (): never {
      throw Object.assign(new Error('simulated store failure'), { code: 'db' });
    };
    const { handlers } = handlersFor(root);
    await assert.rejects(
      async () => handlers.server_settings_update({ id, values: { motd: 'new' }, eulaAccepted: true }, ctxFor(root)),
      /simulated store failure/,
    );
    Store.prototype.updateServer = originalUpdate;

    assert.deepEqual(fs.readFileSync(path.join(dir, 'server.properties')), propsBefore);
    assert.equal(fs.existsSync(path.join(dir, 'eula.txt')), false);
    assert.equal(fs.existsSync(path.join(dir, 'server.properties.tmp')), false);
    assert.equal(fs.existsSync(path.join(dir, 'eula.txt.tmp')), false);
    assert.equal(new Store(root).getServer(id)?.eulaAccepted, false);
  } finally {
    Store.prototype.updateServer = originalUpdate;
    cleanup();
  }
});

test('resolveContainedPath: keeps paths inside the server folder and rejects escapes', () => {
  const base = path.resolve(os.tmpdir(), 'msm-containment-base');
  assert.equal(resolveContainedPath(base, ''), base);
  assert.equal(resolveContainedPath(base, '.'), base);
  assert.equal(resolveContainedPath(base, 'server.properties'), path.resolve(base, 'server.properties'));
  assert.equal(resolveContainedPath(base, 'mods/sub/x.jar'), path.resolve(base, 'mods', 'sub', 'x.jar'));

  const escapes = [
    '..', '../x', 'a/../../b', 'a/../b', 'mods\\..\\..\\x',
    'C:\\Windows', 'C:relative', '/etc/passwd', '\\\\srv\\share\\x', 'bad\u0000name',
  ];
  for (const bad of escapes) {
    assert.throws(
      () => resolveContainedPath(base, bad),
      (error: unknown) => (error as { code?: string }).code === 'validation',
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
});

test('server_open_folder: escape rejected before any Electron call', async () => {
  const { root, cleanup } = tempDir('open-folder');
  try {
    const { id } = createServer(root, 'Open');
    const { handlers } = handlersFor(root);
    for (const bad of ['..', '../escape', 'C:\\Windows']) {
      await assert.rejects(
        async () => handlers.server_open_folder({ id, sub: bad }, ctxFor(root)),
        (error: unknown) => (error as { code?: string }).code === 'validation',
      );
    }
  } finally {
    cleanup();
  }
});
