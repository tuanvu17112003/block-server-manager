// Phase 8 WP-8.1 live proof: start a real server inside the app, quit the app, prove the JVM died.
// Usage: node scripts/quitsmoke.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const electronCli = path.join(root, 'node_modules', 'electron', 'cli.js');

function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root, env, ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: String(error) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function markerPids(serverId) {
  const script = `$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process -Filter "Name='java.exe'" | Where-Object { $_.CommandLine -like '*testmultiai.server.id=${serverId}*' } | ForEach-Object { $_.ProcessId }`;
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

const started = Date.now();
const app = await run(process.execPath, [electronCli, '.', '--quitsmoke'], { timeout: 6 * 60_000 });
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
const serverId = /QUITSMOKE-SERVER\s+(\S+)/.exec(app.stdout)?.[1] ?? null;
const ready = /QUITSMOKE-READY serverId=(\S*)/.exec(app.stdout)?.[1] ?? null;
console.log(`app exit=${app.code} ready=${serverId ?? '?'} serverId=${serverId ?? '?'} elapsed=${elapsed}s`);
if (app.code !== 0) console.log(app.stderr.slice(-4000));

let survivors = '';
let survivorCount = -1;
if (serverId) {
  // Give Windows a moment to release handles after the parent process exited.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const query = await markerPids(serverId);
  survivors = query.stdout.trim();
  survivorCount = survivors === '' ? 0 : survivors.split(/\r?\n/).filter(Boolean).length;
}
const pass = app.code === 0 && serverId !== null && survivorCount === 0;
console.log(`QUITSMOKE ${pass ? 'PASS' : 'FAIL'} jvm-survivors=${survivorCount}${survivors ? ` (${survivors.replace(/\s+/g, ',')})` : ''}`);
if (!pass) {
  console.log('--- app stdout tail ---');
  console.log(app.stdout.slice(-4000));
}
process.exit(pass ? 0 : 1);
