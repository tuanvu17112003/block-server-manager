// WP-4.4 integrity/failover/allowlist tests: fetchTrusted redirect policy, ordered download
// failover with per-candidate verification, and cached-file re-verification. All network is stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  MODRINTH_ALLOWED_HOSTS,
  downloadFirstAvailable,
  fetchTrusted,
  hashFile,
  isHostAllowed,
  verifyCachedFile,
} from '../../services/installer/core';
import { tempRoot } from '../harness';

const sha1 = (data: Buffer): string => createHash('sha1').update(data).digest('hex');
const sha512 = (data: Buffer): string => createHash('sha512').update(data).digest('hex');

interface StubCall { url: string; init?: RequestInit }
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const bytes = (data: Buffer, status = 200): Response => new Response(new Uint8Array(data), { status });
const redirect = (location: string, status = 302): Response =>
  new Response(null, { status, headers: { location } });

/** Replace global fetch with a URL -> Response router; every call is recorded. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): { calls: StubCall[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: StubCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('isHostAllowed: exact hosts only, a leading dot allows subdomains, suffix tricks are rejected', () => {
  assert.equal(isHostAllowed('api.modrinth.com', MODRINTH_ALLOWED_HOSTS), true);
  assert.equal(isHostAllowed('API.MODRINTH.COM', MODRINTH_ALLOWED_HOSTS), true);
  assert.equal(isHostAllowed('notmodrinth.com', MODRINTH_ALLOWED_HOSTS), false);
  assert.equal(isHostAllowed('evil.modrinth.com', MODRINTH_ALLOWED_HOSTS), false);
  assert.equal(isHostAllowed('cdn.modrinth.com.evil.test', MODRINTH_ALLOWED_HOSTS), false);
  assert.equal(isHostAllowed('cdn.example.test', ['.example.test']), true);
  assert.equal(isHostAllowed('example.test', ['.example.test']), true);
  assert.equal(isHostAllowed('badexample.test', ['.example.test']), false);
  assert.equal(isHostAllowed('', MODRINTH_ALLOWED_HOSTS), false);
});

test('fetchTrusted: HTTPS + per-hop allowlist, manual redirects, cross-host escape rejected', async () => {
  // Plain allowed URL.
  let stub = stubFetch(() => json({ ok: true }));
  try {
    const response = await fetchTrusted('https://api.modrinth.com/v2/search', MODRINTH_ALLOWED_HOSTS);
    assert.equal(response.status, 200);
    assert.equal(stub.calls[0]?.url, 'https://api.modrinth.com/v2/search');
    assert.equal(stub.calls[0]?.init?.redirect, 'manual', 'redirects must be followed manually');
  } finally { stub.restore(); }

  // Non-HTTPS and disallowed hosts fail closed before any fetch.
  stub = stubFetch(() => json({}));
  try {
    await assert.rejects(() => fetchTrusted('http://api.modrinth.com/v2/x', MODRINTH_ALLOWED_HOSTS), (error: unknown) => {
      const e = error as { code?: string; message?: string };
      assert.equal(e.code, 'validation');
      assert.match(String(e.message), /non-HTTPS/);
      return true;
    });
    await assert.rejects(() => fetchTrusted('https://evil.example/x', MODRINTH_ALLOWED_HOSTS), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'validation');
      assert.match((error as Error).message, /host not allowed: evil\.example/);
      return true;
    });
    assert.equal(stub.calls.length, 0, 'rejected URLs must not be fetched');
  } finally { stub.restore(); }

  // Allowed redirect -> allowed redirect -> 200; relative Location is resolved against the hop.
  stub = stubFetch((url) => {
    if (url === 'https://api.modrinth.com/v2/project/x') return redirect('https://cdn.modrinth.com/data/x');
    if (url === 'https://cdn.modrinth.com/data/x') return redirect('/data/final');
    return json({ final: true });
  });
  try {
    const response = await fetchTrusted('https://api.modrinth.com/v2/project/x', MODRINTH_ALLOWED_HOSTS);
    assert.equal(response.status, 200);
    assert.deepEqual(stub.calls.map((call) => call.url), [
      'https://api.modrinth.com/v2/project/x',
      'https://cdn.modrinth.com/data/x',
      'https://cdn.modrinth.com/data/final',
    ]);
  } finally { stub.restore(); }

  // Redirect to a host outside the allowlist is rejected (never fetched).
  stub = stubFetch((url) => (url.includes('api.modrinth.com') ? redirect('https://evil.example/payload') : json({})));
  try {
    await assert.rejects(() => fetchTrusted('https://api.modrinth.com/v2/x', MODRINTH_ALLOWED_HOSTS), /host not allowed: evil\.example/);
  } finally { stub.restore(); }

  // Redirect to HTTP is rejected even when the host would be allowed.
  stub = stubFetch((url) => (url.includes('api.modrinth.com') ? redirect('http://cdn.modrinth.com/x') : json({})));
  try {
    await assert.rejects(() => fetchTrusted('https://api.modrinth.com/v2/x', MODRINTH_ALLOWED_HOSTS), /non-HTTPS/);
  } finally { stub.restore(); }

  // Redirect loops beyond the hop cap fail closed.
  stub = stubFetch(() => redirect('https://api.modrinth.com/v2/loop'));
  try {
    await assert.rejects(() => fetchTrusted('https://api.modrinth.com/v2/loop', MODRINTH_ALLOWED_HOSTS, { maxRedirects: 3 }), /too many redirects/);
  } finally { stub.restore(); }
});

test('fetchTrusted: 5xx responses are retried, abort rejects with a cancelled error', async () => {
  let attempts = 0;
  let stub = stubFetch(() => { attempts += 1; return attempts === 1 ? json({}, 503) : json({ ok: true }); });
  try {
    const response = await fetchTrusted('https://api.modrinth.com/v2/retry', MODRINTH_ALLOWED_HOSTS);
    assert.equal(response.status, 200);
    assert.equal(attempts, 2);
  } finally { stub.restore(); }

  stub = stubFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  }));
  try {
    const controller = new AbortController();
    const started = Date.now();
    const pending = fetchTrusted('https://api.modrinth.com/v2/hang', MODRINTH_ALLOWED_HOSTS, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'cancelled');
      return true;
    });
    assert.ok(Date.now() - started < 2000, 'abort must reject promptly');
  } finally { stub.restore(); }
});

test('downloadFirstAvailable: ordered failover, per-candidate hash verification, bounded attempts', async () => {
  const body = Buffer.from('verified-mod-jar-bytes');
  const temp = tempRoot('msm-unit-failover');
  try {
    // First candidate 500 (retried), second candidate good -> succeeds from the second URL.
    let stub = stubFetch((url) => (url.includes('/broken/') ? json({}, 500) : bytes(body)));
    try {
      const dest = path.join(temp.root, 'mod.jar');
      const result = await downloadFirstAvailable([
        { url: 'https://cdn.modrinth.com/broken/mod.jar' },
        { url: 'https://cdn.modrinth.com/good/mod.jar', size: body.length, sha1: sha1(body), sha512: sha512(body) },
      ], { dest, allowedHosts: MODRINTH_ALLOWED_HOSTS, attemptsPerCandidate: 1 });
      assert.equal(result.url, 'https://cdn.modrinth.com/good/mod.jar');
      assert.equal(result.cached, false);
      assert.equal(result.bytes, body.length);
      assert.equal(fs.readFileSync(dest).toString(), body.toString());
    } finally { stub.restore(); }

    // A hash-mismatched candidate is rejected and the next candidate is used.
    stub = stubFetch((url) => (url.includes('/wrong/') ? bytes(Buffer.from('poisoned')) : bytes(body)));
    try {
      const dest = path.join(temp.root, 'hash.jar');
      const result = await downloadFirstAvailable([
        { url: 'https://cdn.modrinth.com/wrong/hash.jar', sha512: sha512(body) },
        { url: 'https://cdn.modrinth.com/good/hash.jar', sha512: sha512(body) },
      ], { dest, allowedHosts: MODRINTH_ALLOWED_HOSTS, attemptsPerCandidate: 1 });
      assert.equal(result.url, 'https://cdn.modrinth.com/good/hash.jar');
      assert.equal(fs.readFileSync(dest).toString(), body.toString());
    } finally { stub.restore(); }

    // All candidates failing surfaces an aggregated error (never silent success).
    stub = stubFetch(() => json({}, 500));
    try {
      const dest = path.join(temp.root, 'fail.jar');
      await assert.rejects(
        () => downloadFirstAvailable(['https://cdn.modrinth.com/a', 'https://cdn.modrinth.com/b'], { dest, allowedHosts: MODRINTH_ALLOWED_HOSTS, attemptsPerCandidate: 1 }),
        (error: unknown) => {
          assert.match((error as Error).message, /all download sources failed/);
          assert.equal(fs.existsSync(dest), false);
          assert.equal(fs.existsSync(`${dest}.part`), false);
          return true;
        },
      );
    } finally { stub.restore(); }
  } finally {
    temp.cleanup();
  }
});

test('downloadFirstAvailable: corrupt cache is re-downloaded; a verified cache is reused without network', async () => {
  const body = Buffer.from('cached-file-payload');
  const expected = { size: body.length, sha1: sha1(body), sha512: sha512(body) };
  const temp = tempRoot('msm-unit-cache');
  try {
    const dest = path.join(temp.root, 'cache.bin');
    fs.writeFileSync(dest, 'corrupt!');
    assert.equal(await verifyCachedFile(dest, expected), false);

    let stub = stubFetch(() => bytes(body));
    try {
      const result = await downloadFirstAvailable([{ url: 'https://cdn.modrinth.com/cache.bin', ...expected }], {
        dest, allowedHosts: MODRINTH_ALLOWED_HOSTS, attemptsPerCandidate: 1,
      });
      assert.equal(result.cached, false);
      assert.equal(stub.calls.length, 1, 'corrupt cache must be re-downloaded');
      assert.equal(fs.readFileSync(dest).toString(), body.toString());
    } finally { stub.restore(); }

    // Valid cache: no network call, cached=true, hashes still returned.
    stub = stubFetch(() => json({}, 500));
    try {
      const result = await downloadFirstAvailable([{ url: 'https://cdn.modrinth.com/cache.bin', ...expected }], {
        dest, allowedHosts: MODRINTH_ALLOWED_HOSTS,
      });
      assert.equal(result.cached, true);
      assert.equal(result.attempts, 0);
      assert.equal(stub.calls.length, 0, 'verified cache must not hit the network');
      assert.equal(result.sha1, expected.sha1);
    } finally { stub.restore(); }

    const hashes = await hashFile(dest);
    assert.equal(hashes.sha512, expected.sha512);
    assert.equal(await verifyCachedFile(dest, { size: expected.size + 1 }), false);
    assert.equal(await verifyCachedFile(dest, {}), true);
  } finally {
    temp.cleanup();
  }
});
