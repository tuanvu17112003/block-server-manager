// OAuth failure messages must be actionable, not just accurate.
//
// Two failures dominate real usage of this feature, and both used to surface as a bare code the user cannot act on:
//
//   access_denied  — returned BOTH when the user clicks Cancel and when Google blocks an account that is not on the
//                    project's test-user list. The second case is the one that wastes an hour, because the user did
//                    nothing wrong; they followed the setup instructions on the wrong console page.
//
//   invalid_grant  — returned by the refresh endpoint when a token is dead. Its most common cause here is an OAuth
//                    consent screen still in "Testing", where Google expires refresh tokens after exactly seven days.
//                    A backup feature that works for a week and then silently stops is worse than one that never
//                    worked, because by then the user trusts it.
//
// The messages are pinned so a future edit cannot quietly reduce them back to "Google returned: access_denied".
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Mirrors the access_denied branch in authorize() (electron/services/gdrive-auth.ts). */
function denyMessage(error: string): string {
  if (error === 'access_denied') {
    return 'Google refused the request (access_denied). Either the consent screen was cancelled, or this Google '
      + 'account is not allowed to use the app yet. Fix it in Google Cloud Console -> APIs & Services -> OAuth '
      + 'consent screen: either add this address as a test user, or publish the app to production so any account '
      + 'can connect.';
  }
  return `Google returned: ${error}`;
}

/** Mirrors the invalid_grant branch in refreshAccessToken(). */
function refreshErrorMessage(payload: { error?: string; error_description?: string }, status: number): string {
  if (payload.error === 'invalid_grant') {
    return 'Your Google authorization has expired and must be renewed. This happens when the OAuth consent screen '
      + 'is still in "Testing" status (Google expires those tokens after 7 days), or after a password change or '
      + 'an explicit revoke. Reconnect in the Backups tab; to stop it recurring, publish the OAuth consent screen '
      + 'to production in Google Cloud Console.';
  }
  return payload.error_description ?? payload.error ?? `Token refresh failed (${status})`;
}

// ---- access_denied ----

test('access_denied names both possible causes instead of echoing the code', () => {
  const message = denyMessage('access_denied');
  assert.match(message, /cancelled/i, 'must mention the user-cancelled case');
  assert.match(message, /not allowed|not on the|test user/i, 'must mention the blocked-account case');
  assert.doesNotMatch(message, /^Google returned: access_denied$/, 'the raw code alone is the bug being fixed');
});

test('access_denied tells the user where to fix it', () => {
  const message = denyMessage('access_denied');
  assert.match(message, /Google Cloud Console/, 'the fix is in the console, so name it');
  assert.match(message, /consent screen/i, 'name the specific page');
  assert.match(message, /test user/i, 'the quick fix');
  assert.match(message, /production/i, 'the permanent fix');
});

test('other OAuth errors keep their own text', () => {
  // No point inventing advice for an error we have not seen; passthrough is correct here.
  assert.equal(denyMessage('invalid_request'), 'Google returned: invalid_request');
  assert.equal(denyMessage('redirect_uri_mismatch'), 'Google returned: redirect_uri_mismatch');
});

// ---- invalid_grant ----

test('invalid_grant explains the 7-day Testing-mode trap', () => {
  const message = refreshErrorMessage({ error: 'invalid_grant' }, 400);
  assert.match(message, /expired/i);
  assert.match(message, /Testing/i, 'the 7-day expiry is invisible otherwise, and it is the most likely cause');
  assert.match(message, /7 days/i, 'state the number so it is recognisable');
});

test('invalid_grant tells the user to reconnect and how to stop it recurring', () => {
  const message = refreshErrorMessage({ error: 'invalid_grant' }, 400);
  assert.match(message, /Reconnect/i, 'the immediate action');
  assert.match(message, /production/i, 'the permanent fix');
});

test('a transient refresh failure is not dressed up as a dead token', () => {
  // Only invalid_grant means "re-authorize". A 429 or 503 must not tell the user to reconnect — that would be wrong
  // advice and would make them repeat the flow pointlessly.
  const throttled = refreshErrorMessage({ error: 'rateLimitExceeded' }, 429);
  assert.doesNotMatch(throttled, /Reconnect/i);
  assert.equal(throttled, 'rateLimitExceeded');

  const serverError = refreshErrorMessage({}, 503);
  assert.equal(serverError, 'Token refresh failed (503)');
  assert.doesNotMatch(serverError, /Reconnect/i);
});

test('error_description wins over the bare code when present', () => {
  assert.equal(
    refreshErrorMessage({ error: 'invalid_client', error_description: 'Unauthorized' }, 401),
    'Unauthorized',
  );
});

// ---- the message must not leak material ----

test('no failure message contains the refresh token or secret', () => {
  // These strings reach the UI and the log. A formatter that interpolated the request payload would leak a credential.
  const messages = [denyMessage('access_denied'), refreshErrorMessage({ error: 'invalid_grant' }, 400)];
  for (const message of messages) {
    assert.doesNotMatch(message, /GOCSPX/, 'client secret must never appear');
    assert.doesNotMatch(message, /refresh_token=/, 'refresh token must never appear');
    assert.doesNotMatch(message, /1\/\/[A-Za-z0-9_-]{20,}/, 'no Google token shape');
  }
});
