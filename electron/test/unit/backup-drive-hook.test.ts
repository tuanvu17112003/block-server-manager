// Auto-upload to Drive must never be able to fail a backup.
//
// This is the rule that matters most in the whole Drive feature, and it is easy to get wrong in a way no test notices:
// if the afterBackup hook is awaited, or its rejection propagates, then a network error turns "your world is safely
// zipped on disk" into "backup failed". The user then believes they have no backup and may take another, while the
// first one actually succeeded — or worse, stops relying on backups entirely.
//
// The hook is therefore called fire-and-forget after the record is written and committed. These tests pin the shape of
// that contract at the level of decisions, since the real service needs a live server process to exercise.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Mirrors Backups.create()'s post-backup contract:
 *   const record = await this.doCreate(...);   // local backup is complete and recorded here
 *   try { this.deps.afterBackup?.(record); }   // fire and forget, never awaited, never able to fail the backup
 *   catch { /* reported, not thrown *\/ }
 *   return record;
 */
function simulateCreate(options: {
  doCreate: () => Promise<{ id: string }>;
  afterBackup?: (record: { id: string }) => void;
}): Promise<{ id: string }> {
  return options.doCreate().then((record) => {
    try {
      options.afterBackup?.(record);
    } catch {
      // Swallowed on purpose: the backup already succeeded. The real implementation logs it to the job.
    }
    return record;
  });
}

test('a successful backup returns successfully even when the upload hook throws synchronously', async () => {
  const record = await simulateCreate({
    doCreate: () => Promise.resolve({ id: 'backup-1' }),
    afterBackup: () => { throw new Error('network down'); },
  });
  assert.equal(record.id, 'backup-1', 'the backup must be reported as created');
});

test('the hook receives the completed record, not a placeholder', async () => {
  let seen: { id: string } | null = null;
  const record = await simulateCreate({
    doCreate: () => Promise.resolve({ id: 'backup-2' }),
    afterBackup: (r) => { seen = r; },
  });
  assert.deepEqual(seen, record, 'the hook must see the same record the caller receives');
});

test('a backup with no Drive configured still succeeds (hook is optional)', async () => {
  const record = await simulateCreate({ doCreate: () => Promise.resolve({ id: 'backup-3' }) });
  assert.equal(record.id, 'backup-3');
});

test('a FAILED backup does not invoke the upload hook', async () => {
  let called = false;
  await assert.rejects(
    simulateCreate({
      doCreate: () => Promise.reject(new Error('disk full')),
      afterBackup: () => { called = true; },
    }),
    /disk full/,
  );
  assert.equal(called, false, 'there is nothing to upload when the backup itself failed');
});

test('the backup resolves before the upload could possibly finish', async () => {
  // Ordering matters: the caller must not wait on a multi-minute Drive upload. The hook starts async work and returns
  // immediately, so the backup promise settles while the upload is still in flight.
  let uploadSettled = false;
  const record = await simulateCreate({
    doCreate: () => Promise.resolve({ id: 'backup-4' }),
    afterBackup: () => {
      void (async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        uploadSettled = true;
      })();
    },
  });
  assert.equal(record.id, 'backup-4');
  assert.equal(uploadSettled, false, 'the backup must not have waited for the upload to finish');
});

// ---- mirrorBackupToDrive decision table ----

/**
 * Mirrors the early returns in mirrorBackupToDrive(). `skipped` exists so "not configured" is distinguishable from a
 * real failure: a user who never set up Drive must not see an error after every single backup.
 */
function mirrorDecision(input: { configured: boolean; connected: boolean; fileExists: boolean }): {
  action: 'upload' | 'skip' | 'error';
} {
  if (!input.configured) return { action: 'skip' };
  if (!input.connected) return { action: 'skip' };
  if (!input.fileExists) return { action: 'error' };
  return { action: 'upload' };
}

test('an unconfigured build skips silently', () => {
  assert.deepEqual(mirrorDecision({ configured: false, connected: false, fileExists: true }), { action: 'skip' });
});

test('a configured but disconnected account skips silently', () => {
  // This is the common case: most users will never connect Drive. An error toast after every backup would be noise.
  assert.deepEqual(mirrorDecision({ configured: true, connected: false, fileExists: true }), { action: 'skip' });
});

test('a connected account uploads', () => {
  assert.deepEqual(mirrorDecision({ configured: true, connected: true, fileExists: true }), { action: 'upload' });
});

test('a missing local file is a real error, not a skip', () => {
  // If the record says a backup exists but the file is gone, that is worth reporting — silent skipping would hide data
  // loss. The distinction between skip and error is the whole point of the field.
  assert.deepEqual(mirrorDecision({ configured: true, connected: true, fileExists: false }), { action: 'error' });
});

// ---- no retry storm ----

test('a dead token at backup time produces one report, not an automatic retry loop', () => {
  // A scheduled backup runs every hour. If each run retried a revoked token, the log fills with identical failures and
  // the real cause (the user must reconnect) is buried. The design reports once and waits for the user.
  const runScheduledBackups = (runs: number, needsReauth: boolean): { attempts: number; reported: number } => {
    let attempts = 0;
    let reported = 0;
    for (let i = 0; i < runs; i += 1) {
      attempts += 1;
      if (needsReauth) reported += 1;
      // No inner retry loop here on purpose: one attempt per scheduled backup.
    }
    return { attempts, reported };
  };
  const result = runScheduledBackups(3, true);
  assert.equal(result.attempts, 3, 'one attempt per backup, not a retry storm');
  assert.equal(result.reported, 3, 'each failure is reported so the user can act');
});
