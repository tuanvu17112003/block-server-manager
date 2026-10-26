// Unit tests for WP-3.2 Java provisioning parity (electron/services/java.ts).
// Pure Node: no Electron, no network, no real JDK. Effects are injected; captured real-world
// `-XshowSettings:properties -version` output shapes are used for the parsers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DISK_HEADROOM_BYTES,
  JAVA_INSTALL_LOCK_STALE_MS,
  MojangNetworkError,
  MojangRequestError,
  SUPPORTED_MAJORS,
  acquireJavaInstallLock,
  adoptiumPackageFrom,
  detectJava,
  diskPreflight,
  ensureJava,
  inspectJava,
  installMajorFor,
  isSupportedMajor,
  lockPathFor,
  offlineJavaMajor,
  parseJavaSettings,
  pickCandidates,
  requiredJavaMajor,
  resolveJavaExecutable,
  validateJava,
  type JavaCandidate,
  type JavaRunResult,
} from '../../services/java';
import { tempRoot } from '../harness';

function codeOf(error: unknown): string {
  return (error as { code?: string }).code ?? '';
}

// ------------------------------------------------------------------------------------------------
// Real-world `-XshowSettings:properties -version` captures (shape from JDK 8/17/21/25 on Windows)
// ------------------------------------------------------------------------------------------------

const JAVA_8_STDOUT = `
Property settings:
    file.encoding = Cp1252
    java.home = C:\\Program Files\\Java\\jre1.8.0_402
    java.specification.name = Java Platform API Specification
    java.specification.version = 1.8
    java.version = 1.8.0_402
    java.vm.name = Java HotSpot(TM) 64-Bit Server VM
    os.arch = amd64
    sun.arch.data.model = 64
`;
const JAVA_8_STDERR = `java version "1.8.0_402"\nJava(TM) SE Runtime Environment (build 1.8.0_402-b06)\nJava HotSpot(TM) 64-Bit Server VM (build 25.402-b06, mixed mode)\n`;

const JAVA_17_STDOUT = `
Property settings:
    java.home = C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.11.9-hotspot
    java.specification.version = 17
    java.version = 17.0.11
    os.arch = amd64
    sun.arch.data.model = 64
`;
const JAVA_17_STDERR = `openjdk version "17.0.11" 2024-04-16\nOpenJDK Runtime Environment Temurin-17.0.11+9 (build 17.0.11+9)\nOpenJDK 64-Bit Server VM Temurin-17.0.11+9 (build 17.0.11+9, mixed mode, sharing)\n`;

const JAVA_21_STDOUT = `
Property settings:
    java.home = C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.12.1-hotspot
    java.specification.version = 21
    java.version = 21.0.12.1
    os.arch = amd64
    sun.arch.data.model = 64
`;
const JAVA_21_STDERR = `openjdk version "21.0.12.1" 2026-07-21 LTS\nOpenJDK Runtime Environment Temurin-21.0.12.1+1 (build 21.0.12.1+1-LTS)\n`;

const JAVA_25_STDOUT = `
Property settings:
    java.home = C:\\Program Files\\Eclipse Adoptium\\jdk-25.0.2.10-hotspot
    java.specification.version = 25
    java.version = 25.0.2.10
    os.arch = aarch64
`;
const JAVA_25_STDERR = `openjdk version "25.0.2.10" 2026-01-20 LTS\nOpenJDK Runtime Environment Temurin-25.0.2.10+1 (build 25.0.2.10+1-LTS)\n`;

const JAVA_32BIT_STDOUT = `
Property settings:
    java.specification.version = 8
    java.version = 1.8.0_402
    os.arch = x86
    sun.arch.data.model = 32
`;

function runResult(overrides: Partial<JavaRunResult>): JavaRunResult {
  return { stdout: '', stderr: '', status: 0, ...overrides };
}

/** Create a fake JDK home (or exe) so path resolution succeeds without a real Java. */
function fakeJdk(root: string, name = 'jdk-test'): string {
  const home = path.join(root, name);
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, 'bin', 'java.exe'), 'stub');
  return home;
}

// ------------------------------------------------------------------------------------------------
// parseJavaSettings
// ------------------------------------------------------------------------------------------------

test('parseJavaSettings: Java 8 (1.8) and 17/21/25 captures parse major + 64-bit', () => {
  assert.deepEqual(parseJavaSettings(`${JAVA_8_STDOUT}\n${JAVA_8_STDERR}`), { major: 8, architectureBits: 64 });
  assert.deepEqual(parseJavaSettings(`${JAVA_17_STDOUT}\n${JAVA_17_STDERR}`), { major: 17, architectureBits: 64 });
  assert.deepEqual(parseJavaSettings(`${JAVA_21_STDOUT}\n${JAVA_21_STDERR}`), { major: 21, architectureBits: 64 });
  assert.deepEqual(parseJavaSettings(`${JAVA_25_STDOUT}\n${JAVA_25_STDERR}`), { major: 25, architectureBits: 64 });
});

test('parseJavaSettings: 32-bit runtime is reported as 32 bits', () => {
  assert.deepEqual(parseJavaSettings(JAVA_32BIT_STDOUT), { major: 8, architectureBits: 32 });
});

test('parseJavaSettings: falls back to the version banner and os.arch', () => {
  assert.deepEqual(parseJavaSettings('java version "1.8.0_301"\n    os.arch = amd64\n'), { major: 8, architectureBits: 64 });
  assert.deepEqual(parseJavaSettings('openjdk version "17.0.9" 2023-10-17\n    os.arch = x86_64\n'), { major: 17, architectureBits: 64 });
});

test('parseJavaSettings: rejects missing major or missing architecture', () => {
  assert.throws(() => parseJavaSettings('nothing useful here'), (error: unknown) => codeOf(error) === 'validation');
  assert.throws(() => parseJavaSettings('    java.specification.version = 21\n'), (error: unknown) => codeOf(error) === 'validation');
  assert.throws(() => parseJavaSettings('    sun.arch.data.model = 64\n'), (error: unknown) => codeOf(error) === 'validation');
});

// ------------------------------------------------------------------------------------------------
// Minecraft Java requirement (offline fallback + Mojang metadata)
// ------------------------------------------------------------------------------------------------

test('offlineJavaMajor: documented fallback matrix, unknown families fail closed', () => {
  const expected: Record<string, number | null> = {
    '1.12.2': 8, '1.16.5': 8, '1.17': 16, '1.17.1': 16, '1.18.2': 17, '1.19.2': 17,
    '1.20': 17, '1.20.1': 17, '1.20.4': 17, '1.20.5': 21, '1.20.6': 21, '1.21': 21,
    '1.21.1': 21, '1.21.11': 21, '26.1': 25, '26.1.2': 25,
    '26.2': null, '1.22': null, '1.21.1.2': null, '1': null, '': null, 'not-a-version': null, '1.x': null,
  };
  for (const [version, major] of Object.entries(expected)) {
    assert.equal(offlineJavaMajor(version), major, `offlineJavaMajor(${JSON.stringify(version)})`);
  }
});

test('installMajorFor: nearest provisionable major (1.17 → 17, unsupported → null)', () => {
  assert.equal(installMajorFor(8), 8);
  assert.equal(installMajorFor(11), 17);
  assert.equal(installMajorFor(16), 17);
  assert.equal(installMajorFor(17), 17);
  assert.equal(installMajorFor(21), 21);
  assert.equal(installMajorFor(22), 25);
  assert.equal(installMajorFor(25), 25);
  assert.equal(installMajorFor(26), null);
  assert.deepEqual([...SUPPORTED_MAJORS], [8, 17, 21, 25]);
  assert.equal(isSupportedMajor(21), true);
  assert.equal(isSupportedMajor(16), false);
});

function mojangFetcher(options: {
  manifest?: unknown;
  versionJson?: unknown;
  failManifest?: Error;
  failVersion?: Error;
  versionId?: string;
  versionUrl?: string;
}): { fetchJson: (url: string) => Promise<unknown>; urls: string[] } {
  const versionId = options.versionId ?? '1.21.1';
  const versionUrl = options.versionUrl ?? 'https://meta.example/version.json';
  const urls: string[] = [];
  return {
    urls,
    fetchJson: async (url) => {
      urls.push(url);
      if (url.includes('version_manifest')) {
        if (options.failManifest) throw options.failManifest;
        return options.manifest ?? { versions: [{ id: versionId, url: versionUrl }] };
      }
      if (options.failVersion) throw options.failVersion;
      return options.versionJson ?? { javaVersion: { majorVersion: 21 } };
    },
  };
}

test('requiredJavaMajor: Mojang metadata is authoritative (21, 25, 16)', async () => {
  const twentyOne = mojangFetcher({ versionJson: { javaVersion: { majorVersion: 21 } } });
  assert.equal(await requiredJavaMajor('1.21.1', twentyOne), 21);
  const twentyFive = mojangFetcher({ versionId: '26.2', versionJson: { javaVersion: { majorVersion: 25 } } });
  assert.equal(await requiredJavaMajor('26.2', twentyFive), 25);
  const sixteen = mojangFetcher({ versionId: '1.17.1', versionJson: { javaVersion: { majorVersion: 16 } } });
  assert.equal(await requiredJavaMajor('1.17.1', sixteen), 16);
});

test('requiredJavaMajor: offline fallback only for network failures + known families', async () => {
  const offline = mojangFetcher({ failManifest: new MojangNetworkError('offline') });
  assert.equal(await requiredJavaMajor('1.20.1', offline), 17);
  assert.equal(await requiredJavaMajor('1.21.1', offline), 21);
  assert.equal(await requiredJavaMajor('26.1', offline), 25);

  const offlineUnknown = mojangFetcher({ failManifest: new MojangNetworkError('offline') });
  await assert.rejects(
    () => requiredJavaMajor('26.2', offlineUnknown),
    (error: unknown) => codeOf(error) === 'io' && /network|offline/i.test((error as Error).message),
  );

  const offlineVersionJson = mojangFetcher({ versionId: '1.12.2', failVersion: new MojangNetworkError('reset') });
  assert.equal(await requiredJavaMajor('1.12.2', offlineVersionJson), 8);
});

test('requiredJavaMajor: request/metadata failures never fall back', async () => {
  const requestError = mojangFetcher({ failManifest: new MojangRequestError('HTTP 403') });
  await assert.rejects(() => requiredJavaMajor('1.20.1', requestError), (error: unknown) => codeOf(error) === 'io');

  const unknownVersion = mojangFetcher({
    manifest: { versions: [{ id: '1.20.4', url: 'https://meta.example/other.json' }] },
  });
  await assert.rejects(
    () => requiredJavaMajor('1.20.1', unknownVersion),
    (error: unknown) => codeOf(error) === 'validation' && /not found/.test((error as Error).message),
  );

  const malformedManifest = mojangFetcher({ manifest: { versions: 'nope' } });
  await assert.rejects(() => requiredJavaMajor('1.20.1', malformedManifest), (error: unknown) => codeOf(error) === 'io');
});

test('requiredJavaMajor: malformed/unsupported metadata fails closed', async () => {
  const malformedObject = mojangFetcher({ versionJson: { javaVersion: 17 } });
  await assert.rejects(() => requiredJavaMajor('1.21.1', malformedObject), (error: unknown) => codeOf(error) === 'validation');

  const malformedMajor = mojangFetcher({ versionJson: { javaVersion: { majorVersion: 'twentyone' } } });
  await assert.rejects(() => requiredJavaMajor('1.21.1', malformedMajor), (error: unknown) => codeOf(error) === 'validation');

  const zeroMajor = mojangFetcher({ versionJson: { javaVersion: { majorVersion: 0 } } });
  await assert.rejects(() => requiredJavaMajor('1.21.1', zeroMajor), (error: unknown) => codeOf(error) === 'validation');

  const unsupported = mojangFetcher({ versionId: '26.3', versionJson: { javaVersion: { majorVersion: 30 } } });
  await assert.rejects(
    () => requiredJavaMajor('26.3', unsupported),
    (error: unknown) => codeOf(error) === 'validation' && /supported runtime set/.test((error as Error).message),
  );

  const missingFieldWithFallback = mojangFetcher({ versionId: '1.20.4', versionJson: { id: 'x' } });
  assert.equal(await requiredJavaMajor('1.20.4', missingFieldWithFallback), 17);

  const missingFieldUnknownFamily = mojangFetcher({ versionId: '30.0', versionJson: { id: 'x' } });
  await assert.rejects(
    () => requiredJavaMajor('30.0', missingFieldUnknownFamily),
    (error: unknown) => codeOf(error) === 'validation' && /no known fallback/.test((error as Error).message),
  );

  await assert.rejects(() => requiredJavaMajor('   ', mojangFetcher({})), (error: unknown) => codeOf(error) === 'validation');
});

// ------------------------------------------------------------------------------------------------
// pickCandidates / discovery / validation
// ------------------------------------------------------------------------------------------------

function candidate(overrides: Partial<JavaCandidate>): JavaCandidate {
  return { path: 'C:\\Java\\jdk\\bin\\java.exe', major: 21, architectureBits: 64, source: 'PATH', ...overrides };
}

test('pickCandidates: filters 32-bit/unsupported/too-old, dedupes and sorts by major', () => {
  const entries: JavaCandidate[] = [
    candidate({ path: 'C:\\a\\java.exe', major: 21 }),
    candidate({ path: 'C:\\b\\java.exe', major: 17 }),
    candidate({ path: 'C:\\c\\java.exe', major: 21, architectureBits: 32 }),
    candidate({ path: 'C:\\d\\java.exe', major: 11 }),
    candidate({ path: 'C:\\e\\java.exe', major: 25 }),
    candidate({ path: 'C:\\A\\JAVA.EXE', major: 21 }), // duplicate, different case
  ];
  const compatible = pickCandidates(entries, 21);
  assert.deepEqual(compatible.map((entry) => entry.major), [21, 25]);
  assert.deepEqual(compatible.map((entry) => entry.path), ['C:\\a\\java.exe', 'C:\\e\\java.exe']);

  const forSeventeen = pickCandidates(entries, 17);
  assert.deepEqual(forSeventeen.map((entry) => entry.major), [17, 21, 25]);

  const exact = pickCandidates(entries, 21, { exactMajor: true });
  assert.deepEqual(exact.map((entry) => entry.major), [21]);
  assert.equal(exact.length, 1, 'dedupe by normalized path');
});

test('resolveJavaExecutable: JDK home, explicit java.exe, missing and wrong file', () => {
  const temp = tempRoot('msm-java-resolve');
  try {
    const home = fakeJdk(temp.root);
    assert.equal(resolveJavaExecutable(home), path.join(home, 'bin', 'java.exe'));
    assert.equal(resolveJavaExecutable(path.join(home, 'bin', 'java.exe')), path.join(home, 'bin', 'java.exe'));
    assert.throws(() => resolveJavaExecutable(''), (error: unknown) => codeOf(error) === 'validation');
    assert.throws(
      () => resolveJavaExecutable(path.join(temp.root, 'missing-jdk')),
      (error: unknown) => codeOf(error) === 'validation' && /not found/.test((error as Error).message),
    );
    const wrong = path.join(temp.root, 'notepad.exe');
    fs.writeFileSync(wrong, 'stub');
    assert.throws(
      () => resolveJavaExecutable(wrong),
      (error: unknown) => codeOf(error) === 'validation' && /JDK home directory or a java\.exe/.test((error as Error).message),
    );
  } finally {
    temp.cleanup();
  }
});

test('inspectJava: parses injected captures and maps failures to validation', () => {
  const temp = tempRoot('msm-java-inspect');
  try {
    const home = fakeJdk(temp.root);
    const ok = inspectJava(home, 'PATH', { run: () => runResult({ stdout: JAVA_21_STDOUT, stderr: JAVA_21_STDERR }) });
    assert.equal(ok.major, 21);
    assert.equal(ok.architectureBits, 64);
    assert.equal(ok.source, 'PATH');
    assert.equal(ok.path, path.join(home, 'bin', 'java.exe'));

    assert.throws(
      () => inspectJava(home, 'PATH', { run: () => runResult({ timedOut: true, status: null }) }),
      (error: unknown) => codeOf(error) === 'validation' && /did not respond within 5 seconds/.test((error as Error).message),
    );
    assert.throws(
      () => inspectJava(home, 'PATH', { run: () => runResult({ status: null, error: 'ENOENT' }) }),
      (error: unknown) => codeOf(error) === 'validation' && /Could not execute Java/.test((error as Error).message),
    );
    assert.throws(
      () => inspectJava(home, 'PATH', { run: () => runResult({ status: 1 }) }),
      (error: unknown) => codeOf(error) === 'validation' && /could not be run successfully/.test((error as Error).message),
    );
    assert.throws(
      () => inspectJava(home, 'PATH', { run: () => runResult({ stdout: 'garbage' }) }),
      (error: unknown) => codeOf(error) === 'validation',
    );
  } finally {
    temp.cleanup();
  }
});

test('validateJava: Rust compatibility rules (64-bit, supported, not too old)', async () => {
  const temp = tempRoot('msm-java-validate');
  try {
    const home = fakeJdk(temp.root);
    const runFor = (stdout: string, stderr: string) => ({ run: () => runResult({ stdout, stderr }) });

    const exact = await validateJava(home, 21, runFor(JAVA_21_STDOUT, JAVA_21_STDERR));
    assert.equal(exact.major, 21);
    assert.equal(exact.source, 'manual override');

    const newer = await validateJava(home, 21, runFor(JAVA_25_STDOUT, JAVA_25_STDERR));
    assert.equal(newer.major, 25, 'newer supported runtime satisfies an older requirement');

    const forSeventeenMinimum = await validateJava(home, 16, runFor(JAVA_17_STDOUT, JAVA_17_STDERR));
    assert.equal(forSeventeenMinimum.major, 17, '1.17 minimum Java 16 is satisfied by Java 17');

    await assert.rejects(
      () => validateJava(home, 21, runFor(JAVA_17_STDOUT, JAVA_17_STDERR)),
      (error: unknown) => codeOf(error) === 'validation' && /too old/.test((error as Error).message),
    );
    await assert.rejects(
      () => validateJava(home, 8, runFor(JAVA_32BIT_STDOUT, '')),
      (error: unknown) => codeOf(error) === 'validation' && /64-bit/.test((error as Error).message),
    );
    const java11 = '    java.specification.version = 11\n    sun.arch.data.model = 64\n';
    await assert.rejects(
      () => validateJava(home, 8, runFor(java11, '')),
      (error: unknown) => codeOf(error) === 'validation' && /supported runtime set/.test((error as Error).message),
    );
  } finally {
    temp.cleanup();
  }
});

test('detectJava: merges sources, inspects, dedupes and filters by required major', async () => {
  const temp = tempRoot('msm-java-detect');
  try {
    const home17 = fakeJdk(temp.root, 'jdk-17');
    const home21 = fakeJdk(temp.root, 'jdk-21');
    const home25 = fakeJdk(temp.root, 'jdk-25');
    const exe = (home: string): string => path.join(home, 'bin', 'java.exe');
    const outputs = new Map<string, JavaRunResult>([
      [exe(home17), runResult({ stdout: JAVA_17_STDOUT, stderr: JAVA_17_STDERR })],
      [exe(home21), runResult({ stdout: JAVA_21_STDOUT, stderr: JAVA_21_STDERR })],
      [exe(home25), runResult({ stdout: JAVA_25_STDOUT, stderr: JAVA_25_STDERR })],
    ]);
    const options = {
      platform: 'win32' as const,
      env: {} as NodeJS.ProcessEnv,
      findOnPath: () => [exe(home17)],
      queryRegistry: () => [home21, exe(home17)], // duplicate of PATH
      listDir: (dir: string) => {
        try {
          return fs.readdirSync(dir);
        } catch {
          return [];
        }
      },
      run: (executable: string): JavaRunResult => outputs.get(executable) ?? runResult({ status: 1 }),
    };
    assert.deepEqual((await detectJava(17, [temp.root], options)).map((entry) => entry.major), [17, 21, 25]);
    assert.deepEqual((await detectJava(21, [temp.root], options)).map((entry) => entry.major), [21, 25]);
    const exact = await detectJava(21, [temp.root], { ...options, exactMajor: true });
    assert.deepEqual(exact.map((entry) => entry.major), [21]);
    assert.equal(exact.length, 1, 'duplicate discovery entries are deduped');

    await assert.rejects(
      () => detectJava(0, [], options),
      (error: unknown) => codeOf(error) === 'validation',
    );
  } finally {
    temp.cleanup();
  }
});

// ------------------------------------------------------------------------------------------------
// Adoptium payload / disk / locks
// ------------------------------------------------------------------------------------------------

function adoptiumPayload(overrides: { checksum?: string; size?: number; link?: string; name?: string } = {}) {
  const sha = overrides.checksum ?? 'f9d6e191ab098c0d416e7d588a24420a8621cd2f4720dab2459b8b7b2d2d8b4e';
  return [
    {
      binary: {
        architecture: 'x64',
        image_type: 'jdk',
        os: 'windows',
        installer: { size: 1, link: 'https://example.invalid/installer.msi' },
        package: {
          name: overrides.name ?? 'OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip',
          link: overrides.link ?? 'https://github.com/adoptium/temurin21-binaries/releases/download/x.zip',
          size: overrides.size ?? 205_073_461,
          checksum: sha,
        },
      },
      version: { major: 21 },
    },
  ];
}

test('adoptiumPackageFrom: flattens the live v3 shape and validates the ZIP metadata', () => {
  const pack = adoptiumPackageFrom(adoptiumPayload());
  assert.equal(pack.size, 205_073_461);
  assert.equal(pack.sha256, 'f9d6e191ab098c0d416e7d588a24420a8621cd2f4720dab2459b8b7b2d2d8b4e');
  assert.equal(pack.name.endsWith('.zip'), true);
  assert.equal(pack.link.startsWith('https://'), true);

  const invalid: unknown[] = [
    {},
    'nope',
    [],
    [{ binary: {} }],
    adoptiumPayload({ link: 'http://insecure.example/x.zip' }),
    adoptiumPayload({ name: 'jdk.tar.gz' }),
    adoptiumPayload({ size: 0 }),
    adoptiumPayload({ size: 1.5 as unknown as number }),
    adoptiumPayload({ checksum: 'abc' }),
  ];
  for (const payload of invalid) {
    assert.throws(() => adoptiumPackageFrom(payload), (error: unknown) => codeOf(error) === 'io');
  }
});

test('diskPreflight: 2× extracted tree (+ archive when needed) + 512 MiB headroom', () => {
  const gib = 1024 ** 3;
  assert.equal(DISK_HEADROOM_BYTES, 512 * 1024 * 1024);

  const withArchive = diskPreflight({ availableBytes: 10 * gib, packageSizeBytes: 2 * gib });
  assert.equal(withArchive.requiredBytes, 2 * gib * 3 + DISK_HEADROOM_BYTES);
  assert.equal(withArchive.ok, true);
  assert.equal(withArchive.deficitBytes, 0);

  const cached = diskPreflight({ availableBytes: 10 * gib, packageSizeBytes: 2 * gib, archiveAlreadyDownloaded: true });
  assert.equal(cached.requiredBytes, 2 * gib * 2 + DISK_HEADROOM_BYTES);

  const tight = diskPreflight({ availableBytes: 5 * gib, packageSizeBytes: 2 * gib });
  assert.equal(tight.ok, false);
  assert.equal(tight.deficitBytes, tight.requiredBytes - 5 * gib);

  const noHeadroom = diskPreflight({ availableBytes: 10 * gib, packageSizeBytes: 1 * gib, headroomBytes: 0 });
  assert.equal(noHeadroom.requiredBytes, 3 * gib);
  const clamped = diskPreflight({ availableBytes: -5, packageSizeBytes: 0, headroomBytes: 0 });
  assert.equal(clamped.availableBytes, 0);
  assert.equal(clamped.requiredBytes, 0);
  assert.equal(clamped.ok, true);
});

test('lockPathFor + acquireJavaInstallLock: exclusive, live-wait timeout, stale takeover', async () => {
  const temp = tempRoot('msm-java-lock');
  const runtimeRoot = path.join(temp.root, 'runtime');
  try {
    assert.equal(lockPathFor(runtimeRoot, 17), path.join(runtimeRoot, '.java-install-17.lock'));
    fs.mkdirSync(runtimeRoot, { recursive: true });

    const first = await acquireJavaInstallLock(runtimeRoot, 17, { waitMs: 0 });
    assert.equal(fs.existsSync(first.path), true);
    await assert.rejects(
      () => acquireJavaInstallLock(runtimeRoot, 17, { waitMs: 0 }),
      (error: unknown) => codeOf(error) === 'io' && /still running/.test((error as Error).message),
    );
    first.release();
    assert.equal(fs.existsSync(first.path), false);

    // Simulate a crashed installer: lock mtime older than the 10-minute stale window.
    fs.writeFileSync(lockPathFor(runtimeRoot, 17), JSON.stringify({ pid: 999, at: 'stale' }));
    const stale = new Date(Date.now() - JAVA_INSTALL_LOCK_STALE_MS - 60_000);
    fs.utimesSync(lockPathFor(runtimeRoot, 17), stale, stale);
    const takeover = await acquireJavaInstallLock(runtimeRoot, 17, { waitMs: 0 });
    assert.equal(fs.existsSync(takeover.path), true);
    takeover.release();
    assert.equal(fs.existsSync(takeover.path), false);
  } finally {
    temp.cleanup();
  }
});

// ------------------------------------------------------------------------------------------------
// ensureJava
// ------------------------------------------------------------------------------------------------

test('ensureJava: unsupported majors are rejected before any effect', async () => {
  const temp = tempRoot('msm-java-unsupported');
  try {
    for (const major of [11, 16, 22, 30]) {
      await assert.rejects(
        () => ensureJava(major, path.join(temp.root, 'runtime'), path.join(temp.root, 'cache')),
        (error: unknown) => codeOf(error) === 'validation' && /supported runtime set/.test((error as Error).message),
      );
    }
  } finally {
    temp.cleanup();
  }
});

test('ensureJava: reuses an already installed app-managed runtime without network', async () => {
  const temp = tempRoot('msm-java-reuse');
  try {
    const runtimeRoot = path.join(temp.root, 'runtime');
    const cacheDir = path.join(temp.root, 'cache');
    const home = fakeJdk(runtimeRoot, 'temurin-21');
    let fetchCalls = 0;
    const result = await ensureJava(21, runtimeRoot, cacheDir, undefined, {
      fetchJson: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
      detectOptions: {
        platform: 'win32',
        env: {},
        findOnPath: () => [],
        queryRegistry: () => [],
        listDir: (dir) => { try { return fs.readdirSync(dir); } catch { return []; } },
        run: (executable) => executable === path.join(home, 'bin', 'java.exe')
          ? runResult({ stdout: JAVA_21_STDOUT, stderr: JAVA_21_STDERR })
          : runResult({ status: 1 }),
      },
    });
    assert.equal(fetchCalls, 0, 'reuse must not hit Adoptium');
    assert.equal(result.major, 21);
    assert.equal(result.source, 'Temurin (app managed)');
    assert.equal(result.path, path.join(home, 'bin', 'java.exe'));
  } finally {
    temp.cleanup();
  }
});

test('ensureJava: verified package install publishes and cleans staging/lock/archive', async () => {
  const temp = tempRoot('msm-java-install');
  try {
    const runtimeRoot = path.join(temp.root, 'runtime');
    const cacheDir = path.join(temp.root, 'cache');
    const archiveBytes = Buffer.from('fake temurin zip payload');
    const sha256 = createHash('sha256').update(archiveBytes).digest('hex');
    const payload = adoptiumPayload({ checksum: sha256, size: archiveBytes.length });
    const progress: string[] = [];
    const listDir = (dir: string): string[] => {
      try { return fs.readdirSync(dir); } catch { return []; }
    };
    const result = await ensureJava(21, runtimeRoot, cacheDir, (update) => progress.push(update.phase), {
      fetchJson: async () => payload,
      download: async (url, dest) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, archiveBytes);
        return { bytes: archiveBytes.length, sha1: '', sha256, sha512: '' };
      },
      extractZip: async (_archive, destDir) => {
        const home = path.join(destDir, 'jdk-21.0.12.1+1');
        fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(home, 'bin', 'java.exe'), 'stub');
        return { written: ['jdk-21.0.12.1+1/bin/java.exe'], skippedExisting: [], excluded: [] };
      },
      freeDiskBytes: () => 100 * 1024 ** 3,
      listDir,
      inspect: (target) => ({
        path: path.join(target, 'bin', 'java.exe'),
        major: 21,
        architectureBits: 64,
        source: 'Temurin (app managed)',
      }),
      detectOptions: {
        platform: 'win32',
        env: {},
        findOnPath: () => [],
        queryRegistry: () => [],
        listDir,
        run: () => runResult({ status: 1 }),
      },
    });
    assert.equal(result.major, 21);
    assert.equal(result.architectureBits, 64);
    assert.equal(result.path, path.join(runtimeRoot, 'temurin-21', 'bin', 'java.exe'));
    assert.equal(fs.existsSync(result.path), true);
    assert.equal(fs.existsSync(path.join(cacheDir, 'temurin-21.zip')), false, 'archive removed after publish');
    assert.equal(fs.existsSync(lockPathFor(runtimeRoot, 21)), false, 'install lock released');
    assert.equal(progress.some((phase) => /Downloading/.test(phase)), true);
    assert.equal(progress.some((phase) => /ready/.test(phase)), true);
    const leftovers = fs.readdirSync(runtimeRoot).filter((name) => name.includes('staging'));
    assert.deepEqual(leftovers, []);
  } finally {
    temp.cleanup();
  }
});

test('ensureJava: failed extraction rejects as io, cleans staging and releases the lock', async () => {
  const temp = tempRoot('msm-java-install-fail');
  try {
    const runtimeRoot = path.join(temp.root, 'runtime');
    const cacheDir = path.join(temp.root, 'cache');
    const archiveBytes = Buffer.from('x');
    const sha256 = createHash('sha256').update(archiveBytes).digest('hex');
    const payload = adoptiumPayload({ checksum: sha256, size: archiveBytes.length });
    await assert.rejects(
      () => ensureJava(21, runtimeRoot, cacheDir, undefined, {
        fetchJson: async () => payload,
        download: async (_url, dest) => {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, archiveBytes);
          return { bytes: 1, sha1: '', sha256, sha512: '' };
        },
        extractZip: async () => { throw new Error('bad zip'); },
        freeDiskBytes: () => 100 * 1024 ** 3,
        listDir: () => [],
        inspect: () => ({ path: 'x', major: 21, architectureBits: 64, source: 'Temurin (app managed)' }),
        detectOptions: {
          platform: 'win32',
          env: {},
          findOnPath: () => [],
          queryRegistry: () => [],
          listDir: () => [],
          run: () => runResult({ status: 1 }),
        },
      }),
      (error: unknown) => codeOf(error) === 'io' && /extraction failed/.test((error as Error).message),
    );
    assert.equal(fs.existsSync(lockPathFor(runtimeRoot, 21)), false, 'lock released after failure');
    assert.equal(fs.existsSync(path.join(runtimeRoot, 'temurin-21')), false);
    const leftovers = fs.readdirSync(runtimeRoot).filter((name) => name.includes('staging'));
    assert.deepEqual(leftovers, []);
  } finally {
    temp.cleanup();
  }
});
