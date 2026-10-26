#!/usr/bin/env node
// Unified verification gate. Mirrors the plan's gate runner:
// - clears ELECTRON_RUN_AS_NODE (required in this environment),
// - runs every layer serially (Electron gates must never overlap),
// - writes per-step logs (+ optional UI screenshots) under artifacts/<timestamp>/.
//
//   node scripts/verify.mjs               fast gate: build, unit, selftest, contract, services, mgmt, ipc, ui
//   node scripts/verify.mjs --full        adds the live engine E2E matrix (network + Java)
//   node scripts/verify.mjs --only=ui     runs only steps whose name contains "ui"
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const args = process.argv.slice(2);
const full = args.includes('--full');
const onlyArg = args.find((arg) => arg.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length) : null;
const electronCli = path.join(root, 'node_modules', 'electron', 'cli.js');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifacts = path.join(root, 'artifacts', stamp);
fs.mkdirSync(artifacts, { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;

const results = [];

function runStep(name, command, commandArgs) {
  if (only && !name.includes(only)) return;
  process.stdout.write(`\n=== ${name} ===\n`);
  const started = Date.now();
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32' && (command === 'npm' || /\.cmd$/i.test(command)),
    maxBuffer: 128 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  fs.writeFileSync(path.join(artifacts, `${name}.log`), output);
  const tail = output.trim().split('\n').slice(-20).join('\n');
  if (tail) process.stdout.write(`${tail}\n`);
  const passed = result.status === 0;
  const ms = Date.now() - started;
  results.push({ name, ok: passed, ms });
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'} ${name} (${ms}ms)\n`);
}

const node = process.execPath;
const electron = (flag, extra = []) => [electronCli, '.', flag, ...extra];

runStep('build', 'npm', ['run', 'build']);
runStep('runtime-data', node, [path.join('scripts', 'check-runtime-data.mjs')]);
runStep('unit', node, [path.join('scripts', 'unit.mjs')]);
runStep('selftest', node, electron('--selftest'));
runStep('contract', node, electron('--contracttest'));
runStep('services', node, electron('--servicestest'));
runStep('mgmttest', node, electron('--mgmttest'));
runStep('ipctest', node, electron('--ipctest'));
runStep('uitest', node, electron('--uitest', [`--artifacts=${artifacts}`]));
if (full) runStep('e2e', node, electron('--e2e'));

const failed = results.filter((entry) => !entry.ok);
const summary = [
  '',
  '================ VERIFY SUMMARY ================',
  ...results.map((entry) => `${entry.ok ? 'PASS' : 'FAIL'} ${entry.name.padEnd(10)} ${entry.ms}ms`),
  `artifacts: ${artifacts}`,
  `VERIFY ${failed.length === 0 ? 'PASS' : 'FAIL'} (${results.length - failed.length}/${results.length} steps)`,
].join('\n');
process.stdout.write(`${summary}\n`);
fs.writeFileSync(path.join(artifacts, 'summary.txt'), `${summary}\n`);
process.exit(failed.length === 0 ? 0 : 1);
