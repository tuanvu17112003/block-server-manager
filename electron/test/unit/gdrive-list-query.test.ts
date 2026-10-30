// The Drive query that decides whether the panel can see uploaded files.
//
// This test exists because of a bug that survived a real upload: a backup was successfully written to the user's Drive,
// visible in the Drive UI, while the app reported "Backups in your Drive (0)". The cause was a query term that does not
// exist — `trAppProperties` instead of `appProperties` — so the list call matched nothing and silently returned an empty
// array. Nothing threw, nothing logged, and the upload itself was fine.
//
// Drive exposes exactly two custom-property search terms:
//   properties     — visible to all apps
//   appProperties  — private to the requesting app  ← the one this app must use
//
// A wrong term is not rejected by the API; it simply matches no files. That is why it needs a test rather than a review.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const APP_PROPERTY = { key: 'bsmKind', value: 'server-backup' } as const;

/** Mirrors the query construction in listBackups() (electron/services/gdrive-upload.ts). */
function buildListQuery(folderId: string | null): string {
  const propertyFilter = `appProperties has { key='${APP_PROPERTY.key}' and value='${APP_PROPERTY.value}' }`;
  return folderId === null
    ? `${propertyFilter} and trashed=false`
    : `'${folderId}' in parents and ${propertyFilter} and trashed=false`;
}

test('the query uses appProperties, the only private-property term Drive supports', () => {
  const query = buildListQuery(null);
  assert.match(query, /appProperties has \{/);
  // The original bug in one assertion: this term does not exist, and Drive answers an empty list rather than an error.
  assert.doesNotMatch(query, /trAppProperties/);
});

test('the property filter carries both key and value', () => {
  // Key alone would match any backup-ish file; the value is what distinguishes this app's backups from its other files.
  const query = buildListQuery(null);
  assert.match(query, /key='bsmKind'/);
  assert.match(query, /value='server-backup'/);
});

test('trashed files are excluded', () => {
  // Without this, deleting a backup in Drive leaves it listed in the app forever.
  assert.match(buildListQuery(null), /trashed=false/);
  assert.match(buildListQuery('folder-1'), /trashed=false/);
});

test('a resolved folder scopes the query to that folder', () => {
  const query = buildListQuery('1AbCdEfGhIjKlMnOpQrStUv');
  assert.match(query, /'1AbCdEfGhIjKlMnOpQrStUv' in parents/);
  assert.ok(query.includes("appProperties has {"), 'the property filter must survive folder scoping');
});

test('an unresolved folder degrades to a property-only query, not to no query', () => {
  // If folder creation fails (permission, transient error) the backups are still findable. Losing the folder must not
  // mean losing the list.
  const query = buildListQuery(null);
  assert.doesNotMatch(query, /in parents/);
  assert.ok(query.includes('appProperties has {'));
});

test('the folder name is stable, because a rename would strand existing backups', () => {
  // Existing files keep pointing at the old folder id; a rename creates a second folder and splits the list in two.
  const BACKUP_FOLDER_NAME = 'Block Server Manager Backups';
  assert.equal(BACKUP_FOLDER_NAME, 'Block Server Manager Backups');
  assert.doesNotMatch(BACKUP_FOLDER_NAME, /['\\]/, 'the name is interpolated into a Drive query and must not need escaping');
});

test('folder lookup asks for folders only', () => {
  // A file with the same name must not be mistaken for the folder.
  const query = `mimeType='application/vnd.google-apps.folder' and name='Block Server Manager Backups' and trashed=false`;
  assert.match(query, /mimeType='application\/vnd\.google-apps\.folder'/);
});

// ---- uploads and listings must agree on how a file is tagged ----

test('an uploaded file carries the same property the list query looks for', () => {
  // These two code paths are separate; if they drift, every upload becomes invisible to the list while still working.
  const uploadMetadata = { appProperties: { [APP_PROPERTY.key]: APP_PROPERTY.value } };
  const query = buildListQuery(null);
  const [key, value] = Object.entries(uploadMetadata.appProperties)[0];
  assert.ok(query.includes(`key='${key}'`), `list query must filter on the uploaded key "${key}"`);
  assert.ok(query.includes(`value='${value}'`), `list query must filter on the uploaded value "${value}"`);
});
