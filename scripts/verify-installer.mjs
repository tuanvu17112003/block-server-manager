// End-to-end NSIS installer verification:
//   npm run pack:win
//   node scripts/verify-installer.mjs
// Silently installs into a throwaway folder, launches the installed app's self tests, then uninstalls.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const releaseDir = path.join(root, 'release');

function findInstaller() {
  if (!fs.existsSync(releaseDir)) return null;
  const candidates = fs.readdirSync(releaseDir)
    .filter((name) => /^Block-Server-Manager-.*-Setup\.exe$/i.test(name))
    .map((name) => path.join(releaseDir, name));
  return candidates[0] ?? null;
}

const installer = findInstaller();
if (!installer) {
  console.error('INSTALLER-VERIFY FAIL: no release/Block-Server-Manager-*-Setup.exe found. Run `npm run pack:win` first.');
  process.exit(1);
}
const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-nsis-install-'));
const appExe = path.join(installDir, 'Block Server Manager.exe');
const uninstaller = path.join(installDir, 'Uninstall Block Server Manager.exe');
const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

function run(command, args, options = {}) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return spawnSync(command, args, { env, encoding: 'utf8', timeout: options.timeoutMs ?? 300_000, windowsHide: true, cwd: options.cwd ?? root });
}
function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{}, 250)'], { windowsHide: true, timeout: 5000 });
  }
  console.error(`timed out waiting for ${label}`);
  return false;
}

try {
  record('installer artifact exists', fs.statSync(installer).size > 5_000_000,
    `${path.basename(installer)} ${(fs.statSync(installer).size / 1024 / 1024).toFixed(1)} MB`);

  // NSIS: /S silent, /D=<dir> last and unquoted (spaces are part of the value).
  const install = run(installer, ['/S', `/D=${installDir}`]);
  const installed = waitFor(() => fs.existsSync(appExe), 120_000, 'installed app executable');
  record('silent NSIS install', install.status === 0 && installed, `exit=${install.status} dir=${installDir}`);

  if (installed) {
    const selftest = run(appExe, ['--selftest'], { cwd: installDir });
    record('installed app --selftest', selftest.status === 0 && /SELFTEST PASS/.test(`${selftest.stdout}${selftest.stderr}`),
      `exit=${selftest.status}`);
    const mgmt = run(appExe, ['--mgmttest'], { cwd: installDir });
    record('installed app --mgmttest', mgmt.status === 0 && /MGMTTEST PASS/.test(`${mgmt.stdout}${mgmt.stderr}`),
      `exit=${mgmt.status}`);
    const asar = path.join(installDir, 'resources', 'app.asar');
    record('installed app.asar present', fs.existsSync(asar), asar);
  }

  if (fs.existsSync(uninstaller)) {
    const uninstall = run(uninstaller, ['/S'], { cwd: installDir });
    const removed = waitFor(() => !fs.existsSync(appExe), 120_000, 'uninstall (app exe removed)');
    record('silent uninstall', uninstall.status === 0 && removed, `exit=${uninstall.status}`);
  } else {
    record('uninstaller present', false, uninstaller);
  }
} finally {
  try { fs.rmSync(installDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }); } catch { /* best effort */ }
}

const ok = checks.every((check) => check.ok);
console.log(`INSTALLER-VERIFY ${ok ? 'PASS' : 'FAIL'} (${checks.filter((check) => check.ok).length}/${checks.length})`);
process.exit(ok ? 0 : 1);
