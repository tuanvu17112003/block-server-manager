// Server lifecycle — java child supervision + `server://log|status` events + ring buffer.
// Start runs the 4-layer boot defense (L2 jar scan from the install sidecar; L3 crash loop),
// and KEEPS the server running on success (unlike the spike's verify-then-stop).
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { launchCommand, ensureServerProperties, writeEula, freePort, analyzeFailure, parseCrashReports, scanModIds, applyJarSideness } from './installer/core';
import { makeCuratedResolver, appendLearned } from './installer/curated';
import type { Store, ServerDto } from './store';

type Status = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';

interface Running {
  proc: ChildProcess;
  ring: string[];
  status: Status;
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
    const port = await freePort(dto.port);
    ensureServerProperties(dir, port);
    const javaExe = await this.resolveJava(dto);
    const cmd = launchCommand(dir, javaExe);
    if (!cmd.args.some(a => a.startsWith('-Xmx'))) cmd.args.unshift(`-Xmx${dto.ramMb}M`);

    // L2: disable jars that declare themselves client-side (protect community force-includes).
    const sidecar = this.readSidecar(dir);
    const curated = sidecar?.platform
      ? makeCuratedResolver({ platform: sidecar.platform, packSlug: sidecar.slug ?? null, presentPaths: sidecar.files ?? [] })
      : null;
    await applyJarSideness(path.join(dir, 'mods'), curated?.protectBasenames ?? new Set());

    this.setStatus(id, 'starting');
    for (let round = 1; round <= 6; round++) {
      const outcome = await this.spawnWatch(id, dto, dir, cmd);
      if (outcome === 'running') return;
      if (outcome === 'stopped') return; // user stop during startup
      // crashed before Done( → L3: attribute + disable + learn + retry
      const r = this.running.get(id);
      const tail = r?.ring.slice(-400) ?? [];
      this.running.delete(id);
      const { disable } = analyzeFailure(tail);
      const crashJars = parseCrashReports(dir);
      const all = new Set([...disable, ...crashJars.keys()]);
      let acted = false;
      if (all.size) {
        const idMap = await scanModIds(path.join(dir, 'mods'));
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
        appendLearned(learned);
      }
      if (!acted) { this.setStatus(id, 'crashed'); return; }
      this.setStatus(id, 'starting');
    }
    this.setStatus(id, 'crashed');
  }

  /** Spawn and watch until Done( (→ running, keep alive), user stop (→ stopped) or early exit (→ crashed). */
  private spawnWatch(id: string, dto: ServerDto, dir: string, cmd: { exe: string; args: string[] }): Promise<'running' | 'stopped' | 'crashed'> {
    const proc = spawn(cmd.exe, cmd.args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    const r: Running = { proc, ring: [], status: 'starting' };
    this.running.set(id, r);
    return new Promise(resolve => {
      let sawDone = false;
      let userStop = false;
      const onLine = (line: string): void => {
        r.ring.push(line);
        if (r.ring.length > 5000) r.ring.shift();
        this.send(`server://log/${id}`, line);
        if (!sawDone && /Done \(\d/.test(line)) { sawDone = true; this.setStatus(id, 'running'); }
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
        this.setStatus(id, userStop || (sawDone && code === 0) ? 'stopped' : sawDone ? 'crashed' : userStop ? 'stopped' : 'crashed');
        resolve(sawDone ? 'running-then-exit' as 'running' : userStop ? 'stopped' : 'crashed');
      });
      // watch for user stop requests while starting
      const stopProbe = setInterval(() => {
        if (r.status === 'stopping') { userStop = true; clearInterval(stopProbe); }
        if (!this.running.has(id)) clearInterval(stopProbe);
      }, 500);
      proc.once('exit', () => clearInterval(stopProbe));
      void dto;
    });
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

  sendCommand(id: string, cmd: string): void {
    const r = this.running.get(id);
    if (!r) throw Object.assign(new Error('Server not running.'), { code: 'conflict' });
    r.proc.stdin?.write(cmd + '\n');
    this.store.pushCommand(id, cmd);
  }

  tail(id: string, lines: number): string[] {
    const r = this.running.get(id);
    return r ? r.ring.slice(-lines) : [];
  }

  stopAll(): Promise<void[]> {
    return Promise.all([...this.running.keys()].map(id => this.stop(id)));
  }
}
