// Server lifecycle — java child supervision + `server://log|status` events + ring buffer.
// Start runs the 4-layer boot defense (L2 jar scan from the install sidecar; L3 crash loop),
// and KEEPS the server running on success (unlike the spike's verify-then-stop).
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { launchCommand, ensureServerProperties, analyzeFailure, parseCrashReports, scanModIds, applyJarSideness } from './installer/core';
import { makeCuratedResolver, appendLearned } from './installer/curated';
import { fetchModrinthDependency } from './installer/modrinth';
import { readProperties, readEulaState } from './properties';
import { assertPortAvailable } from './validate-args';
import { appError, type Store, type ServerDto } from './store';

type Status = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';
type StartOutcome = 'running' | 'stopped' | 'crashed';

interface LogEntry {
  seq: number;
  text: string;
}

interface Running {
  proc: ChildProcess;
  ring: string[];
  /** Monotonic per-server log sequence; consumers (players/metrics) use it instead of ring length. */
  entries: LogEntry[];
  seq: number;
  status: Status;
  startedAt: number;
  logStream?: fs.WriteStream;
  /** Set when the user asked to stop/kill: the final state must be `stopped`, not `crashed`. */
  userStop: boolean;
  /** Whether the `Done (` marker was observed for this child. */
  sawDone: boolean;
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  userStop: boolean;
  sawDone: boolean;
  ring: string[];
  spawnError: Error | null;
}

interface PreparedLaunch {
  dir: string;
  cmd: { exe: string; args: string[] };
  learnedFile: string;
  /** Managed install platform (sidecar). `null` = unmanaged server: L2/L3 must not mutate it (D9). */
  sidecarPlatform: 'modrinth' | 'curseforge' | null;
}

export interface ReadinessPayload {
  phase: 'preparing' | 'spawning' | 'spawned' | 'retrying' | 'ready' | 'stopped' | 'failed';
  attempt?: number;
  pid?: number | null;
  message?: string;
}

interface Sidecar { platform?: 'modrinth' | 'curseforge'; slug?: string | null; files?: string[] }

export interface ServerProcessOptions {
  /** Test seam: inject a fake child process instead of spawning java. Never used in production. */
  spawnOverride?: (exe: string, args: string[], options: SpawnOptions) => ChildProcess;
  /** Test seam: intercept a force-kill instead of taskkill/process.kill. Never used in production. */
  killOverride?: (pid: number) => void;
}

/** JVM identity marker baked into every launch (Rust parity: `-Dtestmultiai.server.id=<id>`). */
const IDENTITY_FLAG = '-Dtestmultiai.server.id=';

/** Only a real `eula=true` line in eula.txt counts (B-20); see properties.ts readEulaState. */

/** Read up to `maxLines` trailing lines from a log file, bounded to `maxBytes` from the end. */
async function readTailLines(file: string, maxLines: number, maxBytes = 16 * 1024 * 1024): Promise<string[]> {
  let handle: fsp.FileHandle;
  try { handle = await fsp.open(file, 'r'); } catch { return []; }
  try {
    const stats = await handle.stat();
    const readBytes = Math.min(stats.size, maxBytes);
    if (readBytes <= 0) return [];
    const buffer = Buffer.alloc(readBytes);
    await handle.read(buffer, 0, readBytes, stats.size - readBytes);
    const lines = buffer.toString('utf8').split('\n').filter((line) => line.trim() !== '');
    // When the file is larger than the window we started mid-line: drop the partial first line.
    if (stats.size > readBytes && lines.length > 0) lines.shift();
    return lines.slice(-maxLines);
  } finally {
    await handle.close();
  }
}

function processCommandLine(pid: number): string | null {
  if (process.platform !== 'win32') return null;
  const script = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  const output = (result.stdout ?? '').trim();
  return output === '' ? '' : output;
}

export class ServerProcesses {
  private running = new Map<string, Running>();
  /** Reserved before the first await so duplicate `server_start` calls cannot spawn twice (B-03). */
  private starting = new Set<string>();
  /** User asked to stop during a boot/retry loop: the loop must abort instead of respawning. */
  private stopRequested = new Set<string>();

  constructor(
    private store: Store,
    private dataRoot: string,
    private send: (channel: string, payload: unknown) => void,
    private resolveJava: (dto: ServerDto) => Promise<string>,
    private options: ServerProcessOptions = {},
  ) {}

  serverDir(id: string): string { return path.join(this.dataRoot, 'servers', id); }

  private setStatus(id: string, status: Status): void {
    const running = this.running.get(id);
    if (running) running.status = status;
    this.store.updateServer(id, { status });
    this.send(`server://status/${id}`, { status });
  }

  /** Persist an intermediate status without emitting a user-visible event (boot retries). */
  private setStatusQuiet(id: string, status: Status): void {
    const running = this.running.get(id);
    if (running) running.status = status;
    this.store.updateServer(id, { status });
  }

  status(id: string): Status { return this.running.get(id)?.status ?? 'stopped'; }

  isBusy(id: string): boolean { return this.running.has(id) || this.starting.has(id); }

  pid(id: string): number | null { return this.running.get(id)?.proc.pid ?? null; }

  startedAt(id: string): number | null { return this.running.get(id)?.startedAt ?? null; }

  runningIds(): string[] {
    return [...this.running.entries()]
      .filter(([, running]) => running.status === 'running')
      .map(([id]) => id);
  }

  history(id: string): string[] { return this.running.get(id)?.ring ?? []; }

  /** Monotonic log sequence for a running server (0 when not running). */
  lineSeq(id: string): number { return this.running.get(id)?.seq ?? 0; }

  /** Entries appended after `fromSeq` (ascending), bounded to `limit` newest. */
  entriesSince(id: string, fromSeq: number, limit = 500): LogEntry[] {
    const running = this.running.get(id);
    if (!running) return [];
    const out: LogEntry[] = [];
    for (let index = running.entries.length - 1; index >= 0 && out.length < limit; index -= 1) {
      const entry = running.entries[index]!;
      if (entry.seq <= fromSeq) break;
      out.push(entry);
    }
    return out.reverse();
  }

  /**
   * Boot-time reaping: kill only a PID whose image is java AND whose command line carries this
   * server's identity marker (fail closed otherwise; Rust parity). Normalize every tracked status
   * because nothing is tracked yet; unverified live processes are reported, never killed.
   */
  async reapOrphans(): Promise<void> {
    for (const dto of this.store.listServers()) {
      const dir = this.serverDir(dto.id);
      const pidFiles = [path.join(dir, '.msm-server.pid'), path.join(dir, 'server.lock')];
      let handled = false;
      for (const pidFile of pidFiles) {
        let pid = 0;
        try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/)[0]); } catch { continue; }
        if (!Number.isInteger(pid) || pid <= 0) continue;
        handled = true;
        let alive = false;
        try { process.kill(pid, 0); alive = true; } catch { /* already gone */ }
        if (alive) {
          const commandLine = processCommandLine(pid);
          if (commandLine === null) {
            console.warn(`[reap] ${dto.name}: cannot inspect pid ${pid} (CIM unavailable) — leaving it untouched (fail closed).`);
            this.store.updateServer(dto.id, { status: 'crashed' });
            continue;
          }
          if (!/java/i.test(commandLine) || !commandLine.includes(`${IDENTITY_FLAG}${dto.id}`)) {
            console.warn(`[reap] ${dto.name}: pid ${pid} is not this server's java process — leaving it untouched (fail closed).`);
            this.store.updateServer(dto.id, { status: 'crashed' });
            continue;
          }
          this.killPid(pid);
          console.log(`[reap] killed orphaned java pid ${pid} for ${dto.name}`);
        }
        try { fs.rmSync(pidFile, { force: true }); } catch { /* best effort */ }
      }
      if (!handled) {
        // No lockfile: only normalize rows that claim a live state.
        if (['running', 'starting', 'stopping'].includes(dto.status)) this.store.updateServer(dto.id, { status: 'stopped' });
      }
    }
  }

  private readSidecar(dir: string): Sidecar | null {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'msm-install.json'), 'utf8')) as Sidecar; } catch { return null; }
  }

  async start(id: string): Promise<void> { await this.startWithMode(id, false); }

  /** Fast-ack start for the IPC layer: preparation errors reject; boot/auto-fix continues in the
   *  background and is reported through `server://status` + `server://readiness` events (D8). */
  async startDetached(id: string): Promise<void> { await this.startWithMode(id, true); }

  /** Restart that returns once the new launch has been prepared/spawned (events drive the rest). */
  async restartDetached(id: string): Promise<void> {
    if (this.starting.has(id)) throw appError('conflict', 'Server is starting; wait for it to finish before restarting.');
    await this.stop(id);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await this.startDetached(id);
  }

  private async startWithMode(id: string, detach: boolean): Promise<void> {
    if (this.running.has(id) || this.starting.has(id)) throw appError('conflict', 'Server already running.');
    const dto = this.store.getServer(id);
    if (!dto) throw appError('not-found', `Server ${id} not found.`);
    this.starting.add(id);
    this.stopRequested.delete(id);
    this.emitReadiness(id, { phase: 'preparing' });
    let prepared: PreparedLaunch;
    try {
      prepared = await this.prepareLaunch(id, dto);
    } catch (error) {
      this.starting.delete(id);
      this.stopRequested.delete(id);
      this.emitReadiness(id, { phase: 'failed', message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    const finalized = this.bootLoop(id, dto, prepared).finally(() => {
      this.starting.delete(id);
      this.stopRequested.delete(id);
    });
    if (detach) {
      void finalized.catch((error: unknown) => {
        try { if (this.running.has(id)) this.killTree(id); } catch { /* best effort */ }
        try { this.setStatus(id, 'crashed'); } catch { /* server may be gone */ }
        this.emitReadiness(id, { phase: 'failed', message: error instanceof Error ? error.message : String(error) });
        console.error(`[start/${id}] ${(error as Error)?.message ?? error}`);
      });
      return;
    }
    try {
      await finalized;
    } catch (error) {
      if (this.running.has(id)) this.killTree(id);
      try { this.setStatus(id, 'stopped'); } catch { /* server may be gone */ }
      this.emitReadiness(id, { phase: 'failed', message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private emitReadiness(id: string, payload: ReadinessPayload): void {
    this.send(`server://readiness/${id}`, { serverId: id, ...payload, at: new Date().toISOString() });
  }

  private async prepareLaunch(id: string, dto: ServerDto): Promise<PreparedLaunch> {
    const dir = this.serverDir(id);
    // EULA authority (B-20): the JSON flag and the file must BOTH say accepted. Never auto-write
    // `eula=true` here; acceptance is only written by an explicit Settings/Create action.
    if (!dto.eulaAccepted) throw appError('validation', 'EULA must be accepted before starting.');
    if (!readEulaState(dir).accepted) {
      throw appError('validation', 'This server\'s eula.txt does not accept the Minecraft EULA. Open Settings and accept it explicitly before starting.');
    }
    // server.properties is authoritative. A port that is no longer free is a conflict now:
    // silently starting on a different port breaks the address the user configured (B-22).
    const configured = Number(readProperties(dir).values['server-port']);
    const preferred = Number.isInteger(configured) && configured > 0 ? configured : dto.port;
    const port = await assertPortAvailable(preferred);
    ensureServerProperties(dir, port);
    if (port !== dto.port) this.store.updateServer(id, { port });

    const javaExe = await this.resolveJava(dto);
    if (!javaExe || !fs.existsSync(javaExe)) {
      throw appError('io', `Java executable not found: ${javaExe ?? '(none)'}. Install or select a Java runtime in Settings.`);
    }
    const cmd = launchCommand(dir, javaExe);
    // Identity marker: lets boot-time reaping prove a java process is ours (B-14).
    if (!cmd.args.some((arg) => arg.startsWith(IDENTITY_FLAG))) cmd.args.unshift(`${IDENTITY_FLAG}${id}`);
    if (!cmd.args.some((arg) => arg.startsWith('-Xmx'))) cmd.args.unshift(`-Xmx${dto.ramMb}M`);
    if (!cmd.args.some((arg) => arg.startsWith('-Xms'))) cmd.args.unshift(`-Xms${dto.ramMb}M`);

    // L2: only managed installs are mutated (reference/spike install-time defense). Unmanaged
    // servers are never auto-modified (D9), while managed packs keep the community protect set.
    const sidecar = this.readSidecar(dir);
    const managed = sidecar !== null;
    if (managed) {
      const learnedFile = path.join(this.dataRoot, 'state', 'env-overrides-learned.json');
      const curated = sidecar?.platform
        ? makeCuratedResolver({ platform: sidecar.platform, packSlug: sidecar.slug ?? null, presentPaths: sidecar.files ?? [], learnedFile })
        : null;
      await applyJarSideness(path.join(dir, 'mods'), curated?.protectBasenames ?? new Set());
      return { dir, cmd, learnedFile, sidecarPlatform: sidecar.platform ?? null };
    }
    console.log(`[start] unmanaged server (no install sidecar): skipping L2/L3 auto-modification`);
    return { dir, cmd, learnedFile: '', sidecarPlatform: null };
  }

  private async bootLoop(id: string, dto: ServerDto, prepared: PreparedLaunch): Promise<void> {
    const { dir, cmd, learnedFile, sidecarPlatform } = prepared;
    this.setStatus(id, 'starting');
    for (let round = 1; round <= 8; round += 1) {
      if (this.stopRequested.has(id)) {
        this.setStatus(id, 'stopped');
        this.emitReadiness(id, { phase: 'stopped' });
        return;
      }
      this.emitReadiness(id, { phase: round === 1 ? 'spawning' : 'retrying', attempt: round });
      const watch = this.spawnWatch(id, dir, cmd, this.options.spawnOverride);
      this.emitReadiness(id, { phase: 'spawned', attempt: round, pid: this.running.get(id)?.proc.pid ?? null });
      const outcome = await watch.started; // resolves on Done(, user stop, or early exit
      if (outcome === 'running') {
        this.emitReadiness(id, { phase: 'ready', attempt: round, pid: this.running.get(id)?.proc.pid ?? null });
        return;
      }
      const exit = await watch.exited; // wait for the dead process before reading crash data
      if (outcome === 'stopped' || exit.userStop || this.stopRequested.has(id)) {
        this.setStatus(id, 'stopped');
        this.emitReadiness(id, { phase: 'stopped' });
        return;
      }
      // Spawn itself failed (e.g. deleted/invalid java.exe): surface a coded IO error, no retry.
      if (exit.spawnError) {
        this.emitReadiness(id, { phase: 'failed', attempt: round, message: exit.spawnError.message });
        throw appError('io', `Could not start the server process: ${exit.spawnError.message}`);
      }
      // Crashed before Done(: L3 attribution + disable + learn + retry. No user-visible crash
      // event until the retry loop gives up (avoids toast spam while auto-fixing).
      // D9 policy: unmanaged servers are never auto-modified; CurseForge packs are prune-only
      // (disable attributed jars, never fetch Modrinth dependencies); Modrinth managed packs may
      // fetch missing hard dependencies.
      if (sidecarPlatform === null) {
        this.setStatus(id, 'crashed');
        this.emitReadiness(id, { phase: 'failed', attempt: round, message: 'Unmanaged server crashed during boot; automatic mod repair is disabled for unmanaged servers.' });
        return;
      }
      const tail = exit.ring.slice(-400);
      const { disable, add } = analyzeFailure(tail);
      const crashJars = parseCrashReports(dir);
      const all = new Set([...disable, ...crashJars.keys()]);
      let acted = false;
      const idMap = await scanModIds(path.join(dir, 'mods'));
      if (all.size) {
        fs.mkdirSync(path.join(dir, 'mods-disabled'), { recursive: true });
        const learned: { match: string; why: string }[] = [];
        for (const modId of all) {
          const jar = idMap.get(modId) ?? crashJars.get(modId);
          if (jar && fs.existsSync(path.join(dir, 'mods', jar))) {
            fs.renameSync(path.join(dir, 'mods', jar), path.join(dir, 'mods-disabled', jar));
            learned.push({ match: modId, why: `auto: crashed on start (${jar})` });
            acted = true;
          }
        }
        // Learning must never crash a start (read-only/AV-locked data root is not fatal).
        try { if (learned.length > 0) appendLearned(learned, learnedFile); }
        catch (error) { console.warn(`[autofix r${round}] could not persist learned entries: ${(error as Error).message}`); }
      }
      if (sidecarPlatform === 'modrinth') {
        // L3 dependency fetch: a missing hard dependency from Modrinth is installed, not skipped.
        for (const depId of add) {
          if (idMap.has(depId)) continue;
          try {
            const jar = await fetchModrinthDependency({
              mc: dto.mcVersion,
              loader: dto.loader,
              modId: depId,
              modsDir: path.join(dir, 'mods'),
            });
            if (jar) {
              acted = true;
              console.log(`[autofix r${round}] added missing dependency ${depId} (${path.basename(jar)})`);
            }
          } catch (error) {
            console.log(`[autofix r${round}] could not fetch ${depId}: ${(error as Error).message}`);
          }
        }
      } else if (add.length > 0) {
        console.log(`[autofix r${round}] CurseForge pack: dependency fetch is prune-only; unresolved: ${add.join(', ')}`);
      }
      if (!acted) {
        this.setStatus(id, 'crashed');
        this.emitReadiness(id, { phase: 'failed', attempt: round, message: 'Server crashed during boot and auto-fix could not attribute a mod.' });
        return;
      }
      this.setStatusQuiet(id, 'starting');
    }
    this.setStatus(id, 'crashed');
    this.emitReadiness(id, { phase: 'failed', message: 'Server failed to start after 8 auto-fix rounds.' });
  }

  /** Spawn and watch. `started` resolves on Done( (running), user stop (stopped) or early exit
   *  (crashed); `exited` resolves with the full tail so the retry loop keeps its diagnostics. */
  private spawnWatch(
    id: string,
    dir: string,
    cmd: { exe: string; args: string[] },
    spawnOverride?: (exe: string, args: string[], options: SpawnOptions) => ChildProcess,
  ): { started: Promise<StartOutcome>; exited: Promise<ExitInfo> } {
    const running: Running = {
      proc: null as unknown as ChildProcess,
      ring: [],
      entries: [],
      seq: 0,
      status: 'starting',
      startedAt: Date.now(),
      userStop: false,
      sawDone: false,
    };
    let resolveStarted!: (value: StartOutcome) => void;
    let resolveExited!: (info: ExitInfo) => void;
    const started = new Promise<StartOutcome>((resolve) => { resolveStarted = resolve; });
    const exited = new Promise<ExitInfo>((resolve) => { resolveExited = resolve; });

    let spawnError: Error | null = null;
    let exitSettled = false;
    const settleExit = (info: Omit<ExitInfo, 'ring' | 'spawnError'>): void => {
      if (exitSettled) return;
      exitSettled = true;
      this.running.delete(id);
      try { running.logStream?.end(); } catch { /* already closed */ }
      try { fs.rmSync(path.join(this.serverDir(id), '.msm-server.pid'), { force: true }); } catch { /* best effort */ }
      try { fs.rmSync(path.join(this.serverDir(id), 'server.lock'), { force: true }); } catch { /* best effort */ }
      const info2: ExitInfo = { ...info, ring: [...running.ring], spawnError };
      if (info2.userStop) this.setStatus(id, 'stopped');
      else if (info2.sawDone) this.setStatus(id, 'crashed');
      else this.setStatusQuiet(id, 'starting');
      resolveStarted(info2.userStop ? 'stopped' : 'crashed');
      resolveExited(info2);
    };

    const proc = (spawnOverride ?? ((exe, args, options) => spawn(exe, args, options)))(cmd.exe, cmd.args, {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    running.proc = proc;
    try {
      const logDir = path.join(dir, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, 'msm-console.log');
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 10 * 1024 * 1024) {
        fs.renameSync(logFile, `${logFile}.1`);
      }
      running.logStream = fs.createWriteStream(logFile, { flags: 'a' });
    } catch {
      // A missing log file only costs history; the live stream still works.
    }
    if (proc.pid) {
      try { fs.writeFileSync(path.join(dir, '.msm-server.pid'), String(proc.pid)); } catch { /* identity is best effort */ }
      try { fs.writeFileSync(path.join(dir, 'server.lock'), String(proc.pid)); } catch { /* Rust-era lockfile parity */ }
    }
    this.running.set(id, running);

    proc.once('error', (error) => {
      spawnError = error;
      settleExit({ code: null, signal: null, userStop: false, sawDone: false });
    });
    proc.once('exit', (code, signal) => {
      settleExit({ code, signal, userStop: running.userStop, sawDone: running.sawDone });
    });

    const onLine = (rawLine: string): void => {
      // Bound a single line so a mod spamming a huge line cannot balloon memory or payloads (B-18).
      const line = rawLine.length > 4096 ? rawLine.slice(0, 4096) : rawLine;
      running.ring.push(line);
      if (running.ring.length > 5000) running.ring.shift();
      running.seq += 1;
      running.entries.push({ seq: running.seq, text: line });
      if (running.entries.length > 5000) running.entries.shift();
      try { running.logStream?.write(`${line}\n`); } catch { /* log history is best effort */ }
      this.send(`server://log/${id}`, line);
      if (!running.sawDone && /Done \(\d/.test(line)) {
        running.sawDone = true;
        this.setStatus(id, 'running');
        resolveStarted('running');
      }
    };
    let buf = '';
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString();
      let index: number;
      while ((index = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, index).replace(/\r$/, '');
        buf = buf.slice(index + 1);
        if (line.trim()) onLine(line);
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    return { started, exited };
  }

  stop(id: string): Promise<void> {
    this.stopRequested.add(id);
    const running = this.running.get(id);
    if (!running) return Promise.resolve();
    running.userStop = true;
    this.setStatus(id, 'stopping');
    if (running.proc.exitCode !== null || running.proc.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const done = (): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      try { running.proc.stdin?.write('stop\n'); } catch { /* already gone */ }
      timer = setTimeout(() => this.killTree(id), 30_000);
      running.proc.once('exit', done);
      // Safety net: never leave the IPC promise pending if the process vanishes without 'exit'.
      setTimeout(done, 35_000).unref?.();
    });
  }

  kill(id: string): void {
    this.stopRequested.add(id);
    const running = this.running.get(id);
    if (!running) return;
    running.userStop = true;
    this.setStatus(id, 'stopping');
    this.killTree(id);
  }

  async restart(id: string): Promise<void> {
    if (this.starting.has(id)) throw appError('conflict', 'Server is starting; wait for it to finish before restarting.');
    await this.stop(id);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await this.start(id);
  }

  /** Raw stdin write for internal orchestration (save-off/list); callers own the history decision. */
  command(id: string, cmd: string): void {
    const running = this.running.get(id);
    if (!running) throw appError('conflict', 'Server not running.');
    running.proc.stdin?.write(`${cmd}\n`);
  }

  sendCommand(id: string, cmd: string): void {
    const command = String(cmd ?? '').trim();
    if (command === '') throw appError('validation', 'Command must not be empty.');
    if (/[\r\n]/.test(command)) throw appError('validation', 'Command must be a single line.');
    if (command.length > 1024) throw appError('validation', 'Command is too long (maximum 1024 characters).');
    this.command(id, command);
    this.store.pushCommand(id, command);
  }

  /** Bounded, rotation-tolerant tail (async, never reads an unbounded 10 MB file synchronously). */
  async tail(id: string, lines: number): Promise<string[]> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw appError('validation', 'Invalid server id.');
    const wanted = Number.isFinite(lines) ? Math.max(1, Math.min(10_000, Math.floor(lines))) : 500;
    const running = this.running.get(id);
    if (running) return running.ring.slice(-wanted);
    const logDir = path.join(this.serverDir(id), 'logs');
    const current = await readTailLines(path.join(logDir, 'msm-console.log'), wanted);
    if (current.length >= wanted) return current.slice(-wanted);
    const older = await readTailLines(path.join(logDir, 'msm-console.log.1'), wanted - current.length);
    return [...older, ...current].slice(-wanted);
  }

  /** Force-kill the process tree (Windows: taskkill /T /F; elsewhere: SIGKILL). */
  private killTree(id: string): void {
    const pid = this.running.get(id)?.proc.pid;
    if (!pid) return;
    this.killPid(pid);
  }

  private killPid(pid: number): void {
    if (this.options.killOverride) {
      this.options.killOverride(pid);
      return;
    }
    if (process.platform === 'win32') {
      try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); return; } catch { /* fall back */ }
    }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }

  /** Bounded shutdown used by app quit: graceful stop for `budgetMs`, then kill survivors. */
  async stopAll(budgetMs = 5000): Promise<void[]> {
    const ids = [...this.running.keys()];
    if (ids.length === 0) return [];
    const graceful = Promise.all(ids.map((id) => this.stop(id).catch(() => undefined)));
    await Promise.race([graceful, new Promise<void>((resolve) => setTimeout(resolve, budgetMs))]);
    for (const id of [...this.running.keys()]) this.killTree(id);
    await Promise.race([
      Promise.all([...this.running.keys()].map((id) => this.stop(id).catch(() => undefined))),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);
    return [];
  }
}
