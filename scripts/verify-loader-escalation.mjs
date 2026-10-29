// Live proof of the loader-build escalation policy: does it actually rescue a pack that declares no build,
// and does it correctly refuse when the failure is not the loader's fault?
//
// This harness installs real Forge for a real MC line but deliberately withholds the build, exactly as a
// pack with silent metadata would, then drives the SAME boot-check path the pipeline uses.
//
// Usage: node scripts/verify-loader-escalation.mjs [mc] [loader]
// Requires `npm run build:electron`.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const dist = path.join(process.cwd(), 'dist-electron');
const core = require(path.join(dist, 'services/installer/core.js'));
const {
  classifyBootFailure, planLoaderBuilds, nextLoaderBuild, explainNoEscalation,
} = require(path.join(dist, 'services/installer/loader-build.js'));

const mc = process.argv[2] ?? '1.12.2';
const loader = process.argv[3] ?? 'forge';
const evidenceFile = process.argv[4]
  ?? path.join(process.cwd(), 'docs', 'evidence', 'adapters', `loader-escalation-${loader}-${mc}.json`);

const JAVA8 = ['C:\\Program Files\\Java\\jre1.8.0_503\\bin\\java.exe', 'C:\\Program Files\\Java\\jdk-8\\bin\\java.exe']
  .find(candidate => fs.existsSync(candidate));
const JAVA17 = 'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe';
const javaExe = Number(mc.split('.')[1] ?? 20) <= 16 ? (JAVA8 ?? JAVA17) : JAVA17;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-loader-'));
const started = Date.now();
const log = (line) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`);

const evidence = {
  harness: 'verify-loader-escalation.mjs',
  startedAt: new Date().toISOString(),
  mc,
  loader,
  javaExe,
  plan: null,
  attempts: [],
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
  // 1) Build the plan exactly as the pipeline does when the pack declares nothing.
  const promotionsResponse = await fetch('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
  const promotions = await promotionsResponse.json();
  const plan = planLoaderBuilds({ loader, mc, declaredVersion: null, promotions });
  evidence.plan = plan;
  log(`plan (no declared build): ${plan.candidates.join(' -> ')} source=${plan.source} maxEscalations=${plan.maxEscalations}`);
  if (plan.candidates.length === 0) throw new Error('no candidates resolved');

  // 2) Install the primary candidate and try a real boot, then escalate per policy.
  let currentBuild = plan.candidates[0];
  let attempt = 0;
  let ok = false;
  let lastFail = null;

  for (;;) {
    const dir = path.join(root, `try-${attempt}`);
    fs.mkdirSync(dir, { recursive: true });
    log(`attempt ${attempt}: installing forge ${currentBuild} for MC ${mc}`);
    const step = { attempt, build: currentBuild, installOk: false, bootOk: false, reason: null, classification: null };
    try {
      await core.installLoader(loader, dir, mc, currentBuild, javaExe, path.join(root, 'cache'));
      step.installOk = true;
      fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
      const launch = core.launchCommand(dir, javaExe);
      log(`attempt ${attempt}: booting (${launch.args.slice(0, 3).join(' ')})`);
      const result = await core.startAndVerify(dir, { exe: javaExe, args: launch.args }, { timeoutMs: 6 * 60_000 });
      step.bootOk = result.ok;
      step.reason = result.ok ? null : result.reason;
      const failure = classifyBootFailure(result.tail ?? []);
      step.classification = failure;
      evidence.attempts.push(step);
      log(`attempt ${attempt}: boot ${result.ok ? 'OK' : 'FAILED'} | ${result.ok ? '' : result.reason} | class=${failure.kind}${failure.rule ? ` (${failure.rule})` : ''}`);

      if (result.ok) { ok = true; break; }
      lastFail = failure;
    } catch (error) {
      step.reason = error instanceof Error ? error.message : String(error);
      evidence.attempts.push(step);
      log(`attempt ${attempt}: error ${step.reason}`);
      lastFail = { kind: 'unknown' };
    }

    const next = lastFail ? nextLoaderBuild(plan, attempt, lastFail) : null;
    if (!next) {
      const why = lastFail ? explainNoEscalation(plan, lastFail) : 'no failure recorded';
      log(`no escalation: ${why}`);
      evidence.noEscalationReason = why;
      break;
    }
    currentBuild = next.build;
    attempt += 1;
  }

  evidence.verdict = ok ? 'PASS' : 'REFUSED';
  evidence.finalBuild = currentBuild;
  log(ok
    ? `PASS: plain-forge install boots on build ${currentBuild} (escalations used: ${attempt})`
    : `REFUSED (correct if the failure is not loader-level): ${evidence.noEscalationReason ?? 'budget exhausted'}`);
} catch (error) {
  evidence.verdict = 'ERROR';
  evidence.error = error instanceof Error ? error.message : String(error);
  console.error(`ERROR: ${evidence.error}`);
  process.exitCode = 1;
} finally {
  if (evidence.verdict === 'PASS') {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  writeEvidence();
}
