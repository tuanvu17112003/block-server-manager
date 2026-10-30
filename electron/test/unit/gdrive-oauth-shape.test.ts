// The OAuth credential file shape.
//
// This test exists because of a real user-facing failure: the first loader expected `{ clientId, clientSecret }`, a shape
// no Google download produces, so a perfectly valid `google-oauth.json` sitting in the app data folder was rejected and
// the UI said "not set up". The user had followed the instructions exactly.
//
// The file Google Cloud Console actually offers for a Desktop app client is:
//
//   { "installed": { "client_id": "...", "client_secret": "...", "redirect_uris": [...] } }
//
// A "Web application" client wraps the same fields in "web" instead. Both are parsed here, plus the flat shape for
// hand-written config. Anything else must fail with a message that names what was found, because "not configured" with
// no detail is what made the original failure opaque.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Mirrors loadOAuthClientDetailed() from electron/services/gdrive-auth.ts, minus the filesystem. */
function parseOAuthConfig(parsed: unknown): { client: { clientId: string; clientSecret: string } | null; error?: string; warning?: string } {
  const normalise = (value: unknown) => {
    if (typeof value !== 'object' || value === null) return null;
    const raw = value as { client_id?: unknown; client_secret?: unknown };
    if (typeof raw.client_id !== 'string' || raw.client_id === '') return null;
    if (typeof raw.client_secret !== 'string' || raw.client_secret === '') return null;
    return { clientId: raw.client_id, clientSecret: raw.client_secret };
  };

  if (typeof parsed !== 'object' || parsed === null) {
    return { client: null, error: 'does not contain a JSON object' };
  }
  const record = parsed as Record<string, unknown>;

  const installed = normalise(record.installed);
  if (installed !== null) return { client: installed };

  const web = normalise(record.web);
  if (web !== null) return { client: web, warning: 'Web application client' };

  const flat = normalise({ client_id: record.clientId, client_secret: record.clientSecret });
  if (flat !== null) return { client: flat };

  const keys = Object.keys(record);
  return {
    client: null,
    error: `expected an "installed" object but found keys: ${keys.length > 0 ? keys.join(', ') : '(none)'}`,
  };
}

// ---- the shape Google actually downloads ----

test('the "installed" shape from Google Cloud Console is accepted', () => {
  // This is the exact structure a Desktop app client downloads as. Rejecting it was the bug.
  const file = {
    installed: {
      client_id: '234000785708-abcdef.apps.googleusercontent.com',
      project_id: 'block-server-manager',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      client_secret: 'GOCSPX-example',
      redirect_uris: ['http://localhost'],
    },
  };
  const result = parseOAuthConfig(file);
  assert.equal(result.client?.clientId, '234000785708-abcdef.apps.googleusercontent.com');
  assert.equal(result.client?.clientSecret, 'GOCSPX-example');
  assert.equal(result.error, undefined, 'a valid Google file must not produce an error');
});

test('the "web" shape is accepted but carries a warning', () => {
  // It can work only if a loopback URI was registered; saying so up front beats a redirect_uri_mismatch mid-flow.
  const file = { web: { client_id: 'x.apps.googleusercontent.com', client_secret: 'y' } };
  const result = parseOAuthConfig(file);
  assert.equal(result.client?.clientId, 'x.apps.googleusercontent.com');
  assert.match(result.warning ?? '', /Web application/i);
});

test('the flat hand-written shape still works', () => {
  const result = parseOAuthConfig({ clientId: 'flat-id', clientSecret: 'flat-secret' });
  assert.equal(result.client?.clientId, 'flat-id');
});

// ---- failures must explain themselves ----

test('an empty object reports which keys were found, not a blanket failure', () => {
  const result = parseOAuthConfig({});
  assert.equal(result.client, null);
  assert.match(result.error ?? '', /found keys: \(none\)/);
});

test('a file with unrelated keys names them in the error', () => {
  // The realistic wrong file: the user downloaded something else, or copied a service-account key.
  const result = parseOAuthConfig({ type: 'service_account', project_id: 'x', private_key: 'y' });
  assert.equal(result.client, null);
  assert.match(result.error ?? '', /type, project_id, private_key/);
});

test('missing client_secret is rejected rather than half-loaded', () => {
  const result = parseOAuthConfig({ installed: { client_id: 'only-id' } });
  assert.equal(result.client, null, 'a client without a secret cannot complete the token exchange');
  assert.match(result.error ?? '', /installed/);
});

test('empty strings are treated as absent', () => {
  const result = parseOAuthConfig({ installed: { client_id: '', client_secret: 'y' } });
  assert.equal(result.client, null);
});

test('a non-object payload is rejected', () => {
  for (const value of [null, 'string', 42, []]) {
    assert.equal(parseOAuthConfig(value).client, null, `payload ${JSON.stringify(value)} must not load`);
  }
});

// ---- secrets must never be logged ----

test('the error message never contains the secret', () => {
  // A malformed file may still carry a real secret; echoing the whole object into a log or a UI message would leak it.
  const result = parseOAuthConfig({ installed: { client_id: 'id-only-not-secret' } });
  assert.doesNotMatch(result.error ?? '', /GOCSPX/);
  assert.doesNotMatch(result.error ?? '', /client_secret=/);
});
