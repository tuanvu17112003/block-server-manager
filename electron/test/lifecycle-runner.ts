// Phase 2 lifecycle suite — deterministic start/stop/kill/retry/validation tests using a fake
// child process (no java, no network). Runs inside Electron via --lifetest on a temp data root.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { ServerProcesses, type ServerProcessOptions } from '../services/server-process';
import { Store } from '../services/store';
import { collectInputs, writeZip } from '../services/zip';
import { TestRun, sleep, waitUntil } from './harness';

export interface SuiteResult {
  ok: boolean;
  report: string;
}

interface FakeChildLike extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: (data: string) => boolean };
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  writes: string[];
  line: (text: string) => void;
  exit: (code: number | null) => void;
  kill: () => boolean;
}

class FakeChild extends EventEmitter implements FakeChildLike {
  pid: number;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin: { write: (data: string) => boolean };
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  writes: string[] = [];

  constructor(pid: number, onWrite?: (data: string) => void) {
    super();
    this.pid = pid;
    this.stdin = {
      write: (data: string) => {
        this.writes.push(data);
        onWrite?.(data);
        return true;
      },
    };
  }

  line(text: string): void {
    this.stdout.emit('data', Buffer.from(`${text}\n`));
  }

  exit(code: number | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.emit('exit', code, null);
  }

  kill(): boolean {
    this.signalCode = 'SIGKILL';
    queueMicrotask(() => this.emit('exit', null, 'SIGKILL'));
    return true;
  }
}

interface LifecycleFixture {
  store: Store;
  processes: ServerProcesses;
  serverId: string;
  serverDir: string;
  children: FakeChildLike[];
  events: { channel: string; payload: unknown }[];
}

/**
 * Build a ServerProcesses with an injectable fake spawn. `auto` runs after each spawn (queued so the
 * process watcher has attached its listeners before the fake emits).
 */
function fixture(
  root: string,
  name: string,
  auto?: (child: FakeChildLike, index: number) => void,
  extra?: (child: FakeChildLike, index: number) => void,
): LifecycleFixture {
  const store = new Store(root);
  const created = store.createServer({
    name, loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024, eulaAccepted: true,
  });
  const serverDir = path.join(root, 'servers', created.id);
  fs.mkdirSync(path.join(serverDir, 'world'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'server.jar'), 'fake-jar');
  fs.writeFileSync(path.join(serverDir, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(serverDir, 'server.properties'), 'server-port=25601\nlevel-name=world\n');
  fs.mkdirSync(path.join(serverDir, 'mods'), { recursive: true });
  // Managed-install sidecar: L2/L3 only run for managed servers (D9); fixtures exercise them.
  fs.writeFileSync(path.join(serverDir, 'msm-install.json'), JSON.stringify({ platform: 'modrinth', slug: null, files: [], loader: 'fabric', mc: '1.21.1' }));
  const javaPath = path.join(root, 'fake-java.exe');
  fs.writeFileSync(javaPath, 'fake');

  const children: FakeChildLike[] = [];
  const events: { channel: string; payload: unknown }[] = [];
  const options: ServerProcessOptions = {
    spawnOverride: (_exe: string, _args: string[], _options: SpawnOptions) => {
      const index = children.length;
      const child = new FakeChild(2_000_000 + index);
      children.push(child);
      if (extra) queueMicrotask(() => extra(child, index));
      if (auto) queueMicrotask(() => auto(child, index));
      return child as unknown as ChildProcess;
    },
    killOverride: (pid: number) => {
      const child = children.find((candidate) => candidate.pid === pid);
      child?.kill();
    },
  };
  const processes = new ServerProcesses(store, root, (channel, payload) => { events.push({ channel, payload }); }, async () => javaPath, options);
  const result: LifecycleFixture = { store, processes, serverId: created.id, serverDir, children, events };
  activeFixtures.push(result);
  return result;
}

async function statusOf(store: Store, id: string): Promise<string> {
  return store.getServer(id)?.status ?? 'missing';
}

async function makeClientModJar(root: string): Promise<void> {
  const src = path.join(root, 'clientmod-src');
  fs.mkdirSync(src, { recursive: true });
  // No `environment` declaration: L2 must NOT disable it; L3 must disable it after the boot crash.
  fs.writeFileSync(path.join(src, 'fabric.mod.json'), JSON.stringify({ id: 'foomod' }));
  const inputs = await collectInputs(src, ['fabric.mod.json']);
  await writeZip(path.join(root, 'clientmod.jar'), inputs);
}

const activeFixtures: LifecycleFixture[] = [];

export async function runLifecycleTests(root: string): Promise<SuiteResult> {
  const run = new TestRun('lifecycle');
  const progressFile = path.join(os.tmpdir(), 'msm-lifetest-progress.log');
  try { fs.writeFileSync(progressFile, `[lifecycle] start ${new Date().toISOString()}\n`); } catch { /* best effort */ }
  const progress = (message: string): void => {
    try { fs.appendFileSync(progressFile, `${new Date().toISOString()} ${message}\n`); } catch { /* best effort */ }
  };
  const scenario = async (name: string, fn: () => Promise<void>): Promise<void> => {
    progress(`START ${name}`);
    await run.must(name, fn);
    progress(`END ${name}`);
  };

  await scenario('duplicate start is rejected while the first start is in flight (B-03)', async () => {
    const f = fixture(root, 'dup-start');
    const first = f.processes.start(f.serverId);
    await waitUntil(() => f.children.length === 1, { timeoutMs: 5000, label: 'first spawn' });
    await assert.rejects(() => f.processes.start(f.serverId), (error: unknown) => (error as { code?: string }).code === 'conflict');
    f.children[0]!.line('Done (1.234s)! For help, type "help"');
    await first;
    assert.equal(await statusOf(f.store, f.serverId), 'running');
    assert.equal(f.children.length, 1);
  });

  await scenario('stop during boot writes stdin and ends stopped without respawn (B-17)', async () => {
    const f = fixture(root, 'stop-boot');
    const starting = f.processes.start(f.serverId);
    await waitUntil(() => f.children.length === 1, { timeoutMs: 5000, label: 'spawn' });
    const stopPromise = f.processes.stop(f.serverId);
    await waitUntil(() => f.children[0]!.writes.includes('stop\n'), { timeoutMs: 5000, label: 'stop stdin' });
    f.children[0]!.exit(0);
    await Promise.all([starting, stopPromise]);
    assert.equal(await statusOf(f.store, f.serverId), 'stopped');
    assert.equal(f.children.length, 1);
  });

  await scenario('kill marks user intent so the final status is stopped, not crashed (B-05)', async () => {
    const f = fixture(root, 'kill-intent', (child) => child.line('Done (0.900s)! For help, type "help"'));
    await f.processes.start(f.serverId);
    assert.equal(await statusOf(f.store, f.serverId), 'running');
    f.processes.kill(f.serverId);
    f.children[0]!.exit(1); // simulate the OS terminating the process
    await waitUntil(async () => (await statusOf(f.store, f.serverId)) === 'stopped', { timeoutMs: 5000, label: 'stopped status' });
    assert.equal(await statusOf(f.store, f.serverId), 'stopped');
  });

  await scenario('crash then successful retry after disabling a client mod keeps diagnostics (B-04)', async () => {
    await makeClientModJar(root);
    const f = fixture(root, 'retry', (child, index) => {
      if (index === 0) {
        child.line("Mod 'Foo' (foomod) has failed to load correctly");
        setTimeout(() => child.exit(1), 10);
      } else {
        child.line('Done (2.000s)! For help, type "help"');
      }
    });
    fs.copyFileSync(path.join(root, 'clientmod.jar'), path.join(f.serverDir, 'mods', 'clientmod.jar'));
    await f.processes.start(f.serverId);
    assert.equal(await statusOf(f.store, f.serverId), 'running');
    assert.equal(f.children.length, 2, 'expected exactly one retry');
    assert.ok(fs.existsSync(path.join(f.serverDir, 'mods-disabled', 'clientmod.jar')));
    // No user-visible crash event while auto-fix succeeded.
    assert.equal(f.events.some((event) => event.channel.endsWith('/status') && (event.payload as { status?: string }).status === 'crashed'), false);
  });

  await scenario('spawn failure rejects with an io error instead of hanging (B-10)', async () => {
    const f = fixture(root, 'spawn-error');
    const starting = f.processes.start(f.serverId);
    await waitUntil(() => f.children.length === 1, { timeoutMs: 5000, label: 'spawn' });
    f.children[0]!.emit('error', new Error('ENOENT: java not found'));
    await assert.rejects(() => starting, (error: unknown) => (error as { code?: string }).code === 'io');
    assert.equal(await statusOf(f.store, f.serverId), 'stopped');
  });

  await scenario('EULA file must say eula=true even when the record flag is true (B-20)', async () => {
    const f = fixture(root, 'eula');
    fs.writeFileSync(path.join(f.serverDir, 'eula.txt'), 'eula=false\n');
    await assert.rejects(() => f.processes.start(f.serverId), (error: unknown) => (error as { code?: string }).code === 'validation');
    assert.equal(f.children.length, 0);
    assert.equal(await statusOf(f.store, f.serverId), 'stopped');
  });

  await scenario('occupied port fails closed with conflict and does not rewrite the port (B-22)', async () => {
    const f = fixture(root, 'port');
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(25602, '127.0.0.1', () => resolve()));
    try {
      fs.writeFileSync(path.join(f.serverDir, 'server.properties'), 'server-port=25602\nlevel-name=world\n');
      await assert.rejects(() => f.processes.start(f.serverId), (error: unknown) => (error as { code?: string }).code === 'conflict');
      assert.equal(f.children.length, 0);
      const port = Number(f.store.getServer(f.serverId)?.port);
      assert.notEqual(port, 25602, 'start must not silently rewrite the persisted port');
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  await scenario('command validation rejects empty/multiline commands (B-18)', async () => {
    const f = fixture(root, 'console', (child) => child.line('Done (0.500s)! For help, type "help"'));
    await f.processes.start(f.serverId);
    assert.throws(() => f.processes.sendCommand(f.serverId, '   '), (error: unknown) => (error as { code?: string }).code === 'validation');
    assert.throws(() => f.processes.sendCommand(f.serverId, 'say a\nstop'), (error: unknown) => (error as { code?: string }).code === 'validation');
    f.processes.sendCommand(f.serverId, 'say ok');
    assert.ok(f.children[0]!.writes.includes('say ok\n'));
    assert.equal(f.store.commandHistory(f.serverId)[0], 'say ok');
  });

  await scenario('bounded async tail reads rotated console logs and validates ids (B-18/B-19)', async () => {
    const f = fixture(root, 'tail');
    const logDir = path.join(f.serverDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'msm-console.log.1'), ['old-1', 'old-2', 'old-3'].join('\n') + '\n');
    fs.writeFileSync(path.join(logDir, 'msm-console.log'), ['new-1', 'new-2'].join('\n') + '\n');
    const tail = await f.processes.tail(f.serverId, 4);
    assert.deepEqual(tail, ['old-2', 'old-3', 'new-1', 'new-2']);
    await assert.rejects(() => f.processes.tail('..\\escape', 10), (error: unknown) => (error as { code?: string }).code === 'validation');
  });

  await run.must('detached start acks quickly and reports readiness phases (D8)', async () => {
    const f = fixture(root, 'detached');
    const startedAt = Date.now();
    await f.processes.startDetached(f.serverId);
    const ackMs = Date.now() - startedAt;
    assert.ok(ackMs < 2000, `startDetached took ${ackMs}ms (must not wait for boot)`);
    assert.equal(await statusOf(f.store, f.serverId), 'starting');
    await waitUntil(() => f.children.length === 1, { timeoutMs: 5000, label: 'spawn' });
    f.children[0]!.line('Done (0.700s)! For help, type "help"');
    await waitUntil(async () => (await statusOf(f.store, f.serverId)) === 'running', { timeoutMs: 5000, label: 'running' });
    const phases = f.events
      .filter((event) => event.channel === `server://readiness/${f.serverId}`)
      .map((event) => (event.payload as { phase?: string }).phase);
    for (const phase of ['preparing', 'spawning', 'spawned', 'ready']) assert.ok(phases.includes(phase), `missing readiness phase ${phase} (got ${phases.join(',')})`);
  });

  // Dispose every fixture: stop fake children so their log streams close before the temp root is
  // removed (otherwise rmSync fails with ENOTEMPTY on Windows).
  for (const f of activeFixtures) {
    try { await f.processes.stopAll(0); } catch { /* already stopped */ }
  }
  await sleep(120);
  activeFixtures.length = 0;

  const lines = run.lines();
  if (lines.length === 0) lines.push('FAIL lifecycle/no checks ran');
  return { ok: run.ok, report: lines.join('\n') };
}
