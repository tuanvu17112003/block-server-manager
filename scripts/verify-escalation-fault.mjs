// Fault-injection proof that the loader-build ESCALATION BRANCH actually works end-to-end.
//
// What this does and does not prove:
//  - It does NOT pretend a real modpack is broken. No real pack needs escalation after the FTB version fix.
//  - It DOES prove the wiring: classify -> nextLoaderBuild -> reinstall the loader -> RE-RESOLVE the launch
//    shape -> retry boot -> succeed. Those are exactly the steps a unit test cannot cover, and the launch
//    re-resolve was a real bug found by review rather than by test.
//
// Method: install a real Forge server, then inject an authentic loader-level fault (delete the loader's
// library tree) so the boot fails the way a broken loader actually fails. No synthetic stack traces.
//
// Usage: node scripts/verify-escalation-fault.mjs [mc]
// Requires `npm run build:electron`.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const dist = path.join(process.cwd(), 'dist-electron');
const core = require(path.join(dist, 'services/installer/core.js'));
const tx = require(path.join(dist, 'services/install-transaction.js'));
const {
  classifyBootFailure, planLoaderBuilds, nextLoaderBuild, explainNoEscalation,
} = require(path.join(dist, 'services/installer/loader-build.js'));

const mc = process.argv[2] ?? '1.12.2';
const evidenceFile = process.argv[3]
  ?? path.join(process.cwd(), 'docs', 'evidence', 'adapters', `escalation-fault-${mc}.json`);

const JAVA_CANDIDATES = [
  'C:\\Program Files\\Java\\jre1.8.0_503\\bin\\java.exe',
  'C:\\Program Files\\Java\\jdk-8\\bin\\java.exe',
];
const JAVA8 = JAVA_CANDIDATES.find(candidate => fs.existsSync(candidate));
const JAVA17 = 'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe';
const javaExe = Number(mc.split('.')[1] ?? 20) <= 16 ? (JAVA8 ?? JAVA17) : JAVA17;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-escalate-fault-'));
const cacheDir = path.join(root, 'cache');
const started = Date.now();
const log = (line) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`);

const evidence = {
  harness: 'verify-escalation-fault.mjs',
  startedAt: new Date().toISOString(),
  mc,
  javaExe,
  purpose: 'fault-injection: prove the escalation wiring (classify -> reinstall -> re-resolve launch -> retry)',
  notProvenHere: 'that a REAL pack needs escalation; no surveyed FTB pack does after the version fix',
  plan: null,
  injectedFault: null,
  attempt0: null,
  escalation: null,
  attempt1: null,
  launchReresolveProof: null,
  verdict: null,
  error: null,
};
function writeEvidence() {
  evidence.finishedAt = new Date().toISOString();
  evidence.durationSeconds = Math.round((Date.now() - started) / 100) / 10;
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`evidence written: ${evidenceFile}`);
}

try {
  // ---- plan exactly as the pipeline builds it for a pack that declares no build ----
  const promotions = await (await fetch('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).json();
  const plan = planLoaderBuilds({ loader: 'forge', mc, declaredVersion: null, promotions });
  evidence.plan = plan;
  log(`plan: ${plan.candidates.join(' -> ')} source=${plan.source} maxEscalations=${plan.maxEscalations}`);
  if (plan.candidates.length < 2) throw new Error('need >=2 candidates to exercise escalation');

  const dir = path.join(root, 'server');
  fs.mkdirSync(dir, { recursive: true });

  // ---- attempt 0: install the primary candidate, then inject a loader-level fault ----
  const primary = plan.candidates[0];
  log(`attempt 0: installing forge ${primary}`);
  await core.installLoader('forge', dir, mc, primary, javaExe, cacheDir);
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
  let launch = tx.validateStagedInstall({ stagingDir: dir, loaderKind: 'forge', log: () => {} });
  evidence.attempt0 = { build: primary, launchArgs: launch.args };
  log(`attempt 0: launch shape resolved: ${launch.args.slice(0, 2).join(' ')}`);

  // Authentic loader fault: the loader cannot start without its own library tree.
  const libraries = path.join(dir, 'libraries');
  if (fs.existsSync(libraries)) {
    fs.rmSync(libraries, { recursive: true, force: true });
    evidence.injectedFault = 'deleted libraries/ (loader library tree) — an authentic loader-level failure';
    log('injected fault: removed libraries/');
  } else {
    throw new Error('expected a Forge libraries/ tree to corrupt');
  }

  const boot0 = await core.startAndVerify(dir, { exe: javaExe, args: launch.args }, { timeoutMs: 4 * 60_000 });
  const failure = classifyBootFailure(boot0.tail ?? []);
  evidence.attempt0 = {
    ...evidence.attempt0,
    bootOk: boot0.ok,
    reason: boot0.reason,
    classification: failure,
    tailSample: (boot0.tail ?? []).slice(-12),
  };
  log(`attempt 0: boot ${boot0.ok ? 'OK (fault not effective!)' : 'FAILED'} | class=${failure.kind}${failure.rule ? ` (${failure.rule})` : ''}`);
  if (boot0.ok) throw new Error('injected fault did not cause a boot failure; escalation cannot be exercised');

  // ---- escalation decision, exactly as the pipeline's bootCheck does it ----
  const next = nextLoaderBuild(plan, 0, failure);
  if (!next) {
    evidence.escalation = { refused: true, reason: explainNoEscalation(plan, failure) };
    throw new Error(`escalation refused: ${evidence.escalation.reason}`);
  }
  evidence.escalation = { from: primary, to: next.build, rule: next.rule };
  log(`escalation: ${primary} -> ${next.build} (triggered by ${next.rule})`);

  // ---- attempt 1: reinstall, RE-RESOLVE the launch shape, retry ----
  await core.installLoader('forge', dir, mc, next.build, javaExe, cacheDir);
  const launchBefore = launch.args;
  launch = tx.validateStagedInstall({ stagingDir: dir, loaderKind: 'forge', log: () => {} });
  evidence.launchReresolveProof = {
    before: launchBefore,
    after: launch.args,
    changed: JSON.stringify(launchBefore) !== JSON.stringify(launch.args),
    why: 'the loader artifact name contains its build, so the pre-escalation launch shape pointed at a deleted file',
  };
  log(`attempt 1: launch shape re-resolved -> ${launch.args.slice(0, 2).join(' ')} (changed=${evidence.launchReresolveProof.changed})`);

  const boot1 = await core.startAndVerify(dir, { exe: javaExe, args: launch.args }, { timeoutMs: 6 * 60_000 });
  evidence.attempt1 = {
    build: next.build,
    bootOk: boot1.ok,
    reason: boot1.reason,
    tailSample: (boot1.tail ?? []).slice(-12),
  };
  log(`attempt 1: boot ${boot1.ok ? 'OK' : 'FAILED'} ${boot1.ok ? '' : `| ${boot1.reason}`}`);

  evidence.verdict = boot1.ok ? 'PASS' : 'FAIL';
  if (!boot1.ok) process.exitCode = 1;
  log(boot1.ok
    ? 'PASS: the escalation branch fires, reinstalls, re-resolves the launch shape and reaches a bootable server'
    : 'FAIL: escalation did not recover a bootable server');
} catch (error) {
  if (!evidence.verdict) evidence.verdict = 'ERROR';
  evidence.error = error instanceof Error ? error.message : String(error);
  console.error(`${evidence.verdict}: ${evidence.error}`);
  process.exitCode = 1;
} finally {
  if (evidence.verdict === 'PASS') {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  writeEvidence();
}
