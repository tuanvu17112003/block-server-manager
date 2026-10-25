// Server lifecycle — java child supervision + `server://log|status` events + ring buffer.
// One running process per server id; statuses mirror the Rust lifecycle names.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { launchCommand, ensureServerProperties, writeEula, freePort } from './installer/core';
import type { Store, ServerDto } from './store';

type Status = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';

interface Running {
  proc: ChildProcess;
  ring: string[];
  status: Status;
  stopTimer?: NodeJS.Timeout;
}

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
    this.setStatus(id, 'starting');
    const proc = spawn(cmd.exe, cmd.args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    const r: Running = { proc, ring: [], status: 'starting' };
    this.running.set(id, r);
    const onLine = (line: string) => {
      r.ring.push(line);
      if (r.ring.length > 5000) r.ring.shift();
      this.send(`server://log/${id}`, line);
      if (/Done \(\d/.test(line)) this.setStatus(id, 'running');
    };
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (l.trim()) onLine(l); }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.once('exit', code => {
      const wasStopping = r.status === 'stopping';
      this.running.delete(id);
      this.setStatus(id, wasStopping || code === 0 ? 'stopped' : 'crashed');
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
