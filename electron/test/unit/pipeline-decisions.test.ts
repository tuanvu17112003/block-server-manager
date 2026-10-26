// Pipeline policy unit tests (WP-4.2/4.5/4.6/4.8 pipeline side).
// Pure decision mapping, Quilt/new-install loader policy, local .mrpack checks and the archive
// snapshot/drift guard. No network, no Electron, no install engines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot } from '../harness';
import {
  MAX_LOCAL_MRPACK_BYTES,
  QUILT_REJECTION_MESSAGE,
  artifactDriftReason,
  assertLocalMrpackSource,
  assertSupportedNewInstallLoader,
  mapFilePolicy,
  snapshotArtifact,
  type PipelineArtifactSnapshot,
  type PipelineFileDecision,
} from '../../services/pipeline';

const declared = (env: string, why = 'declared'): { env: string; why: string } => ({ env, why });

function decide(input: Partial<Parameters<typeof mapFilePolicy>[0]>): PipelineFileDecision {
  return mapFilePolicy({ path: 'mods/example.jar', serverEnv: null, clientEnv: null, curated: declared('required'), ...input }).decision;
}

function expectValidation(fn: () => unknown, messagePart?: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'validation');
    if (messagePart) assert.ok(String((error as Error).message).includes(messagePart), String((error as Error).message));
    return true;
  });
}

// ---- WP-4.6: optional defaults / required / unsupported / missing ----

test('optional server files are included by default with optionalDefaultKeep (never userChoice)', () => {
  const decision = decide({ serverEnv: 'optional', curated: declared('optional') });
  assert.deepEqual(decision, { path: 'mods/example.jar', side: 'server', action: 'include', reason: 'optionalDefaultKeep' });

  const both = decide({ serverEnv: 'optional', clientEnv: 'required', curated: declared('optional') });
  assert.equal(both.action, 'include');
  assert.equal(both.reason, 'optionalDefaultKeep');
  assert.equal(both.side, 'both');

  const unsupportedClient = decide({ serverEnv: 'optional', clientEnv: 'unsupported', curated: declared('optional') });
  assert.equal(unsupportedClient.side, 'server');
});

test('explicit include/exclude turns an optional file into userChoice', () => {
  const excluded = decide({ serverEnv: 'optional', curated: declared('optional'), choice: 'exclude' });
  assert.equal(excluded.action, 'exclude');
  assert.equal(excluded.reason, 'userChoice');
  const included = decide({ serverEnv: 'optional', curated: declared('optional'), choice: 'include' });
  assert.equal(included.action, 'include');
  assert.equal(included.reason, 'userChoice');
});

test('required files are included and reject overriding choices', () => {
  assert.deepEqual(decide({ serverEnv: 'required', curated: declared('required') }), {
    path: 'mods/example.jar', side: 'server', action: 'include', reason: 'required',
  });
  expectValidation(() => mapFilePolicy({ path: 'mods/required.jar', serverEnv: 'required', curated: declared('required'), choice: 'exclude' }), 'required file');
});

test('server-unsupported files stay excluded and reject user choices', () => {
  assert.deepEqual(decide({ serverEnv: 'unsupported', curated: declared('unsupported') }), {
    path: 'mods/example.jar', side: 'server', action: 'exclude', reason: 'serverUnsupported',
  });
  const clientOnly = decide({ serverEnv: 'unsupported', clientEnv: 'required', curated: declared('unsupported') });
  assert.equal(clientOnly.side, 'client');
  expectValidation(() => mapFilePolicy({ path: 'mods/client.jar', serverEnv: 'unsupported', curated: declared('unsupported'), choice: 'include' }), 'server-unsupported');
});

test('missing server environment metadata is retained with a warning reason', () => {
  const decision = decide({ serverEnv: null, curated: declared('required') });
  assert.deepEqual(decision, {
    path: 'mods/example.jar', side: null, action: 'include', reason: 'missingEnvironmentRetained',
  });
});

// ---- WP-4.6: conflictingSignals for contradictory env/L4 metadata ----

test('env required + curated L4 unsupported is a conflict requiring a visible choice', () => {
  const curated = { env: 'unsupported', why: 'community exclude: sodium' };
  const mapped = mapFilePolicy({ path: 'mods/sodium.jar', serverEnv: 'required', clientEnv: null, curated });
  assert.equal(mapped.decision.action, 'awaitingUserChoice');
  assert.equal(mapped.decision.reason, 'conflictingSignals');
  assert.equal(mapped.decision.side, null);
  assert.deepEqual(mapped.warnings, ['mods/sodium.jar: community exclude: sodium']);

  const resolvedInclude = mapFilePolicy({ path: 'mods/sodium.jar', serverEnv: 'required', clientEnv: null, curated, choice: 'include' });
  assert.equal(resolvedInclude.decision.action, 'include');
  assert.equal(resolvedInclude.decision.reason, 'userChoice');
  const resolvedExclude = mapFilePolicy({ path: 'mods/sodium.jar', serverEnv: 'required', clientEnv: null, curated, choice: 'exclude' });
  assert.equal(resolvedExclude.decision.action, 'exclude');
  assert.equal(resolvedExclude.decision.reason, 'userChoice');
});

test('env optional/unsupported contradicted by curated L4 required is a conflict', () => {
  const optionalVsUnsupported = mapFilePolicy({
    path: 'mods/x.jar', serverEnv: 'optional', curated: { env: 'unsupported', why: 'hand-override: x' },
  });
  assert.equal(optionalVsUnsupported.decision.reason, 'conflictingSignals');

  const unsupportedVsRequired = mapFilePolicy({
    path: 'mods/y.jar', serverEnv: 'unsupported', curated: { env: 'required', why: 'community force-include: y' },
  });
  assert.equal(unsupportedVsRequired.decision.action, 'awaitingUserChoice');
  assert.equal(unsupportedVsRequired.decision.reason, 'conflictingSignals');
});

test('curated L4 can upgrade a missing/optional env without inventing a conflict', () => {
  const missingToRequired = mapFilePolicy({
    path: 'mods/z.jar', serverEnv: null, curated: { env: 'required', why: 'community force-include: z' },
  });
  assert.equal(missingToRequired.decision.action, 'include');
  assert.equal(missingToRequired.decision.reason, 'required');

  const optionalToRequired = mapFilePolicy({
    path: 'mods/w.jar', serverEnv: 'optional', curated: { env: 'required', why: 'hand-override: w' },
  });
  assert.equal(optionalToRequired.decision.action, 'include');
  assert.equal(optionalToRequired.decision.reason, 'required');
});

// ---- WP-4.8: Quilt / new-install loader policy ----

test('Quilt is rejected for new installs with the ADR-0005 message', () => {
  expectValidation(() => assertSupportedNewInstallLoader('quilt'), 'ADR-0005');
  expectValidation(() => assertSupportedNewInstallLoader('Quilt'), 'ADR-0005');
  assert.ok(QUILT_REJECTION_MESSAGE.includes('ADR-0005'));
  assert.equal(assertSupportedNewInstallLoader('fabric'), 'fabric');
  assert.equal(assertSupportedNewInstallLoader('NeoForge'), 'neoforge');
  expectValidation(() => assertSupportedNewInstallLoader('paper'), 'not supported for new server installs');
  expectValidation(() => assertSupportedNewInstallLoader(''), 'does not declare');
});

// ---- WP-4.8: local .mrpack source checks ----

test('local .mrpack checks: missing, folder, extension, empty and valid file', () => {
  const temp = tempRoot('msm-unit-mrpack');
  try {
    const valid = path.join(temp.root, 'pack.mrpack');
    fs.writeFileSync(valid, 'not-a-real-zip-but-a-regular-file');
    assert.equal(assertLocalMrpackSource(valid).isFile(), true);

    assert.throws(() => assertLocalMrpackSource(path.join(temp.root, 'missing.mrpack')), (error: unknown) => {
      return (error as { code?: string }).code === 'not-found';
    });
    expectValidation(() => assertLocalMrpackSource(temp.root), 'not a folder or link');
    const wrongExt = path.join(temp.root, 'pack.zip');
    fs.writeFileSync(wrongExt, 'x');
    expectValidation(() => assertLocalMrpackSource(wrongExt), '.mrpack extension');
    const empty = path.join(temp.root, 'empty.mrpack');
    fs.writeFileSync(empty, '');
    expectValidation(() => assertLocalMrpackSource(empty), '2 GiB import limit');
    assert.equal(MAX_LOCAL_MRPACK_BYTES, 2 * 1024 ** 3);
  } finally {
    temp.cleanup();
  }
});

// ---- WP-4.5: archive snapshot / drift guard ----

test('artifact snapshot pins size/mtime/SHA-256 and detects content drift', async () => {
  const temp = tempRoot('msm-unit-drift');
  try {
    const archive = path.join(temp.root, 'pack.mrpack');
    fs.writeFileSync(archive, 'reviewed-pack-bytes');
    const snapshot: PipelineArtifactSnapshot = await snapshotArtifact(archive, 'localMrpack');
    assert.equal(snapshot.kind, 'localMrpack');
    assert.equal(snapshot.sizeBytes, fs.statSync(archive).size);
    assert.equal(typeof snapshot.mtimeMs, 'number');
    assert.match(snapshot.sha256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(await artifactDriftReason(archive, snapshot), null);

    // Same length, restored mtime: only the SHA-256 can catch this rewrite.
    fs.writeFileSync(archive, 'reviewed-pack-bytez');
    const current = fs.statSync(archive);
    fs.utimesSync(archive, new Date(current.atimeMs), new Date(snapshot.mtimeMs));
    const contentDrift = await artifactDriftReason(archive, snapshot);
    assert.ok(contentDrift?.includes('SHA-256'), String(contentDrift));

    // Different size reports the size change first.
    fs.writeFileSync(archive, 'much-longer-content-than-before');
    assert.ok((await artifactDriftReason(archive, snapshot))?.includes('changed size'));

    // Missing archive is an actionable rejection, not a crash.
    fs.rmSync(archive);
    assert.ok((await artifactDriftReason(archive, snapshot))?.includes('no longer available'));
  } finally {
    temp.cleanup();
  }
});

test('large archives skip SHA-256 and still compare size/mtime', async () => {
  const temp = tempRoot('msm-unit-drift-large');
  try {
    const archive = path.join(temp.root, 'big.mrpack');
    fs.writeFileSync(archive, 'some-bytes');
    const snapshot = await snapshotArtifact(archive, 'curseforgeZip', 1);
    assert.equal(snapshot.sha256, null);
    assert.equal(await artifactDriftReason(archive, snapshot), null);
    fs.writeFileSync(archive, 'some-bytes-plus');
    assert.ok((await artifactDriftReason(archive, snapshot))?.includes('changed size'));
  } finally {
    temp.cleanup();
  }
});
