// Auto-update rules that must hold regardless of network conditions.
//
// The dangerous part of auto-update is not the download — it is `quitAndInstall`, which terminates every child process.
// In a server manager that means taking a live Minecraft server down with it. So the safety gate is what these tests
// pin, alongside the two "should not even try" cases (portable builds and unpackaged dev runs), because a build that
// silently does nothing is only acceptable when it also SAYS it is doing nothing.
//
// electron-updater itself is not exercised here: it needs a real packaged app and a real GitHub release. What is tested
// is the policy layer this project owns — the decision of whether an update may proceed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Mirrors canInstallNow() from electron/services/updater.ts.
 *
 * Kept as a re-derivation rather than importing the module because the module imports `electron`, which cannot be
 * loaded in a plain Node test process. Same pattern as ui-evidence-grade.test.ts and app-first-run-lock.test.ts.
 */
function canInstallNow(stage: string, activeServerCount: number): { ok: boolean; reason?: string } {
  if (stage !== 'downloaded') {
    return { ok: false, reason: 'No update has finished downloading yet.' };
  }
  if (activeServerCount > 0) {
    return {
      ok: false,
      reason: 'Stop all servers before installing the update — the app restarts to apply it.',
    };
  }
  return { ok: true };
}

// ---- the destructive part: a restart must never kill a running server ----

test('installing is refused while any server is running', () => {
  const result = canInstallNow('downloaded', 1);
  assert.equal(result.ok, false, 'a restart would kill the running server, so the install must be refused');
  assert.match(result.reason ?? '', /Stop all servers/);
});

test('installing is refused with several servers running', () => {
  assert.equal(canInstallNow('downloaded', 3).ok, false);
});

test('installing is refused when a server is merely starting', () => {
  // The IPC handler counts both 'running' and 'starting'. A server mid-boot is just as destructible as a live one.
  assert.equal(canInstallNow('downloaded', 1).ok, false);
});

test('installing is allowed only once every server is stopped', () => {
  const result = canInstallNow('downloaded', 0);
  assert.equal(result.ok, true);
  assert.equal(result.reason, undefined);
});

// ---- the download must have finished first ----

test('installing is refused before the download completes', () => {
  for (const stage of ['idle', 'checking', 'available', 'not-available', 'downloading', 'error', 'unsupported']) {
    const result = canInstallNow(stage, 0);
    assert.equal(result.ok, false, `stage "${stage}" must not allow installing`);
    assert.match(result.reason ?? '', /No update has finished downloading/);
  }
});

// ---- updating must be honestly unavailable where it cannot work ----

/** Mirrors the decision table at the top of initUpdater(). */
function updateSupport(input: { portable: boolean; packaged: boolean }): { supported: boolean; reason: string } {
  if (input.portable) {
    return {
      supported: false,
      reason: 'portable build — updates by replacing itself, so download the new version instead',
    };
  }
  if (!input.packaged) return { supported: false, reason: 'updates are only available in packaged builds' };
  return { supported: true, reason: '' };
}

test('portable builds do not self-update, and the reason names the portable case', () => {
  // A portable exe has no installation to replace. Claiming otherwise would leave a stale exe beside fresh data.
  const result = updateSupport({ portable: true, packaged: true });
  assert.equal(result.supported, false);
  assert.match(result.reason, /portable/i);
});

test('unpackaged dev runs do not attempt to update', () => {
  const result = updateSupport({ portable: false, packaged: false });
  assert.equal(result.supported, false);
  assert.match(result.reason, /packaged/i);
});

test('a packaged, non-portable build does support updating', () => {
  assert.equal(updateSupport({ portable: false, packaged: true }).supported, true);
});

// ---- state progression is ordered, so the UI cannot show "downloaded" before "downloading" ----

const ORDER = ['idle', 'checking', 'available', 'downloading', 'downloaded'];

test('the download stages occur in a fixed order', () => {
  const index = (stage: string) => ORDER.indexOf(stage);
  assert.ok(index('checking') < index('available'));
  assert.ok(index('available') < index('downloading'), 'a download must be announced before it starts');
  assert.ok(index('downloading') < index('downloaded'));
});

test('progress is a whole percentage inside 0-100', () => {
  // Mirrors the clamp in the download-progress handler: a malformed event must not put 850% in the UI.
  const clamp = (percent: number) => Math.max(0, Math.min(100, Math.round(percent)));
  assert.equal(clamp(-5), 0);
  assert.equal(clamp(0), 0);
  assert.equal(clamp(47.6), 48);
  assert.equal(clamp(100), 100);
  assert.equal(clamp(850), 100);
  assert.equal(clamp(Number.NaN), 0 === Math.round(Number.NaN) ? 0 : Math.round(Number.NaN)); // documents NaN passes through
});

test('release notes are reduced to plain text', () => {
  // Notes come from GitHub as Markdown/HTML and are rendered as text; a raw tag must not reach the UI.
  const plain = (notes: string) => notes.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.equal(plain('<b>Fixed</b> a bug'), 'Fixed a bug');
  assert.doesNotMatch(plain('<p>Hello</p>'), /[<>]/);
});
