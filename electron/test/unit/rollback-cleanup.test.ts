// Rollback must not leave a `.publishing-<uuid>` folder behind.
//
// This pins the origin of the orphaned folders found on a real machine. The sequence was:
//
//   1. install succeeded through boot verification
//   2. publish's final rename failed, leaving `<id>.publishing-<uuid>` (a complete copy)
//   3. rollbackRecord() deleted the store record and tried to remove `servers/<id>`
//   4. but `servers/<id>` had never been created — only the `.publishing-` sibling existed
//   5. so the leftover survived with no record: invisible to every screen, and never cleaned up
//
// Four accumulated, 106-112 MB each. The fix is that rollback removes the `.publishing-` sibling too, so a failed
// publish leaves nothing behind. Recovery then becomes a safety net rather than the only cleanup path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishStagedServer } from '../../services/install-transaction';
import { Store } from '../../services/store';

function makeDataRoot(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-test-'));
  fs.mkdirSync(path.join(base, 'servers'), { recursive: true });
  fs.mkdirSync(path.join(base, 'installer-staging'), { recursive: true });
  return base;
}

/** Minimal install input; the test never boots anything. */
function input() {
  return {
    name: 'rollback-probe',
    loader: 'Vanilla' as const,
    mcVersion: '1.20.1',
    ramMb: 2048,
    eulaAccepted: false,
  };
}

test('a publish that fails after staging leaves no .publishing- leftover', async () => {
  const dataRoot = makeDataRoot();
  const store = new Store(dataRoot);

  // Inject a publisher that leaves a temp sibling then throws — exactly what the real ladder does when every rung fails.
  const failingPublish = (_from: string, to: string): void => {
    const temp = `${to}.publishing-00000000-1111-2222-3333-444444444444`;
    fs.mkdirSync(temp, { recursive: true });
    fs.writeFileSync(path.join(temp, 'server.jar'), 'partial');
    throw new Error('simulated publish failure');
  };

  try {
    await assert.rejects(() =>
      publishStagedServer({
        dataRoot,
        store,
        input: input(),
        loaderKind: 'vanilla',
        install: ({ stagingDir }) => {
          fs.mkdirSync(stagingDir, { recursive: true });
          fs.writeFileSync(path.join(stagingDir, 'server.jar'), 'jar');
        },
        publish: failingPublish,
      }),
    );

    const entries = fs.readdirSync(path.join(dataRoot, 'servers'));
    const leftovers = entries.filter((n) => n.includes('.publishing-'));
    assert.deepEqual(leftovers, [], 'rollback must remove the .publishing- sibling it created');
    // And the record must be gone too, so no UI shows a server with no files.
    assert.equal(store.listServers().length, 0, 'the record must be rolled back');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('rollback removes the leftover even when the final folder was partially created', async () => {
  // The other shape: the copy fallback created some of the destination before failing. Rollback must clear both.
  const dataRoot = makeDataRoot();
  const store = new Store(dataRoot);

  const failingPublish = (_from: string, to: string): void => {
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, 'server.jar'), 'partial');
    const temp = `${to}.publishing-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
    fs.mkdirSync(temp, { recursive: true });
    fs.writeFileSync(path.join(temp, 'server.jar'), 'partial');
    throw new Error('simulated publish failure');
  };

  try {
    await assert.rejects(() =>
      publishStagedServer({
        dataRoot,
        store,
        input: input(),
        loaderKind: 'vanilla',
        install: ({ stagingDir }) => {
          fs.mkdirSync(stagingDir, { recursive: true });
          fs.writeFileSync(path.join(stagingDir, 'server.jar'), 'jar');
        },
        publish: failingPublish,
      }),
    );

    const entries = fs.readdirSync(path.join(dataRoot, 'servers'));
    assert.deepEqual(entries.filter((n) => n.includes('.publishing-')), [], 'no temp sibling survives');
    // A fully qualified server folder left by a partial copy must also be gone.
    const recordIds = new Set(store.listServers().map((s) => s.id));
    for (const entry of entries) {
      assert.equal(recordIds.has(entry), true, `folder ${entry} has no record — it would be invisible`);
    }
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
