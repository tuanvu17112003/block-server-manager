// Server lifecycle — java child supervision + `server://log|status` events + ring buffer.
// Start runs the 4-layer boot defense (L2 jar scan from the install sidecar; L3 crash loop),
// and KEEPS the server running on success (unlike the spike's verify-then-stop).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { launchCommand, ensureServerProperties, writeEula, freePort, analyzeFailure, parseCrashReports, scanModIds, applyJarSideness } from './installer/core';
import { makeCuratedResolver, appendLearned } from './installer/curated';
import { fetchModrinthDependency } from './installer/modrinth';
import { readProperties, writePropertyValues } from './properties';
import type { Store, ServerDto } from './store';

type Status = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';

interface Running {
  proc: ChildProcess;
  ring: string[];
  status: Status;
  startedAt: number;
  logStream?: fs.WriteStream;
  stopTimer?: NodeJS.Timeout;
}

interface Sidecar { platform?: 'modrinth' | 'curseforge'; slug?: string | null; files?: string[] }

export class ServerProcesses {
  private running = new Map<string, Running>();

  constructor(private store: Store, private dataRoot: string, private send: (channel: string, payload: unknown) => void, private resolveJava: (dto: ServerDto) => Promise<string>) {}

  serverDir(id: string): string { return path.join(this.dataRoot, 'servers', id); }

  private setStatus(id: string, status: Status): void {
    const r = this.running.get(id);
    if (r) r.status = status;
    this.store.updateServer(id, { status });
    this.send(`server://status/${id}`, { status });
  }

  status(id: string): Status { return this.running.get(id)?.status ?? 'stopped'; }

  isBusy(id: string): boolean { return this.running.has(id); }

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
              try { process.kill(pid); } catch { /* termination is best effort */ }
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
    if (this.running.has(id)) throw Object.assign(new Error('Server already running.'), { code: 'conflict' });
    const dto = this.store.getServer(id);
    if (!dto) throw Object.assign(new Error(`Server ${id} not found.`), { code: 'not-found' });
    const dir = this.serverDir(id);
    if (!dto.eulaAccepted) throw Object.assign(new Error('EULA must be accepted before starting.'), { code: 'validation' });
    writeEula(dir);
    // server.properties is authoritative; if its port is taken, pick a free one and persist it.
    const configured = Number(readProperties(dir).values['server-port']);
    const preferred = Number.isInteger(configured) && configured > 0 ? configured : dto.port;
    const port = await freePort(preferred);
    writePropertyValues(dir, { 'server-port': String(port) });
    ensureServerProperties(dir, port);
    if (port !== dto.port) this.store.updateServer(id, { port });
    const javaExe = await this.resolveJava(dto);
    const cmd = launchCommand(dir, javaExe);
    if (!cmd.args.some(a => a.startsWith('-Xmx'))) cmd.args.unshift(`-Xmx${dto.ramMb}M`);
    if (!cmd.args.some(a => a.startsWith('-Xms'))) cmd.args.unshift(`-Xms${dto.ramMb}M`);

    // L2: disable jars that declare themselves client-side (protect community force-includes).
    const sidecar = this.readSidecar(dir);
    const curated = sidecar?.platform
      ? makeCuratedResolver({ platform: sidecar.platform, packSlug: sidecar.slug ?? null, presentPaths: sidecar.files ?? [] })
      : null;
    await applyJarSideness(path.join(dir, 'mods'), curated?.protectBasenames ?? new Set());

    this.setStatus(id, 'starting');
    for (let round = 1; round <= 8; round++) {
      const watch = this.spawnWatch(id, dto, dir, cmd);
      const outcome = await watch.started; // resolves on Done( (running) or early exit (crashed/stopped)
      if (outcome === 'running') return;
      await watch.exited; // wait for the dead process before retry rounds read crash data
      if (outcome === 'stopped') return; // user stop during startup
      // crashed before Done( → L3: attribute + disable + learn + retry
      const r = this.running.get(id);
      const tail = r?.ring.slice(-400) ?? [];
      this.running.delete(id);
      const { disable, add } = analyzeFailure(tail);
      const crashJars = parseCrashReports(dir);
      const all = new Set([...disable, ...crashJars.keys()]);
      let acted = false;
      const idMap = await scanModIds(path.join(dir, 'mods'));
      if (all.size) {
        fs.mkdirSync(path.join(dir, 'mods-disabled'), { recursive: true });
        const learned: { match: string; why: string }[] = [];
        for (const mid of all) {
          const jar = idMap.get(mid) ?? crashJars.get(mid);
          if (jar && fs.existsSync(path.join(dir, 'mods', jar))) {
            fs.renameSync(path.join(dir, 'mods', jar), path.join(dir, 'mods-disabled', jar));
            learned.push({ match: mid, why: `auto: crashed on start (${jar})` });
            acted = true;
          }
        }
        if (learned.length > 0) appendLearned(learned);
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
      this.setStatus(id, 'starting');
    }
    this.setStatus(id, 'crashed');
  }

  /** Spawn and watch. `started` resolves at Done( (running), user stop (stopped) or early exit (crashed);
   *  `exited` resolves when the process is gone. start() must NOT await process lifetime. */
  private spawnWatch(id: string, dto: ServerDto, dir: string, cmd: { exe: string; args: string[] }): { started: Promise<'running' | 'stopped' | 'crashed'>; exited: Promise<void> } {
    const proc = spawn(cmd.exe, cmd.args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    const r: Running = { proc, ring: [], status: 'starting', startedAt: Date.now() };
    try {
      const logDir = path.join(dir, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, 'msm-console.log');
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 10 * 1024 * 1024) {
        fs.renameSync(logFile, `${logFile}.1`);
      }
      r.logStream = fs.createWriteStream(logFile, { flags: 'a' });
    } catch {
      // A missing log file only costs history; the live stream still works.
    }
    if (proc.pid) {
      try { fs.writeFileSync(path.join(dir, '.msm-server.pid'), String(proc.pid)); } catch { /* identity is best effort */ }
    }
    this.running.set(id, r);
    let resolveStarted!: (v: 'running' | 'stopped' | 'crashed') => void;
    const started = new Promise<'running' | 'stopped' | 'crashed'>(res => { resolveStarted = res; });
    let resolveExited!: () => void;
    const exited = new Promise<void>(res => { resolveExited = res; });
    this.wireWatch(id, r, dto, proc, resolveStarted, resolveExited);
    return { started, exited };
  }

  private wireWatch(id: string, r: Running, dto: ServerDto, proc: import('node:child_process').ChildProcess, resolveStarted: (v: 'running' | 'stopped' | 'crashed') => void, resolveExited: () => void): void {
    let sawDone = false;
    let userStop = false;
    // startup watchdog (spec §5): Done( within 10 min or the start is treated as a crash
    const bootWatch = setTimeout(() => {
      if (!sawDone && !userStop) { try { proc.kill('SIGKILL'); } catch { /* gone */ } }
    }, 10 * 60_000);
    proc.once('exit', () => clearTimeout(bootWatch));
    const onLine = (line: string): void => {
      r.ring.push(line);
      if (r.ring.length > 5000) r.ring.shift();
      try { r.logStream?.write(line + '\n'); } catch { /* log history is best effort */ }
      this.send(`server://log/${id}`, line);
      if (!sawDone && /Done \(\d/.test(line)) { sawDone = true; this.setStatus(id, 'running'); resolveStarted('running'); }
    };
    let buf = '';
    const onData = (d: Buffer): void => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (l.trim()) onLine(l); }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.once('exit', code => {
      this.running.delete(id);
      try { r.logStream?.end(); } catch { /* already closed */ }
      try { fs.rmSync(path.join(this.serverDir(id), '.msm-server.pid'), { force: true }); } catch { /* best effort */ }
      this.setStatus(id, userStop || (sawDone && code === 0) ? 'stopped' : 'crashed');
      resolveStarted(userStop ? 'stopped' : 'crashed');
      resolveExited();
    });
    // watch for user stop requests while starting
    const stopProbe = setInterval(() => {
      if (r.status === 'stopping') { userStop = true; clearInterval(stopProbe); }
      if (!this.running.has(id)) clearInterval(stopProbe);
    }, 500);
    proc.once('exit', () => clearInterval(stopProbe));
    void dto;
  }

  stop(id: string): Promise<void> {
    const r = this.running.get(id);
    if (!r) return Promise.resolve();
    this.setStatus(id, 'stopping');
    return new Promise(resolve => {
      try { r.proc.stdin?.write('stop\n'); } catch { /* gone */ }
      const timer = setTimeout(() => this.kill(id), 30_000);
      r.proc.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  kill(id: string): void {
    const r = this.running.get(id);
    if (r && r.proc.pid) { try { r.proc.kill('SIGKILL'); } catch { /* already dead */ } }
  }

  async restart(id: string): Promise<void> { await this.stop(id); await new Promise(res => setTimeout(res, 1500)); await this.start(id); }

  /** Raw stdin write for internal orchestration (save-off/list); callers own the history decision. */
  command(id: string, cmd: string): void {
    const r = this.running.get(id);
    if (!r) throw Object.assign(new Error('Server not running.'), { code: 'conflict' });
    r.proc.stdin?.write(cmd + '\n');
  }

  sendCommand(id: string, cmd: string): void {
    this.command(id, cmd);
    this.store.pushCommand(id, cmd);
  }

  tail(id: string, lines: number): string[] {
    const r = this.running.get(id);
    if (r) return r.ring.slice(-lines);
    // After a restart the ring is gone; the append-only console log keeps the history.
    try {
      const text = fs.readFileSync(path.join(this.serverDir(id), 'logs', 'msm-console.log'), 'utf8');
      return text.split('\n').filter((line) => line.trim() !== '').slice(-lines);
    } catch {
      return [];
    }
  }

  stopAll(): Promise<void[]> {
    return Promise.all([...this.running.keys()].map(id => this.stop(id)));
  }
}
