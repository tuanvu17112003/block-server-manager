// Server lifecycle — java child supervision + `server://log|status` events + ring buffer.
// Start runs the 4-layer boot defense (L2 jar scan from the install sidecar; L3 crash loop),
// and KEEPS the server running on success (unlike the spike's verify-then-stop).
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { launchCommand, ensureServerProperties, writeEula, freePort, analyzeFailure, parseCrashReports, scanModIds, applyJarSideness } from './installer/core';
import { makeCuratedResolver, appendLearned } from './installer/curated';
import { fetchModrinthDependency } from './installer/modrinth';
import { readProperties, writePropertyValues } from './properties';
import { appError, type Store, type ServerDto } from './store';

type Status = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';
type StartOutcome = 'running' | 'stopped' | 'crashed';

interface Running {
  proc: ChildProcess;
  ring: string[];
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

interface Sidecar { platform?: 'modrinth' | 'curseforge'; slug?: string | null; files?: string[] }

export class ServerProcesses {
  private running = new Map<string, Running>();
  /** Reserved before the first await so duplicate `server_start` calls cannot spawn twice (B-03). */
  private starting = new Set<string>();

  constructor(
    private store: Store,
    private dataRoot: string,
    private send: (channel: string, payload: unknown) => void,
    private resolveJava: (dto: ServerDto) => Promise<string>,
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

  /**
   * Boot-time reaping: a crash leaves the row `running` and a java child alive. Kill only a PID
   * whose image is still Java, then normalize every live status because nothing is tracked yet.
   */
  async reapOrphans(): Promise<void> {
    for (const dto of this.store.listServers()) {
      const pidFile = path.join(this.serverDir(dto.id), '.msm-server.pid');
      try {
        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        if (Number.isInteger(pid) && pid > 0) {
          let alive = false;
          try { process.kill(pid, 0); alive = true; } catch { /* already gone */ }
          if (alive) {
            const image = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
            if (/java/i.test(image.stdout ?? '')) {
              this.killPid(pid);
              console.log(`[reap] killed orphaned java pid ${pid} for ${dto.name}`);
            }
          }
        }
      } catch {
        // No pid file: the clean path.
      }
      try { fs.rmSync(pidFile, { force: true }); } catch { /* best effort */ }
      if (['running', 'starting', 'stopping'].includes(dto.status)) {
        this.store.updateServer(dto.id, { status: 'stopped' });
      }
    }
  }

  private readSidecar(dir: string): Sidecar | null {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'msm-install.json'), 'utf8')) as Sidecar; } catch { return null; }
  }

  async start(id: string): Promise<void> {
    if (this.running.has(id) || this.starting.has(id)) throw appError('conflict', 'Server already running.');
    const dto = this.store.getServer(id);
    if (!dto) throw appError('not-found', `Server ${id} not found.`);
    this.starting.add(id);
    try {
      await this.startInner(id, dto);
    } catch (error) {
      if (this.running.has(id)) this.killTree(id);
      try { this.setStatus(id, 'stopped'); } catch { /* server may be gone */ }
      throw error;
    } finally {
      this.starting.delete(id);
    }
  }

  private async startInner(id: string, dto: ServerDto): Promise<void> {
    const dir = this.serverDir(id);
    if (!dto.eulaAccepted) throw appError('validation', 'EULA must be accepted before starting.');
    writeEula(dir);
    // server.properties is authoritative; if its port is taken, pick a free one and persist it.
    const configured = Number(readProperties(dir).values['server-port']);
    const preferred = Number.isInteger(configured) && configured > 0 ? configured : dto.port;
    const port = await freePort(preferred);
    writePropertyValues(dir, { 'server-port': String(port) });
    ensureServerProperties(dir, port);
    if (port !== dto.port) this.store.updateServer(id, { port });

    const javaExe = await this.resolveJava(dto);
    if (!javaExe || !fs.existsSync(javaExe)) {
      throw appError('io', `Java executable not found: ${javaExe ?? '(none)'}. Install or select a Java runtime in Settings.`);
    }
    const cmd = launchCommand(dir, javaExe);
    if (!cmd.args.some((arg) => arg.startsWith('-Xmx'))) cmd.args.unshift(`-Xmx${dto.ramMb}M`);
    if (!cmd.args.some((arg) => arg.startsWith('-Xms'))) cmd.args.unshift(`-Xms${dto.ramMb}M`);

    // L2: disable jars that declare themselves client-side (protect community force-includes).
    const sidecar = this.readSidecar(dir);
    const learnedFile = path.join(this.dataRoot, 'state', 'env-overrides-learned.json');
    const curated = sidecar?.platform
      ? makeCuratedResolver({ platform: sidecar.platform, packSlug: sidecar.slug ?? null, presentPaths: sidecar.files ?? [], learnedFile })
      : null;
    await applyJarSideness(path.join(dir, 'mods'), curated?.protectBasenames ?? new Set());

    this.setStatus(id, 'starting');
    for (let round = 1; round <= 8; round += 1) {
      const watch = this.spawnWatch(id, dir, cmd);
      const outcome = await watch.started; // resolves on Done(, user stop, or early exit
      if (outcome === 'running') return;
      const exit = await watch.exited; // wait for the dead process before reading crash data
      if (outcome === 'stopped' || exit.userStop) {
        this.setStatus(id, 'stopped');
        return;
      }
      // Spawn itself failed (e.g. deleted/invalid java.exe): surface a coded IO error, no retry.
      if (exit.spawnError) throw appError('io', `Could not start the server process: ${exit.spawnError.message}`);
      // Crashed before Done(: L3 attribution + disable + learn + retry. No user-visible crash
      // event until the retry loop gives up (avoids toast spam while auto-fixing).
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
      if (!acted) { this.setStatus(id, 'crashed'); return; }
      this.setStatusQuiet(id, 'starting');
    }
    this.setStatus(id, 'crashed');
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
    }
    this.running.set(id, running);

    proc.once('error', (error) => {
      spawnError = error;
      settleExit({ code: null, signal: null, userStop: false, sawDone: false });
    });
    proc.once('exit', (code, signal) => {
      settleExit({ code, signal, userStop: running.userStop, sawDone: running.sawDone });
    });

    const onLine = (line: string): void => {
      running.ring.push(line);
      if (running.ring.length > 5000) running.ring.shift();
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
    const running = this.running.get(id);
    if (!running) return;
    running.userStop = true;
    this.setStatus(id, 'stopping');
    this.killTree(id);
  }

  async restart(id: string): Promise<void> { await this.stop(id); await new Promise((resolve) => setTimeout(resolve, 1500)); await this.start(id); }

  /** Raw stdin write for internal orchestration (save-off/list); callers own the history decision. */
  command(id: string, cmd: string): void {
    const running = this.running.get(id);
    if (!running) throw appError('conflict', 'Server not running.');
    running.proc.stdin?.write(`${cmd}\n`);
  }

  sendCommand(id: string, cmd: string): void {
    this.command(id, cmd);
    this.store.pushCommand(id, cmd);
  }

  tail(id: string, lines: number): string[] {
    const running = this.running.get(id);
    if (running) return running.ring.slice(-lines);
    // After a restart the ring is gone; the append-only console log keeps the history.
    try {
      const text = fs.readFileSync(path.join(this.serverDir(id), 'logs', 'msm-console.log'), 'utf8');
      return text.split('\n').filter((line) => line.trim() !== '').slice(-lines);
    } catch {
      return [];
    }
  }

  /** Force-kill the process tree (Windows: taskkill /T /F; elsewhere: SIGKILL). */
  private killTree(id: string): void {
    const pid = this.running.get(id)?.proc.pid;
    if (!pid) return;
    this.killPid(pid);
  }

  private killPid(pid: number): void {
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
