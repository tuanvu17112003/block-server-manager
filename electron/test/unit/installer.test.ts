// Unit tests for Paper (Fill v3) build selection and the hardened shared ZIP extractor (M-17).
// Pure helpers + local fixtures only: no live Fill calls, no server installs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  download,
  extractZip,
  installLoader,
  paperServerArtifact,
  selectPaperBuild,
  selectPaperBuildById,
  type FillBuild,
  type FillBuildDownload,
} from '../../services/installer/core';
import { collectInputs, writeZip } from '../../services/zip';
import { tempRoot, waitFor } from '../harness';

const HOST = 'https://fill-data.papermc.io';
const sha = (seed: number): string => createHash('sha256').update(`paper-build-${seed}`).digest('hex');

/** Build a Fill-v3-shaped Paper build (live shape: id, time, channel, downloads['server:default']). */
function paperBuild(id: number, channel: string, opts: { artifact?: boolean; overrides?: Partial<FillBuildDownload> } = {}): FillBuild {
  const build: FillBuild = {
    id,
    time: new Date(Date.UTC(2025, 0, 1) + id * 60_000).toISOString(),
    channel,
    downloads: {},
  };
  if (opts.artifact !== false) {
    const base: FillBuildDownload = {
      name: `paper-1.21.4-${id}.jar`,
      url: `${HOST}/v1/objects/${sha(id)}/paper-1.21.4-${id}.jar`,
      size: 50_000_000 + id,
      checksums: { sha256: sha(id) },
    };
    build.downloads = { 'server:default': { ...base, ...opts.overrides } };
  }
  return build;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms (promise never settled)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

const notTimedOut = (err: unknown): boolean => {
  assert.ok(!/timed out after/.test((err as Error).message), (err as Error).message);
  return true;
};

// ---------- Paper Fill v3 build selection ----------

test('selectPaperBuild: latest STABLE build with a complete server:default artifact (id order, payload order ignored)', () => {
  const builds: FillBuild[] = [
    paperBuild(10, 'STABLE'),
    paperBuild(12, 'BETA'),
    paperBuild(13, 'STABLE', { artifact: false }), // newer STABLE but no server:default download
    paperBuild(11, 'STABLE'),
    paperBuild(14, 'ALPHA'),
    paperBuild(15, 'STABLE', { overrides: { checksums: { sha256: 'not-a-valid-hash' } } }), // incomplete hash
  ];
  const artifact = selectPaperBuild(builds);
  assert.equal(artifact.buildId, 11, '13/15 are incomplete, 14/12 are not STABLE, so 11 wins');
  assert.equal(artifact.channel, 'STABLE');
  assert.equal(artifact.url, `${HOST}/v1/objects/${sha(11)}/paper-1.21.4-11.jar`);
  assert.equal(artifact.size, 50_000_011);
  assert.equal(artifact.sha256, sha(11));
  assert.equal(artifact.name, 'paper-1.21.4-11.jar');
});

test('selectPaperBuild: empty, non-STABLE and artifact-less payloads are rejected with a channel summary', () => {
  assert.throws(() => selectPaperBuild([]), /no STABLE Paper build/);
  assert.throws(() => selectPaperBuild([paperBuild(5, 'ALPHA'), paperBuild(6, 'BETA')]), /channels: ALPHA, BETA/);
  assert.throws(() => selectPaperBuild([paperBuild(7, 'STABLE', { artifact: false })]), /no STABLE Paper build/);
  assert.throws(() => selectPaperBuild(null as unknown as FillBuild[]), /not a build array/);
});

test('selectPaperBuildById: explicit pin accepts BETA and rejects unknown/incomplete builds', () => {
  const builds: FillBuild[] = [paperBuild(5, 'STABLE'), paperBuild(7, 'BETA'), paperBuild(6, 'STABLE', { artifact: false })];
  assert.equal(selectPaperBuildById(builds, 7).buildId, 7);
  assert.equal(selectPaperBuildById(builds, 5).channel, 'STABLE');
  assert.throws(() => selectPaperBuildById(builds, 99), /not found/);
  assert.throws(() => selectPaperBuildById(builds, 6), /not artifact-complete/);
});

test('paperServerArtifact: rejects malformed downloads (url/size/sha256) and normalizes the hash', () => {
  const full = paperServerArtifact(paperBuild(7, 'STABLE'));
  assert.ok(full);
  assert.equal(full!.buildId, 7);
  assert.equal(full!.name, 'paper-1.21.4-7.jar');

  assert.equal(paperServerArtifact(null), null);
  assert.equal(paperServerArtifact(undefined), null);
  assert.equal(paperServerArtifact({}), null);
  assert.equal(paperServerArtifact({ id: 1, channel: 'STABLE' }), null);
  assert.equal(paperServerArtifact({ id: 1, channel: 'STABLE', downloads: {} }), null);

  const variant = (overrides: Partial<FillBuildDownload>) => paperServerArtifact({
    id: 2,
    channel: 'STABLE',
    downloads: { 'server:default': { url: `${HOST}/v1/objects/x/x.jar`, size: 10, checksums: { sha256: sha(2) }, ...overrides } },
  });
  const bad: Partial<FillBuildDownload>[] = [
    { url: 'http://fill-data.papermc.io/x.jar' }, // https only
    { url: '/relative/x.jar' },
    { url: 'file:///C:/tmp/x.jar' },
    { url: '' },
    { size: 0 },
    { size: -5 },
    { size: Number.NaN },
    { size: 1.5 },
    { checksums: {} },
    { checksums: { sha256: 'abc' } },
    { checksums: { sha256: 'z'.repeat(64) } },
  ];
  for (const overrides of bad) assert.equal(variant(overrides), null, JSON.stringify(overrides));
  assert.equal(variant({ checksums: { sha256: sha(2).toUpperCase() } })!.sha256, sha(2));
});

// ---------- installLoader('paper'): Fill resolve -> verified server.jar (fake fetch, no network) ----------

/** Serve a fake Fill v3 API/artifact pair through the global fetch used by core.ts. */
function stubFillFetch(opts: { builds?: FillBuild[]; body?: Buffer; status?: number }): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.includes('/v3/projects/paper/versions/')) {
      if (opts.status === 404) return new Response(JSON.stringify({ ok: false, error: 'version_not_found' }), { status: 404 });
      return new Response(JSON.stringify(opts.builds ?? []), { status: 200 });
    }
    if (url.startsWith('https://fill-data.papermc.io/')) return new Response(new Uint8Array(opts.body ?? Buffer.alloc(0)), { status: 200 });
    return new Response('unexpected url', { status: 500 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

function artifactBuild(jar: Buffer, opts: { sha256?: string } = {}): FillBuild {
  const sha256 = opts.sha256 ?? createHash('sha256').update(jar).digest('hex');
  return {
    id: 41,
    time: new Date().toISOString(),
    channel: 'STABLE',
    downloads: {
      'server:default': {
        name: 'paper-1.21.4-41.jar',
        url: `https://fill-data.papermc.io/v1/objects/${sha256}/paper-1.21.4-41.jar`,
        size: jar.length,
        checksums: { sha256 },
      },
    },
  };
}

test('installLoader(paper): picks the latest STABLE build, verifies sha256/size, publishes server.jar', async () => {
  const temp = tempRoot('msm-unit-paper-install');
  const jar = Buffer.from('fake-paper-server-jar-bytes');
  const stub = stubFillFetch({ builds: [paperBuild(40, 'ALPHA'), artifactBuild(jar)], body: jar });
  try {
    const dir = path.join(temp.root, 'server');
    await installLoader('paper', dir, '1.21.4', '1.21.4', 'java', path.join(temp.root, 'cache'));
    assert.equal(stub.calls.length, 2, 'one Fill builds call + one artifact download');
    assert.match(stub.calls[0]!, /^https:\/\/fill\.papermc\.io\/v3\/projects\/paper\/versions\/1\.21\.4\/builds$/);
    assert.equal(fs.readFileSync(path.join(dir, 'server.jar')).toString(), jar.toString());
    assert.equal(fs.existsSync(path.join(dir, 'server.jar.part')), false);
  } finally {
    stub.restore();
    temp.cleanup();
  }
});

test('installLoader(paper): rejects a Fill-declared sha256 mismatch and leaves no server.jar', async () => {
  const temp = tempRoot('msm-unit-paper-hash');
  const jar = Buffer.from('fake-paper-server-jar-bytes');
  const stub = stubFillFetch({ builds: [artifactBuild(jar, { sha256: 'e'.repeat(64) })], body: jar });
  try {
    const dir = path.join(temp.root, 'server');
    await assert.rejects(() => installLoader('paper', dir, '1.21.4', '', 'java', path.join(temp.root, 'cache')), /sha256 mismatch/);
    assert.equal(fs.existsSync(path.join(dir, 'server.jar')), false);
    assert.equal(fs.existsSync(path.join(dir, 'server.jar.part')), false);
  } finally {
    stub.restore();
    temp.cleanup();
  }
});

test('installLoader(paper): unknown Minecraft version (Fill 404) fails with a clear error', async () => {
  const temp = tempRoot('msm-unit-paper-404');
  const stub = stubFillFetch({ status: 404 });
  try {
    await assert.rejects(() => installLoader('paper', path.join(temp.root, 'server'), '9.9.9', '', 'java', temp.root), /Paper has no builds for Minecraft 9\.9\.9/);
  } finally {
    stub.restore();
    temp.cleanup();
  }
});

// ---------- download(): SHA-256 + size verification (offline via data: URL) ----------

test('download: verifies sha256/size, and a hash mismatch leaves no artifact or .part behind', async () => {
  const temp = tempRoot('msm-unit-download');
  try {
    const body = Buffer.from('paper-jar-bytes');
    const url = `data:application/octet-stream;base64,${body.toString('base64')}`;
    const hash = createHash('sha256').update(body).digest('hex');

    const dest = path.join(temp.root, 'server.jar');
    const result = await download(url, dest, { size: body.length, sha256: hash });
    assert.equal(result.sha256, hash);
    assert.equal(result.bytes, body.length);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'paper-jar-bytes');

    const badDest = path.join(temp.root, 'bad.jar');
    await assert.rejects(() => download(url, badDest, { sha256: 'f'.repeat(64) }), /sha256 mismatch/);
    assert.equal(fs.existsSync(badDest), false);
    assert.equal(fs.existsSync(`${badDest}.part`), false);

    const wrongSizeDest = path.join(temp.root, 'size.jar');
    await assert.rejects(() => download(url, wrongSizeDest, { size: body.length + 1 }), /size mismatch/);
    assert.equal(fs.existsSync(wrongSizeDest), false);
  } finally {
    temp.cleanup();
  }
});

// ---------- extractZip(): corrupt/truncated archives must reject, not crash or hang (M-17) ----------

async function makeFixture(temp: ReturnType<typeof tempRoot>): Promise<{ zip: string; payloadStart: number }> {
  const src = path.join(temp.root, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'a.txt'), 'alpha '.repeat(64));
  fs.writeFileSync(path.join(src, 'b.txt'), 'bravo '.repeat(64));
  const inputs = await collectInputs(src, ['a.txt', 'b.txt']);
  assert.equal(inputs.length, 2);
  const zip = path.join(temp.root, 'fixture.zip');
  await writeZip(zip, inputs);
  const bytes = fs.readFileSync(zip);
  assert.equal(bytes.readUInt32LE(0), 0x04034b50, 'fixture starts with a ZIP local file header');
  // First local header: 30 bytes + name + extra, then the raw deflated payload.
  const payloadStart = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
  return { zip, payloadStart };
}

test('extractZip: corrupt deflate data rejects within a timeout, cleans the partial file, and closes the archive', async () => {
  const temp = tempRoot('msm-unit-corrupt-zip');
  try {
    const { zip, payloadStart } = await makeFixture(temp);
    const bytes = fs.readFileSync(zip);
    bytes[payloadStart] = 0x07; // BFINAL=1, BTYPE=11 => invalid deflate block => zlib Z_DATA_ERROR on the entry stream
    fs.writeFileSync(zip, bytes);

    const out = path.join(temp.root, 'out');
    await assert.rejects(
      withTimeout(extractZip(zip, out, { skipExisting: false }), 5000, 'corrupt-zip extraction'),
      /invalid|zlib|inflate|too many bytes|not enough bytes|central directory/i,
    );
    // The partial entry target must be removed (with a short grace period for the Windows close-ordering case).
    await waitFor(() => (fs.existsSync(path.join(out, 'a.txt')) ? null : true), { timeoutMs: 2000, intervalMs: 10, label: 'partial cleanup' });
    assert.equal(fs.existsSync(path.join(out, 'a.txt')), false);
    // The zip file descriptor must be released: a repeat attempt settles (rejects) instead of hanging or throwing hard.
    await assert.rejects(
      withTimeout(extractZip(zip, path.join(temp.root, 'out2'), { skipExisting: false }), 5000, 'second corrupt-zip extraction'),
      notTimedOut,
    );
  } finally {
    temp.cleanup();
  }
});

test('extractZip: truncated archive (no central directory) rejects within a timeout', async () => {
  const temp = tempRoot('msm-unit-truncated-zip');
  try {
    const { zip } = await makeFixture(temp);
    const bytes = fs.readFileSync(zip);
    const truncated = path.join(temp.root, 'truncated.zip');
    fs.writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));
    await assert.rejects(
      withTimeout(extractZip(truncated, path.join(temp.root, 'out'), { skipExisting: false }), 5000, 'truncated-zip extraction'),
      (err: unknown) => notTimedOut(err) && /central directory|not a zip|invalid/i.test((err as Error).message),
    );
  } finally {
    temp.cleanup();
  }
});
