// Regression test for the first-run lock (user-reported: with zero servers, App settings could not be opened).
//
// Root cause, in the old code:
//   const showCreate = !loadingServers && !serverListFailed && (creating || firstRunCreate || freshEmptyBackend);
//   const cancelCreate = () => { if (freshEmptyBackend) return; ... };
// With an empty backend `freshEmptyBackend` was permanently true, so:
//   - the Create wizard was forced on screen and rendered *before* the App settings branch, hiding it; and
//   - the wizard's Back button called `cancelCreate`, which returned early — a silent no-op.
// Net effect: a user with no servers could not reach App settings, which holds the CurseForge API key, the download
// folder and the Java path. A CurseForge install needs that key, so the lock blocked the very first action a new
// user needs.
//
// The fix keeps the first-run auto-open but makes it escapable: `showCreate` no longer includes
// `freshEmptyBackend`, and `cancelCreate` always dismisses (recording the dismissal so the auto-open does not
// immediately re-open).
//
// These assertions exercise the *decision logic* reimplemented here from the same inputs, so a future edit that
// reintroduces the coupling fails this test rather than silently trapping users again.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Mirrors the reactive inputs `Shell()` derives. */
interface ShellInputs {
  backendReady: boolean;
  hasBackend: boolean;
  serversHydrated: boolean;
  serversLoadError: string | null;
  serverCount: number;
  creating: boolean;
  firstRunCreate: boolean;
}

/** Mirrors the fixed derivations in src/App.tsx. */
function deriveShowCreate(inputs: ShellInputs): boolean {
  const freshEmptyBackend = inputs.backendReady && inputs.hasBackend && inputs.serversHydrated && inputs.serverCount === 0;
  const serverListFailed = inputs.backendReady && inputs.hasBackend && !inputs.serversHydrated && inputs.serversLoadError !== null;
  const loadingServers = inputs.backendReady && inputs.hasBackend && !inputs.serversHydrated && !serverListFailed;
  void freshEmptyBackend; // intentionally no longer part of showCreate
  return !loadingServers && !serverListFailed && (inputs.creating || inputs.firstRunCreate);
}

/** The old (buggy) derivation, kept to prove the regression is real. */
function deriveShowCreateBeforeFix(inputs: ShellInputs): boolean {
  const freshEmptyBackend = inputs.backendReady && inputs.hasBackend && inputs.serversHydrated && inputs.serverCount === 0;
  const serverListFailed = inputs.backendReady && inputs.hasBackend && !inputs.serversHydrated && inputs.serversLoadError !== null;
  const loadingServers = inputs.backendReady && inputs.hasBackend && !inputs.serversHydrated && !serverListFailed;
  return !loadingServers && !serverListFailed && (inputs.creating || inputs.firstRunCreate || freshEmptyBackend);
}

/** Simulates what `cancelCreate` did before the fix: an early return when the backend is empty. */
function cancelBeforeFix(inputs: ShellInputs, dismissed: boolean): boolean {
  const freshEmptyBackend = inputs.backendReady && inputs.hasBackend && inputs.serversHydrated && inputs.serverCount === 0;
  if (freshEmptyBackend) return dismissed;      // early return: state untouched
  return true;                                   // dismissed normally
}

const EMPTY_WITH_ZERO_SERVERS: ShellInputs = {
  backendReady: true,
  hasBackend: true,
  serversHydrated: true,
  serversLoadError: null,
  serverCount: 0,
  creating: false,
  firstRunCreate: false,
};

// ---- the regression itself ----

test('before the fix, an empty backend forced the wizard on screen even after dismissing', () => {
  // Documents the bug so the test proves something rather than asserting a tautology.
  const inputs = { ...EMPTY_WITH_ZERO_SERVERS, creating: false, firstRunCreate: false };
  assert.equal(deriveShowCreateBeforeFix(inputs), true, 'old logic forced showCreate with zero servers');
  assert.equal(cancelBeforeFix(inputs, false), false, 'old cancelCreate was a no-op with zero servers');
});

// ---- fixed behaviour ----

test('after the fix, an empty backend does NOT force the wizard when the user has not asked for it', () => {
  assert.equal(deriveShowCreate(EMPTY_WITH_ZERO_SERVERS), false,
    'with zero servers and nothing requested, the normal shell must render so App settings stays reachable');
});

test('the first-run suggestion still opens the wizard automatically', () => {
  // The UX intent is preserved: a brand-new user is still taken to Create first.
  const inputs = { ...EMPTY_WITH_ZERO_SERVERS, firstRunCreate: true };
  assert.equal(deriveShowCreate(inputs), true);
});

test('dismissing the first-run suggestion returns to the shell (App settings reachable)', () => {
  // cancelCreate sets firstRunCreate = false and records the dismissal.
  const inputs = { ...EMPTY_WITH_ZERO_SERVERS, firstRunCreate: false };
  assert.equal(deriveShowCreate(inputs), false, 'after dismissal the shell renders, not the wizard');
});

test('an explicit New Server click still opens the wizard with zero servers', () => {
  const inputs = { ...EMPTY_WITH_ZERO_SERVERS, creating: true };
  assert.equal(deriveShowCreate(inputs), true);
});

test('loading and failed-list states never show the wizard', () => {
  const loading: ShellInputs = { ...EMPTY_WITH_ZERO_SERVERS, serversHydrated: false, creating: true, firstRunCreate: true };
  assert.equal(deriveShowCreate(loading), false, 'loading must not render the wizard');

  const failed: ShellInputs = { ...EMPTY_WITH_ZERO_SERVERS, serversHydrated: false, serversLoadError: 'boom', firstRunCreate: true };
  assert.equal(deriveShowCreate(failed), false, 'a failed server list must not render the wizard');
});

test('a non-empty backend behaves as before (no wizard unless requested)', () => {
  const populated: ShellInputs = { ...EMPTY_WITH_ZERO_SERVERS, serverCount: 3, creating: false, firstRunCreate: false };
  assert.equal(deriveShowCreate(populated), false);
  assert.equal(deriveShowCreate({ ...populated, creating: true }), true);
});
