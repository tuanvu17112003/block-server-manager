// Loader-build resolution tests: classification, planning, and the escalation policy.
//
// The policy rules tested here are the ones that make "let the console decide" safe rather than a shotgun:
//   - a declared build is never overridden,
//   - mod-level failures never escalate a loader build,
//   - escalation is bounded and only ever loader-level.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBootFailure, explainNoEscalation, nextLoaderBuild, planLoaderBuilds,
} from '../../services/installer/loader-build';

// ---- classification ----

test('classifyBootFailure: identifies loader-level failures from real captured output', () => {
  // Captured from the real FTB Omnia failure (see docs/evidence/adapters/ftb-install-pack-6.json).
  const omniaTail = [
    '[main/INFO] [STDERR/]: [org.spongepowered.asm.launch.MixinTransformationService:initialize:85]: ',
    '[main/INFO] [STDERR/]: at io.github.lxgaming.mixin.launch.MixinTransformationService.initialize',
    '[main/INFO] [STDERR/]: at cpw.mods.modlauncher.TransformationServicesHandler.initialiseTransformationServices',
  ];
  const result = classifyBootFailure(omniaTail);
  assert.equal(result.kind, 'loader');
  assert.match((result as { rule: string }).rule, /^loader\./);

  // The researched itzg bootstrap symptom.
  const boot = classifyBootFailure(['Error: Could not find main class cpw.mods.bootstraplauncher.BootstrapLauncher']);
  assert.equal(boot.kind, 'loader');

  // Java too old for the loader.
  const java = classifyBootFailure(['java.lang.UnsupportedClassVersionError: class file version 61.0']);
  assert.equal(java.kind, 'loader');
});

test('classifyBootFailure: a mod crash vetoes loader escalation even with loader frames present', () => {
  // Real mixin crashes print loader frames too; escalating a build here would hide a broken pack.
  const tail = [
    'cpw.mods.modlauncher.TransformationServicesHandler.initialiseTransformationServices',
    'org.spongepowered.asm.mixin.throwables.MixinApplyError: Mixin apply failed',
    '---- Minecraft Crash Report ----',
  ];
  const result = classifyBootFailure(tail);
  assert.equal(result.kind, 'mod');
  assert.equal((result as { rule: string }).rule, 'mod.mixin-apply');
});

test('classifyBootFailure: missing dependency is a mod problem, not a loader problem', () => {
  const result = classifyBootFailure([
    'Missing or unsupported mandatory dependencies: Mod ID: fancymenu',
  ]);
  assert.equal(result.kind, 'mod');
});

test('classifyBootFailure: legacy Forge missing-library text is loader-level', () => {
  // Captured verbatim by scripts/verify-escalation-fault.mjs from a real Forge 1.12.2 missing-libraries
  // failure — this wording was NOT covered by the first version of the classifier, so escalation was
  // refused on an authentic loader fault. That gap was found by fault injection, not by unit tests.
  const tail = [
    'We appear to be missing one or more essential library files.',
    'You will need to add them to your server before FML and Forge will run successfully.',
    'java.lang.ClassNotFoundException: net.minecraft.launchwrapper.Launch',
    'at java.net.URLClassLoader.findClass(Unknown Source)',
    'at net.minecraftforge.fml.relauncher.ServerLaunchWrapper.main(ServerLaunchWrapper.java:34)',
  ];
  const result = classifyBootFailure(tail);
  assert.equal(result.kind, 'loader');
  assert.equal((result as { rule: string }).rule, 'loader.libraries-missing');
});

test('classifyBootFailure: a missing loader class is loader-level', () => {
  assert.equal(classifyBootFailure(['java.lang.ClassNotFoundException: cpw.mods.bootstraplauncher.BootstrapLauncher']).kind, 'loader');
  assert.equal(classifyBootFailure(['java.lang.ClassNotFoundException: net.minecraftforge.fml.loading.FMLServiceProvider']).kind, 'loader');
  assert.equal(classifyBootFailure(['java.lang.ClassNotFoundException: net.neoforged.fml.loading.FMLServiceProvider']).kind, 'loader');
});

test('classifyBootFailure: empty output is unknown, never loader', () => {
  assert.equal(classifyBootFailure([]).kind, 'unknown');
  assert.equal(classifyBootFailure(['   ']).kind, 'unknown');
  // An unrecognized crash must not trigger a loader change.
  assert.equal(classifyBootFailure(['Exception in thread main: something odd']).kind, 'unknown');
});

// ---- planning ----

test('planLoaderBuilds: a declared build is authoritative and forbids escalation', () => {
  const plan = planLoaderBuilds({
    loader: 'forge', mc: '1.12.2', declaredVersion: '14.23.5.2860',
    promotions: { promos: { '1.12.2-recommended': '14.23.5.2859', '1.12.2-latest': '14.23.5.2864' } },
  });
  assert.deepEqual(plan.candidates, ['14.23.5.2860'], 'the pack build must win over the provider feed');
  assert.equal(plan.declared, true);
  assert.equal(plan.maxEscalations, 0);
});

test('planLoaderBuilds: prefers recommended over latest, then escalates to latest', () => {
  const plan = planLoaderBuilds({
    loader: 'forge', mc: '1.15.2', declaredVersion: null,
    promotions: { promos: { '1.15.2-recommended': '31.2.57', '1.15.2-latest': '31.2.62' } },
  });
  assert.deepEqual(plan.candidates, ['31.2.57', '31.2.62']);
  assert.equal(plan.source, 'provider-recommended');
  assert.equal(plan.declared, false);
  assert.equal(plan.maxEscalations, 1);
});

test('planLoaderBuilds: dedupes when recommended equals latest', () => {
  const plan = planLoaderBuilds({
    loader: 'forge', mc: '1.20.1', declaredVersion: '',
    promotions: { promos: { '1.20.1-recommended': '47.4.28', '1.20.1-latest': '47.4.28' } },
  });
  assert.deepEqual(plan.candidates, ['47.4.28']);
  assert.equal(plan.maxEscalations, 0);
});

test('planLoaderBuilds: no declared build and no provider answer fails closed', () => {
  assert.throws(
    () => planLoaderBuilds({ loader: 'forge', mc: '9.9.9', declaredVersion: null, promotions: { promos: {} } }),
    /publishes no build for Minecraft 9\.9\.9/,
  );
});

test('planLoaderBuilds: non-escalatable loaders get no extra candidates', () => {
  const plan = planLoaderBuilds({
    loader: 'fabric', mc: '1.20.1', declaredVersion: null,
    promotions: { promos: { '1.20.1-recommended': '0.15.0', '1.20.1-latest': '0.16.0' } },
  });
  assert.equal(plan.maxEscalations, 0, 'only forge/neoforge build escalation is modelled');
});

// ---- escalation ----

test('nextLoaderBuild: escalates only on a loader failure, within budget', () => {
  const plan = planLoaderBuilds({
    loader: 'forge', mc: '1.15.2', declaredVersion: null,
    promotions: { promos: { '1.15.2-recommended': '31.2.57', '1.15.2-latest': '31.2.62' } },
  });
  const loaderFailure = { kind: 'loader' as const, rule: 'loader.modlauncher-init' };
  assert.deepEqual(nextLoaderBuild(plan, 0, loaderFailure), { build: '31.2.62', rule: 'loader.modlauncher-init' });
  assert.equal(nextLoaderBuild(plan, 1, loaderFailure), null, 'budget is exhausted after one escalation');
  assert.equal(nextLoaderBuild(plan, 0, { kind: 'mod', rule: 'mod.mixin-apply' }), null, 'a mod crash never escalates');
  assert.equal(nextLoaderBuild(plan, 0, { kind: 'unknown' }), null, 'an unclassified crash never escalates');
});

test('nextLoaderBuild: a declared build never escalates even on a loader failure', () => {
  const plan = planLoaderBuilds({
    loader: 'forge', mc: '1.12.2', declaredVersion: '14.23.5.2860', promotions: null,
  });
  assert.equal(nextLoaderBuild(plan, 0, { kind: 'loader', rule: 'loader.module-path' }), null);
});

test('explainNoEscalation: gives the operator the actual reason', () => {
  const declaredPlan = planLoaderBuilds({ loader: 'forge', mc: '1.12.2', declaredVersion: '14.23.5.2860', promotions: null });
  assert.match(explainNoEscalation(declaredPlan, { kind: 'loader', rule: 'x' }), /declares this exact loader build/);

  const openPlan = planLoaderBuilds({
    loader: 'forge', mc: '1.15.2', declaredVersion: null,
    promotions: { promos: { '1.15.2-recommended': '31.2.57', '1.15.2-latest': '31.2.62' } },
  });
  assert.match(explainNoEscalation(openPlan, { kind: 'mod', rule: 'mod.mixin-apply' }), /a mod failed/);
  assert.match(explainNoEscalation(openPlan, { kind: 'unknown' }), /does not identify the loader/);
  assert.match(explainNoEscalation(openPlan, { kind: 'loader', rule: 'x' }), /no further loader builds/);
});
