// Unit tests for WP-2.3: port allocator, create-time validation, command-history contract.
// Runs with plain `node --test` (no Electron imports): Store + validate-args are pure Node modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { Store, MAX_COMMAND_HISTORY_PER_SERVER } from '../../services/store';
import {
  ALLOWED_LOADERS,
  assertPortAvailable,
  normalizeCreateServerInput,
  probePortAvailable,
} from '../../services/validate-args';
import { sleep, tempRoot } from '../harness';

type PortProbe = (port: number) => Promise<boolean>;

function createInput(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024, ...extra };
}

function codeOf(error: unknown): string {
  return (error as { code?: string }).code ?? '';
}

/** Allocate a real free port on 127.0.0.1 then release it (for "free explicit port" cases). */
async function ephemeralPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// ------------------------------------------------------------------------------------------------
// allocatePort
// ------------------------------------------------------------------------------------------------

test('allocatePort: explicit free port is validated and returned unchanged', async () => {
  const temp = tempRoot('msm-port-1');
  try {
    const store = new Store(temp.root);
    const port = await ephemeralPort();
    const probe: PortProbe = async (candidate) => {
      assert.equal(candidate, port, 'probe must receive the requested port');
      return true;
    };
    assert.equal(await store.allocatePort(port, { probe }), port);
  } finally {
    temp.cleanup();
  }
});

test('allocatePort: explicit port outside 1024–65535 is a validation error', async () => {
  const temp = tempRoot('msm-port-2');
  try {
    const store = new Store(temp.root);
    const probe: PortProbe = async () => true;
    for (const invalid of [80, 1023, 65536, 70000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        () => store.allocatePort(invalid as never, { probe }),
        (error: unknown) => codeOf(error) === 'validation',
        `expected validation for ${String(invalid)}`,
      );
    }
    // Numeric strings are rejected rather than coerced (renderer sends numbers).
    await assert.rejects(
      () => store.allocatePort('25601' as never, { probe }),
      (error: unknown) => codeOf(error) === 'validation',
    );
  } finally {
    temp.cleanup();
  }
});

test('allocatePort: explicit port assigned to another record is a conflict', async () => {
  const temp = tempRoot('msm-port-3');
  try {
    const store = new Store(temp.root);
    const existing = store.createServer(createInput('Owner', { port: 25601 }) as never);
    assert.equal(existing.port, 25601);
    await assert.rejects(
      () => store.allocatePort(25601, { probe: async () => true }),
      (error: unknown) => codeOf(error) === 'conflict' && /Owner/.test((error as Error).message),
    );
  } finally {
    temp.cleanup();
  }
});

test('allocatePort: explicit port the OS probe reports busy is a conflict', async () => {
  const temp = tempRoot('msm-port-4');
  try {
    const store = new Store(temp.root);
    await assert.rejects(
      () => store.allocatePort(25602, { probe: async () => false }),
      (error: unknown) => codeOf(error) === 'conflict' && /25602/.test((error as Error).message),
    );
  } finally {
    temp.cleanup();
  }
});

test('allocatePort: auto allocation skips recorded ports and busy candidates', async () => {
  const temp = tempRoot('msm-port-5');
  try {
    const store = new Store(temp.root);
    store.createServer(createInput('Recorder') as never); // takes 25565
    const probed: number[] = [];
    const probe: PortProbe = async (port) => {
      probed.push(port);
      return port !== 25566; // 25566 is held by an untracked process
    };
    assert.equal(await store.allocatePort(undefined, { probe }), 25567);
    assert.deepEqual(probed, [25566, 25567], 'recorded port must never be probed');
  } finally {
    temp.cleanup();
  }
});

test('allocatePort: null/undefined/0 all mean auto and start at 25565', async () => {
  const temp = tempRoot('msm-port-6');
  try {
    const store = new Store(temp.root);
    const probe: PortProbe = async () => true;
    assert.equal(await store.allocatePort(undefined, { probe }), 25565);
    assert.equal(await store.allocatePort(null, { probe }), 25565);
    assert.equal(await store.allocatePort(0, { probe }), 25565);
  } finally {
    temp.cleanup();
  }
});

test('allocatePort: fails closed with conflict when the whole range is unavailable', async () => {
  const temp = tempRoot('msm-port-7');
  try {
    const store = new Store(temp.root);
    await assert.rejects(
      () => store.allocatePort(undefined, { probe: async () => false }),
      (error: unknown) => codeOf(error) === 'conflict',
    );
  } finally {
    temp.cleanup();
  }
});

test('allocatePort: probe exceptions fail closed as io, never "available"', async () => {
  const temp = tempRoot('msm-port-8');
  try {
    const store = new Store(temp.root);
    await assert.rejects(
      () => store.allocatePort(25603, { probe: async () => { throw new Error('EACCES'); } }),
      (error: unknown) => codeOf(error) === 'io',
    );
  } finally {
    temp.cleanup();
  }
});

// ------------------------------------------------------------------------------------------------
// assertPortAvailable (fail-closed start-time helper shared with server-process)
// ------------------------------------------------------------------------------------------------

test('assertPortAvailable: returns the same port when free, conflicts when busy', async () => {
  assert.equal(await assertPortAvailable(25604, async () => true), 25604);
  await assert.rejects(
    () => assertPortAvailable(25604, async () => false),
    (error: unknown) => codeOf(error) === 'conflict' && /already in use/.test((error as Error).message),
  );
  await assert.rejects(
    () => assertPortAvailable(80, async () => true),
    (error: unknown) => codeOf(error) === 'validation',
  );
  await assert.rejects(
    () => assertPortAvailable(25604, async () => { throw new Error('boom'); }),
    (error: unknown) => codeOf(error) === 'conflict',
  );
});

test('probePortAvailable: detects a genuinely bound loopback port', async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  assert.ok(port > 0);
  try {
    assert.equal(await probePortAvailable(port), false, 'bound port must probe as unavailable');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  let released = false;
  for (let attempt = 0; attempt < 20 && !released; attempt += 1) {
    released = await probePortAvailable(port);
    if (!released) await sleep(25);
  }
  assert.equal(released, true, 'released port must probe as available');
});

// ------------------------------------------------------------------------------------------------
// createServer validation
// ------------------------------------------------------------------------------------------------

test('createServer: rejects invalid names with validation', () => {
  const temp = tempRoot('msm-create-1');
  try {
    const store = new Store(temp.root);
    for (const name of ['', '   ', 'x'.repeat(65), 'bad\nname', 'bad\rname', 'bad=name']) {
      assert.throws(() => store.createServer(createInput(name) as never), (error: unknown) => codeOf(error) === 'validation');
    }
    assert.deepEqual(store.listServers(), []);
  } finally {
    temp.cleanup();
  }
});

test('createServer: rejects Quilt (ADR-0005) and unknown loaders', () => {
  const temp = tempRoot('msm-create-2');
  try {
    const store = new Store(temp.root);
    assert.throws(
      () => store.createServer(createInput('Quilted', { loader: 'Quilt' }) as never),
      (error: unknown) => codeOf(error) === 'validation' && /ADR-0005/.test((error as Error).message),
    );
    assert.throws(
      () => store.createServer(createInput('Mystery', { loader: 'Minecraft' }) as never),
      (error: unknown) => codeOf(error) === 'validation' && /Allowed loaders/.test((error as Error).message),
    );
    assert.deepEqual(store.listServers(), []);
  } finally {
    temp.cleanup();
  }
});

test('createServer vs normalizeCreateServerInput: loader spelling is preserved for legacy rows, canonicalised for new paths', () => {
  const temp = tempRoot('msm-create-3');
  try {
    const store = new Store(temp.root);
    // Store.createServer keeps the legacy spelling (legacy importer contract test relies on this).
    const legacy = store.createServer(createInput('Lowercase', { loader: 'fabric' }) as never);
    assert.equal(legacy.loader, 'fabric');
    // IPC/UI normalisation canonicalises to the allowlist spelling.
    assert.equal(normalizeCreateServerInput(createInput('Canonical', { loader: 'fabric' })).loader, 'Fabric');
    for (const loader of ALLOWED_LOADERS) {
      assert.equal(normalizeCreateServerInput(createInput(`L-${loader}`, { loader })).loader, loader);
    }
  } finally {
    temp.cleanup();
  }
});

test('createServer: rejects malformed Minecraft versions', () => {
  const temp = tempRoot('msm-create-4');
  try {
    const store = new Store(temp.root);
    for (const mcVersion of ['', '   ', 'not a version', '../1.21.1', '1.21.1/../x', 'x'.repeat(33)]) {
      assert.throws(
        () => store.createServer(createInput('BadMC', { mcVersion }) as never),
        (error: unknown) => codeOf(error) === 'validation',
      );
    }
    // Manifest-shaped IDs are accepted (release/snapshot/old formats).
    for (const mcVersion of ['1.21.1', '1.20.4', '26.1', '26.1.0.19-beta', '1.21.11-rc3', '24w14a', 'a1.2.6', 'b1.7.3', 'c0.30_01c', 'rd-132211']) {
      assert.equal(normalizeCreateServerInput(createInput('OkMC', { mcVersion })).mcVersion, mcVersion);
    }
  } finally {
    temp.cleanup();
  }
});

test('createServer: enforces RAM bounds and integer type', () => {
  const temp = tempRoot('msm-create-5');
  try {
    const store = new Store(temp.root);
    for (const ramMb of [511, 65537, 1024.5, Number.NaN, '1024']) {
      assert.throws(
        () => store.createServer(createInput('BadRam', { ramMb }) as never),
        (error: unknown) => codeOf(error) === 'validation',
        `expected validation for ${String(ramMb)}`,
      );
    }
    assert.equal(store.createServer(createInput('MinRam', { ramMb: 512 }) as never).ramMb, 512);
    assert.equal(store.createServer(createInput('MaxRam', { ramMb: 65536 }) as never).ramMb, 65536);
  } finally {
    temp.cleanup();
  }
});

test('createServer: duplicate explicit port is a conflict, auto ports stay unique', () => {
  const temp = tempRoot('msm-create-6');
  try {
    const store = new Store(temp.root);
    const first = store.createServer(createInput('PortOwner', { port: 25610 }) as never);
    assert.equal(first.port, 25610);
    assert.throws(
      () => store.createServer(createInput('PortThief', { port: 25610 }) as never),
      (error: unknown) => codeOf(error) === 'conflict' && /Port 25610/.test((error as Error).message),
    );
    assert.equal(store.listServers().length, 1);

    const autoA = store.createServer(createInput('AutoA') as never);
    const autoB = store.createServer(createInput('AutoB') as never);
    assert.equal(autoA.port, 25565);
    assert.equal(autoB.port, 25566);
    const ports = store.listServers().map((server) => server.port);
    assert.equal(new Set(ports).size, ports.length, 'ports must be unique across records');
  } finally {
    temp.cleanup();
  }
});

test('createServer: accepts IPC-normalised input and preserves optional fields', () => {
  const temp = tempRoot('msm-create-7');
  try {
    const store = new Store(temp.root);
    const normalized = normalizeCreateServerInput({
      name: '  Padded name  ',
      loader: 'fabric',
      mcVersion: '1.21.1',
      ramMb: 4096,
      loaderVersion: '0.16.9',
      modpackId: 'abcd1234',
      javaPath: 'C:\\Java\\bin\\java.exe',
      eulaAccepted: true,
    });
    const created = store.createServer(normalized);
    assert.equal(created.name, 'Padded name');
    assert.equal(created.loader, 'Fabric');
    assert.equal(created.loaderVersion, '0.16.9');
    assert.equal(created.modpackId, 'abcd1234');
    assert.equal(created.javaPath, 'C:\\Java\\bin\\java.exe');
    assert.equal(created.eulaAccepted, true);
    assert.equal(created.port, 25565);
  } finally {
    temp.cleanup();
  }
});

test('normalizeCreateServerInput: rejects non-objects and bad optional fields', () => {
  for (const value of [undefined, null, 'input', 42, []]) {
    assert.throws(() => normalizeCreateServerInput(value), (error: unknown) => codeOf(error) === 'validation');
  }
  assert.throws(
    () => normalizeCreateServerInput({ ...createInput('X'), eulaAccepted: 'true' }),
    (error: unknown) => codeOf(error) === 'validation',
  );
  assert.throws(
    () => normalizeCreateServerInput({ ...createInput('X'), loaderVersion: 'bad version!' }),
    (error: unknown) => codeOf(error) === 'validation',
  );
  // port 0 / null / empty optionals mean "not provided".
  const normalized = normalizeCreateServerInput({ ...createInput('X'), port: 0, loaderVersion: '', javaPath: null });
  assert.equal(normalized.port, undefined);
  assert.equal(normalized.loaderVersion, undefined);
  assert.equal(normalized.javaPath, undefined);
});

// ------------------------------------------------------------------------------------------------
// Command history contract
// ------------------------------------------------------------------------------------------------

test('command history: newest-first, capped at 100 per server, timestamps stored', () => {
  const temp = tempRoot('msm-history-1');
  try {
    const store = new Store(temp.root);
    const alpha = store.createServer(createInput('Alpha') as never);
    const beta = store.createServer(createInput('Beta') as never);
    for (let index = 0; index < 105; index += 1) {
      store.pushCommand(alpha.id, `alpha-${index}`);
      if (index < 2) store.pushCommand(beta.id, `beta-${index}`);
    }

    const alphaHistory = store.commandHistory(alpha.id);
    assert.equal(alphaHistory.length, MAX_COMMAND_HISTORY_PER_SERVER);
    assert.equal(alphaHistory[0], 'alpha-104', 'index 0 must be the newest command');
    assert.equal(alphaHistory[alphaHistory.length - 1], 'alpha-5');
    assert.equal(alphaHistory.includes('alpha-0'), false, 'oldest rows roll off');

    const betaHistory = store.commandHistory(beta.id);
    assert.deepEqual(betaHistory, ['beta-1', 'beta-0'], 'per-server retention does not leak across servers');

    const entries = store.commandHistoryEntries(alpha.id, 3);
    assert.deepEqual(entries.map((entry) => entry.command), ['alpha-104', 'alpha-103', 'alpha-102']);
    for (const entry of entries) {
      assert.equal(typeof entry.at, 'string');
      assert.ok(!Number.isNaN(Date.parse(entry.at)), 'timestamp must be an ISO date');
    }
    assert.deepEqual(store.commandHistoryEntries(alpha.id, 0), []);
    assert.deepEqual(store.commandHistory(alpha.id, 0), []);
    assert.equal(store.commandHistoryEntries(alpha.id, 10_000).length, MAX_COMMAND_HISTORY_PER_SERVER);
  } finally {
    temp.cleanup();
  }
});

test('command history: persists across instances and cascades on server delete', () => {
  const temp = tempRoot('msm-history-2');
  try {
    const store = new Store(temp.root);
    const server = store.createServer(createInput('Historic') as never);
    store.pushCommand(server.id, 'list');
    store.pushCommand(server.id, 'say hi');
    assert.deepEqual(new Store(temp.root).commandHistory(server.id), ['say hi', 'list']);

    // Rows carry serverId/command/at on disk so they survive a restart.
    const raw = JSON.parse(fs.readFileSync(store.filePath, 'utf8')) as {
      consoleCommandHistory: { serverId: string; command: string; at: string }[];
    };
    assert.equal(raw.consoleCommandHistory.length, 2);
    assert.equal(raw.consoleCommandHistory[0]!.serverId, server.id);
    assert.equal(typeof raw.consoleCommandHistory[0]!.at, 'string');

    store.deleteServer(server.id);
    assert.deepEqual(new Store(temp.root).commandHistory(server.id), []);
  } finally {
    temp.cleanup();
  }
});
