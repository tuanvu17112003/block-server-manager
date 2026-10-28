// Verify a packaged (win-unpacked or installed) Block Server Manager build actually runs.
// Usage:
//   node scripts/verify-package.mjs [path-to-app.exe]
// Defaults to release/win-unpacked/Block Server Manager.exe (run `npm run pack:dir` first).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function findExe() {
  const explicit = process.argv[2];
  if (explicit) return path.resolve(root, explicit);
  const candidates = [
    path.join(root, 'release', 'win-unpacked', 'Block Server Manager.exe'),
    path.join(root, 'release', 'win-unpacked', 'mc-server-manager.exe'),
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return null;
}

const exe = findExe();
if (!exe) {
  console.error('PACKAGE-VERIFY FAIL: packaged app not found. Run `npm run pack:dir` first.');
  process.exit(1);
}
if (!fs.existsSync(path.join(path.dirname(exe), 'resources', 'app.asar'))) {
  console.error(`PACKAGE-VERIFY FAIL: ${path.dirname(exe)} has no resources/app.asar`);
  process.exit(1);
}

function runApp(mode, timeoutMs = 240_000) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(exe, [mode], {
    cwd: path.dirname(exe),
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return { status: result.status, output };
}

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const selftest = runApp('--selftest');
record('packaged --selftest', selftest.status === 0 && /SELFTEST PASS/.test(selftest.output),
  `exit=${selftest.status}`);

const mgmt = runApp('--mgmttest');
record('packaged --mgmttest', mgmt.status === 0 && /MGMTTEST PASS/.test(mgmt.output),
  `exit=${mgmt.status}`);

const bytes = fs.statSync(path.join(path.dirname(exe), 'resources', 'app.asar')).size;
record('app.asar present', bytes > 1_000_000, `${(bytes / 1024 / 1024).toFixed(2)} MB`);

const ok = checks.every((check) => check.ok);
console.log(`PACKAGE-VERIFY ${ok ? 'PASS' : 'FAIL'} (${checks.filter((check) => check.ok).length}/${checks.length})`);
if (!ok) {
  console.log('--- selftest tail ---');
  console.log(selftest.output.slice(-3000));
  console.log('--- mgmttest tail ---');
  console.log(mgmt.output.slice(-3000));
}
process.exit(ok ? 0 : 1);
