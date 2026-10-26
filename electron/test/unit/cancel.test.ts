// WP-4.1 cancellation tests: abort must reject promptly with a typed `cancelled` error, destroy
// the HTTP body / child process tree, and leave no `.part` or partial artifact behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  MODRINTH_ALLOWED_HOSTS,
  cancelledError,
  download,
  extractZip,
  fetchTrusted,
  isAbortError,
  runInstaller,
  type InstallerChildProcess,
} from '../../services/installer/core';
import { collectInputs, writeZip } from '../../services/zip';
import { tempRoot } from '../harness';

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): { restore: () => void } {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input instanceof Request ? input.url : input), init)) as typeof fetch;
  return { restore: () => { globalThis.fetch = real; } };
}

/** A streaming body that emits one chunk and then stays open until cancelled. */
function slowBody(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(64 * 1024));
      // Deliberately never closes: only abort/cancel ends the response.
    },
  });
  return new Response(stream as unknown as BodyInit, { status: 200 });
}

async function expectCancelled(promise: Promise<unknown>, label: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'cancelled', `${label}: expected a cancelled error, got ${String((error as Error)?.message)}`);
    return true;
  }, label);
}

test('cancelledError/isAbortError: typed helpers', () => {
  assert.equal((cancelledError() as { code?: string }).code, 'cancelled');
  assert.equal(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' })), true);
  assert.equal(isAbortError(new Error('x')), false);
});

test('download: abort mid-stream rejects in <2s and removes the `.part` file', async () => {
  const stub = stubFetch(() => slowBody());
  const temp = tempRoot('msm-unit-cancel-download');
  try {
    const controller = new AbortController();
    const dest = path.join(temp.root, 'slow.jar');
    const started = Date.now();
    const pending = download('https://cdn.modrinth.com/slow.jar', dest, { signal: controller.signal, allowedHosts: MODRINTH_ALLOWED_HOSTS });
    setTimeout(() => controller.abort(), 75);
    await expectCancelled(pending, 'download abort');
    assert.ok(Date.now() - started < 2000, 'download abort must settle in under 2 seconds');
    assert.equal(fs.existsSync(dest), false);
    assert.equal(fs.existsSync(`${dest}.part`), false);
  } finally {
    stub.restore();
    temp.cleanup();
  }
});

test('download: an already-aborted signal rejects before any request or file creation', async () => {
  const stub = stubFetch(() => slowBody());
  const temp = tempRoot('msm-unit-cancel-early');
  try {
    const controller = new AbortController();
    controller.abort();
    await expectCancelled(
      download('https://cdn.modrinth.com/early.jar', path.join(temp.root, 'early.jar'), { signal: controller.signal, allowedHosts: MODRINTH_ALLOWED_HOSTS }),
      'download pre-abort',
    );
    assert.deepEqual(fs.readdirSync(temp.root), []);
  } finally {
    stub.restore();
    temp.cleanup();
  }
});

test('fetchTrusted: an in-flight request aborts with a cancelled error', async () => {
  const stub = stubFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  }));
  try {
    const controller = new AbortController();
    const started = Date.now();
    const pending = fetchTrusted('https://api.modrinth.com/v2/hang', MODRINTH_ALLOWED_HOSTS, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expectCancelled(pending, 'fetchTrusted abort');
    assert.ok(Date.now() - started < 2000);
  } finally {
    stub.restore();
  }
});

test('runInstaller: abort kills the child tree and rejects promptly without waiting for exit', async () => {
  const child = new EventEmitter() as EventEmitter & InstallerChildProcess;
  child.pid = 4242;
  child.stdout = new EventEmitter() as InstallerChildProcess['stdout'];
  child.stderr = new EventEmitter() as InstallerChildProcess['stderr'];
  const killedSignals: string[] = [];
  child.kill = (signal?: NodeJS.Signals): boolean => { killedSignals.push(String(signal ?? 'SIGTERM')); return true; };
  let killedTreePid = 0;
  const controller = new AbortController();
  const started = Date.now();
  const pending = runInstaller('java', path.join('cache', 'fake-installer.jar'), ['--installServer'], '.', 'fake loader', {
    signal: controller.signal,
    attempts: 1,
    spawnProcess: () => child,
    killTree: (pid) => { killedTreePid = pid; },
  });
  setTimeout(() => controller.abort(), 50);
  await expectCancelled(pending, 'runInstaller abort');
  assert.ok(Date.now() - started < 2000, 'installer abort must not wait for the child to exit');
  assert.equal(killedTreePid, 4242, 'the whole installer process tree must be killed on abort');
  assert.ok(killedSignals.length > 0, 'the installer child itself must be signalled');
});

test('runInstaller: non-zero exit keeps the existing failure contract (unaffected by cancellation)', async () => {
  const child = new EventEmitter() as EventEmitter & InstallerChildProcess;
  child.pid = 5252;
  child.stdout = new EventEmitter() as InstallerChildProcess['stdout'];
  child.stderr = new EventEmitter() as InstallerChildProcess['stderr'];
  child.kill = (): boolean => true;
  const pending = runInstaller('java', path.join('cache', 'fake-installer.jar'), [], '.', 'fake loader', {
    attempts: 1,
    spawnProcess: () => {
      setTimeout(() => {
        (child.stdout as EventEmitter).emit('data', Buffer.from('boom: installer failed\n'));
        child.emit('exit', 1);
      }, 10);
      return child;
    },
    killTree: () => undefined,
  });
  await assert.rejects(pending, /fake loader installer failed \(exit 1\):\n.*boom: installer failed/);
});

test('extractZip: an aborted signal rejects with a cancelled error and cleans partial output', async () => {
  const temp = tempRoot('msm-unit-cancel-extract');
  try {
    const src = path.join(temp.root, 'src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'a.txt'), 'alpha');
    const zip = path.join(temp.root, 'cancel.zip');
    await writeZip(zip, await collectInputs(src, ['a.txt']));
    const controller = new AbortController();
    controller.abort();
    await expectCancelled(extractZip(zip, path.join(temp.root, 'out'), { skipExisting: false, signal: controller.signal }), 'extractZip abort');
    assert.equal(fs.existsSync(path.join(temp.root, 'out')), false);
  } finally {
    temp.cleanup();
  }
});
