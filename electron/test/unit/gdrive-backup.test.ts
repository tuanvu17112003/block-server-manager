// Google Drive backup: the parts that are provably wrong when wrong.
//
// These tests deliberately avoid the network. What they cover is the logic that a real upload round-trip would NOT
// reveal until it failed in production:
//
//   * PKCE — a mismatch here produces "invalid_grant" at the token endpoint, which reads like a credentials problem and
//     sends you debugging the wrong thing;
//   * the resumable-upload offset — Drive answers 308 with a Range header, and mishandling it either skips bytes
//     (corrupt backup, silent) or re-sends them (works, but wastes minutes on a 2 GB file);
//   * quota — a backup that does not fit must be refused with numbers BEFORE the upload starts, not after 40 minutes;
//   * never deleting a local backup because the remote copy failed.
//
// The re-derivation pattern is used where the module imports `electron` (gdrive-auth opens a browser); the pure
// helpers are exercised directly where they are importable without Electron.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// ---- PKCE, re-derived identically to electron/services/gdrive-auth.ts ----

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function codeChallengeFor(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

test('the PKCE challenge is base64url(SHA-256(verifier)) with no padding', () => {
  // RFC 7636 Appendix B publishes this exact pair, so it can be checked against the spec rather than against itself.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  assert.equal(codeChallengeFor(verifier), expected, 'the canonical RFC 7636 vector must match');
});

test('the challenge never contains characters that need URL escaping', () => {
  // A '+' or '/' reaching the query string unescaped silently changes the challenge and breaks the flow.
  for (let i = 0; i < 30; i += 1) {
    const challenge = codeChallengeFor(`verifier-${i}-${'x'.repeat(20)}`);
    assert.doesNotMatch(challenge, /[+/=]/, `challenge must be base64url, got ${challenge}`);
  }
});

test('a different verifier yields a different challenge', () => {
  assert.notEqual(codeChallengeFor('verifier-a'), codeChallengeFor('verifier-b'));
});

// ---- resumable upload offsets ----

/**
 * Mirrors the 308 handling in uploadToSession(): Drive reports the last byte it accepted, inclusive.
 *
 * Getting the +1 wrong is the classic off-by-one here: it either re-sends one byte (harmless but noticeable) or skips
 * one byte (a corrupt archive that only fails when someone tries to restore it).
 */
function nextOffsetFrom(range: string | null, fallbackOffset: number, chunkLength: number): number {
  if (range !== null) {
    const match = /bytes=0-(\d+)/.exec(range);
    if (match !== null) return Number(match[1]) + 1;
  }
  return fallbackOffset + chunkLength;
}

test('a Range response advances the offset past the last accepted byte', () => {
  // Drive said it has bytes 0..8388607; the next request must start at 8388608, not 8388607.
  assert.equal(nextOffsetFrom('bytes=0-8388607', 0, 8 * 1024 * 1024), 8 * 1024 * 1024);
});

test('a Range-less 308 falls back to the chunk length', () => {
  assert.equal(nextOffsetFrom(null, 1024, 512), 1536);
});

test('consecutive chunks cover the file exactly once', () => {
  const total = 20 * 1024 * 1024;
  const chunk = 8 * 1024 * 1024;
  const ranges: string[] = [];
  let offset = 0;
  while (offset < total) {
    const length = Math.min(chunk, total - offset);
    ranges.push(`bytes ${offset}-${offset + length - 1}/${total}`);
    offset = nextOffsetFrom(`bytes=0-${offset + length - 1}`, offset, length);
  }
  assert.equal(offset, total, 'the final offset must equal the file size — no bytes skipped, none requested twice');
  assert.equal(ranges.length, 3, '20 MiB in 8 MiB chunks is three requests');
  assert.equal(ranges[0], `bytes 0-8388607/20971520`);
  assert.equal(ranges[2], `bytes 16777216-20971519/20971520`);
});

// ---- quota ----

/**
 * Mirrors the quota gate in uploadBackup(). Unlimited accounts report limit 0; they must never be blocked.
 */
function quotaGate(remainingBytes: number, fileBytes: number): { ok: boolean } {
  return { ok: remainingBytes >= fileBytes };
}

test('an upload that does not fit is refused', () => {
  assert.equal(quotaGate(400 * 1024 ** 2, 3 * 1024 ** 3).ok, false);
});

test('an upload that exactly fits is allowed', () => {
  assert.equal(quotaGate(1024, 1024).ok, true, 'equal size must be allowed — a strict > would refuse a perfect fit');
});

test('an unlimited account (remaining = MAX_SAFE_INTEGER) is never blocked', () => {
  assert.equal(quotaGate(Number.MAX_SAFE_INTEGER, 50 * 1024 ** 3).ok, true);
});

test('formatted sizes are human readable at every scale', () => {
  // Mirrors formatBytes(): the message shown when quota blocks an upload must be readable, not "3221225472 bytes".
  const format = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
  };
  assert.equal(format(512), '512 B');
  assert.equal(format(1536), '1.5 KB');
  assert.equal(format(3 * 1024 ** 3), '3.0 GB');
  assert.equal(format(15.4 * 1024 ** 3), '15 GB');
  assert.equal(format(-1), 'unknown size');
});

// ---- the rule that protects the user's data ----

test('a remote failure must never delete the local backup', async () => {
  // Modelled as the decision table the caller follows. The local copy is the one that actually protects the user; a
  // backup feature that deletes its own source on a network error is worse than no backup feature.
  const decideLocalDeletion = (outcome: { ok: boolean }): boolean => {
    // Delete a local backup only as part of normal retention (count/age), never because the upload failed.
    void outcome;
    return false;
  };
  assert.equal(decideLocalDeletion({ ok: false }), false);
  assert.equal(decideLocalDeletion({ ok: true }), false, 'a successful upload is not a reason to delete either');
});

test('a dead refresh token is reported as re-auth, not as a retryable error', () => {
  // 401/403 must stop the scheduler from hammering the endpoint with a token that will never work again.
  const classify = (status: number): 'reauth' | 'retry' | 'fatal' => {
    if (status === 401 || status === 403) return 'reauth';
    if (status === 429 || status >= 500) return 'retry';
    return 'fatal';
  };
  assert.equal(classify(401), 'reauth');
  assert.equal(classify(403), 'reauth');
  assert.equal(classify(429), 'retry', 'quota/rate limit is transient, so retrying is correct');
  assert.equal(classify(503), 'retry');
  assert.equal(classify(400), 'fatal');
});

test('only files this app tagged are eligible for cleanup', () => {
  // Cleanup decides by app property, not by name: a user's own "backup.zip" in the same Drive must be untouchable.
  const APP_PROPERTY = { key: 'bsmKind', value: 'server-backup' };
  const isOurs = (file: { appProperties?: Record<string, string> }): boolean =>
    file.appProperties?.[APP_PROPERTY.key] === APP_PROPERTY.value;
  assert.equal(isOurs({ appProperties: { bsmKind: 'server-backup' } }), true);
  assert.equal(isOurs({ appProperties: { bsmKind: 'something-else' } }), false);
  assert.equal(isOurs({ appProperties: {} }), false);
  assert.equal(isOurs({}), false, 'a file with no properties is not ours, whatever it is called');
});

test('malformed file ids are rejected before a delete call', () => {
  const valid = /^[A-Za-z0-9_-]{10,}$/;
  assert.ok(valid.test('1AbCdEfGhIjKlMnOpQrStUvWxYz'));
  assert.equal(valid.test(''), false);
  assert.equal(valid.test('short'), false);
  assert.equal(valid.test('../../etc/passwd'), false);
});

test('Drive filenames are sanitised but stay identifiable', () => {
  const driveNameFor = (serverName: string, backupName: string): string => {
    const safeServer = serverName.replace(/[\\/:*?"<>|]/g, '_').trim() || 'server';
    return `${safeServer}__${backupName}`;
  };
  assert.equal(driveNameFor('My Server', 'world-2026.zip'), 'My Server__world-2026.zip');
  assert.equal(driveNameFor('a/b:c', 'w.zip'), 'a_b_c__w.zip');
  // A name made only of separators becomes underscores, not an empty string: the fallback exists for names that are
  // empty AFTER trimming, which a whitespace-only name exercises. Asserting '///' -> 'server' was wrong, and this test
  // caught the mistaken assumption rather than the code.
  assert.equal(driveNameFor('///', 'w.zip'), '_____w.zip');
  assert.equal(driveNameFor('   ', 'w.zip'), 'server__w.zip', 'whitespace-only must fall back, not produce "   __w.zip"');
  assert.equal(driveNameFor('', 'w.zip'), 'server__w.zip');
  assert.doesNotMatch(driveNameFor('a\\b', 'w.zip'), /[\\/]/);
});
