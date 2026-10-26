// Service-level suite for WP-2.3: `servers_create` validation through the real handler map, the
// OS-probed port allocator, the `server_command_history` renderer contract, and the IPC sender
// origin policy. Runs inside Electron via `--servicestest` (service harness, throwaway data root).
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TestRun } from '../harness';
import { withHarness } from '../service-harness';
import { isTrustedIpcUrl, type IpcTrustPolicy } from '../../ipc';

type HandlerError = { code?: string };

function isCode(code: string) {
  return (error: unknown) => (error as HandlerError).code === code;
}

/** Bind a real loopback port and hand back its number + a closer (for "already in use" cases). */
async function blocker(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Grab a port that was just proven bindable, then release it for an explicit create. */
async function usablePort(): Promise<number> {
  const reserved = await blocker();
  await reserved.close();
  return reserved.port;
}

export async function runValidationSuite(run: TestRun): Promise<void> {
  await withHarness(run, async (h) => {
    const list = (): Promise<{ id: string; name: string; port: number; loader: string }[]> =>
      h.invoke<{ id: string; name: string; port: number; loader: string }[]>('servers_list');

    await run.must('servers_create: auto allocation yields unique, in-range ports (real OS probe)', async () => {
      const first = await h.createServer({ name: 'Auto One', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024 } as never);
      const second = await h.createServer({ name: 'Auto Two', loader: 'Fabric', mcVersion: '1.21.1', ramMb: 1024 } as never);
      assert.notEqual(first.port, second.port);
      for (const port of [first.port, second.port]) {
        assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, `unexpected port ${port}`);
      }
    });

    await run.must('servers_create: duplicate explicit port is rejected with conflict', async () => {
      const port = await usablePort();
      const created = await h.createServer({ name: 'Port Owner', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024, port } as never);
      assert.equal(created.port, port);
      await assert.rejects(
        () => h.invoke('servers_create', {
          input: { name: 'Port Thief', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024, port },
        }),
        isCode('conflict'),
      );
      assert.ok(!(await list()).some((server) => server.name === 'Port Thief'), 'no row for the rejected create');
    });

    await run.must('servers_create: OS-occupied port fails closed with conflict (no silent rewrite)', async () => {
      const held = await blocker();
      try {
        await assert.rejects(
          () => h.invoke('servers_create', {
            input: { name: 'Blocked Port', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024, port: held.port },
          }),
          isCode('conflict'),
        );
      } finally {
        await held.close();
      }
      assert.ok(!(await list()).some((server) => server.name === 'Blocked Port'));
    });

    await run.must('servers_create: name/loader/mcVersion/RAM/port validation via IPC', async () => {
      const before = (await list()).length;
      const cases: { label: string; patch: Record<string, unknown>; code: string }[] = [
        { label: 'empty name', patch: { name: '   ' }, code: 'validation' },
        { label: 'long name', patch: { name: 'x'.repeat(65) }, code: 'validation' },
        { label: 'newline name', patch: { name: 'bad\nname' }, code: 'validation' },
        { label: 'equals name', patch: { name: 'bad=name' }, code: 'validation' },
        { label: 'Quilt loader', patch: { loader: 'Quilt' }, code: 'validation' },
        { label: 'unknown loader', patch: { loader: 'Minecraft' }, code: 'validation' },
        { label: 'bad mcVersion', patch: { mcVersion: 'not a version' }, code: 'validation' },
        { label: 'path mcVersion', patch: { mcVersion: '../1.21.1' }, code: 'validation' },
        { label: 'low RAM', patch: { ramMb: 100 }, code: 'validation' },
        { label: 'high RAM', patch: { ramMb: 70000 }, code: 'validation' },
        { label: 'fractional RAM', patch: { ramMb: 1024.5 }, code: 'validation' },
        { label: 'privileged port', patch: { port: 80 }, code: 'validation' },
        { label: 'out-of-range port', patch: { port: 70000 }, code: 'validation' },
      ];
      for (const entry of cases) {
        await assert.rejects(
          () => h.invoke('servers_create', {
            input: { name: 'Case Server', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024, ...entry.patch },
          }),
          isCode(entry.code),
          `expected ${entry.code} for ${entry.label}`,
        );
      }
      assert.equal((await list()).length, before, 'invalid creates must not persist rows');
    });

    await run.must('servers_create: non-object input is rejected without throwing an unknown code', async () => {
      for (const input of [undefined, null, 'nope', 42]) {
        await assert.rejects(
          () => h.invoke('servers_create', { input }),
          isCode('validation'),
        );
      }
    });

    await run.must('servers_create: canonicalises case-insensitive loader spellings', async () => {
      const created = await h.invoke<{ loader: string }>('servers_create', {
        input: { name: 'Case Loader', loader: 'fabric', mcVersion: '1.21.1', ramMb: 1024 },
      });
      assert.equal(created.loader, 'Fabric');
    });

    await run.must('server_command_history: newest-first string[] capped at 100, cascades on delete', async () => {
      const created = await h.createServer({ name: 'History Contract', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024 } as never);
      for (let index = 0; index < 105; index += 1) h.store().pushCommand(created.id, `cmd-${index}`);
      const history = await h.invoke<string[]>('server_command_history', { id: created.id });
      assert.equal(history.length, 100);
      assert.equal(history[0], 'cmd-104', 'newest command must be first (renderer Arrow-Up contract)');
      assert.ok(history.every((entry) => typeof entry === 'string'), 'renderer contract stays string[]');
      const entries = h.store().commandHistoryEntries(created.id, 2);
      assert.deepEqual(entries.map((entry) => entry.command), ['cmd-104', 'cmd-103']);
      assert.ok(entries.every((entry) => typeof entry.at === 'string' && !Number.isNaN(Date.parse(entry.at))));

      await h.invoke('servers_delete', { id: created.id });
      assert.deepEqual(await h.invoke('server_command_history', { id: created.id }), []);
    });

    await run.must('IPC sender policy: only the app renderer / dev origin is trusted', async () => {
      const appPath = path.join(os.tmpdir(), 'msm-trust-app');
      const policy: IpcTrustPolicy = { appPath, devUrl: 'http://localhost:1420', allowTempRoots: false };
      const inside = pathToFileURL(path.join(appPath, 'dist', 'index.html')).href;
      const outside = pathToFileURL(path.join(appPath, '..', 'evil.html')).href;
      const gatePage = pathToFileURL(path.join(os.tmpdir(), 'msm-gate-ipctest-x', 'ipc-test.html')).href;
      assert.equal(isTrustedIpcUrl(inside, policy), true, 'app dist file URL');
      assert.equal(isTrustedIpcUrl('http://localhost:1420/index.html', policy), true, 'vite dev origin');
      assert.equal(isTrustedIpcUrl(outside, policy), false, 'file URL outside the app root');
      assert.equal(isTrustedIpcUrl('http://localhost:1420.evil.example/x', policy), false, 'lookalike origin');
      assert.equal(isTrustedIpcUrl('https://evil.example/x', policy), false, 'remote https');
      assert.equal(isTrustedIpcUrl('data:text/html,hi', policy), false, 'data URL');
      assert.equal(isTrustedIpcUrl('', policy), false, 'empty URL');
      assert.equal(isTrustedIpcUrl('not a url', policy), false, 'malformed URL');
      assert.equal(isTrustedIpcUrl(gatePage, policy), false, 'temp gate page needs allowTempRoots');
      assert.equal(isTrustedIpcUrl(gatePage, { ...policy, allowTempRoots: true }), true, 'non-packaged gate page');
      assert.equal(isTrustedIpcUrl('http://localhost:1420/index.html', { ...policy, devUrl: null }), false, 'no dev mode configured');
    });
  });
}
