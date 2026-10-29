// Item 5 (docs/audit/26): a pack in a known-but-deferred format must say so, with the recorded reason, instead
// of the generic "Unrecognized modpack format" — which is accurate but misleading, because the format is not
// unrecognised, it is knowingly deferred.
//
// Two properties are pinned here:
//   1. a deferred format produces the deferred message and a format matching nothing still produces the generic
//      one (so this cannot become a catch-all that hides genuinely unknown input);
//   2. the app's deferred list agrees with `scripts/conformance-waivers.json`, so the app and the conformance
//      report cannot drift apart about what is deferred and why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFERRED_FORMATS,
  deferredFormatMessage,
  identifyDeferredFormat,
} from '../../services/adapters/deferred-formats';
import { AdapterRegistry } from '../../services/adapters/registry';
import { ADAPTERS } from '../../services/adapters/index';
import type { ArchiveIndex } from '../../services/adapters/types';

function fakeArchive(names: string[]): ArchiveIndex {
  return {
    entries: names.map(name => ({ name, size: 1, isDir: false })),
    names: new Set(names),
    readText: async () => null,
    readJson: async <T = unknown>(): Promise<T | null> => null,
    under: (prefix: string) => names.filter(name => name.toLowerCase().startsWith(prefix.toLowerCase())),
  };
}

const noopIo = { log: (): void => {}, fetchJson: async <T = unknown>(): Promise<T> => ({}) as T };
const registry = new AdapterRegistry(ADAPTERS);

// ---- identification ----

test('each deferred format is identified by its own manifest filename', () => {
  // Markers come from research §2 rows 1/4/9/10 (each format's own manifest filename).
  const cases: [string, string[]][] = [
    ['mcbbs', ['mcbbs.packmeta', 'config/x.json']],
    ['hmcl.server', ['server-manifest.json', 'mods/a.jar']],
    ['gdlauncher', ['gdlpack.json', 'mods/a.jar']],
    ['technic', ['bin/modpack.jar', 'mods/a.jar']],
  ];
  for (const [id, names] of cases) {
    const found = identifyDeferredFormat(fakeArchive(names));
    assert.equal(found?.id, id, `expected ${id} from entries ${names.join(',')}`);
  }
});

test('identification is case-insensitive and order-independent', () => {
  assert.equal(identifyDeferredFormat(fakeArchive(['MCBBS.PACKMETA']))?.id, 'mcbbs');
  assert.equal(identifyDeferredFormat(fakeArchive(['mods/a.jar', 'gdlpack.json']))?.id, 'gdlauncher');
});

test('an archive matching no deferred format returns null (so the generic message survives)', () => {
  assert.equal(identifyDeferredFormat(fakeArchive(['mods/a.jar', 'config/a.cfg', 'readme.txt'])), null);
  assert.equal(identifyDeferredFormat(fakeArchive([])), null);
});

test('a marker that merely appears in a path does not match (exact entry name only)', () => {
  // `docs/gdlpack.json` is not a GDLauncher pack; only a root-level `gdlpack.json` is.
  assert.equal(identifyDeferredFormat(fakeArchive(['docs/gdlpack.json'])), null);
});

// ---- the message tells the truth ----

test('the deferred message names the format, gives the reason, and states nothing was changed', () => {
  const format = DEFERRED_FORMATS.find(entry => entry.id === 'mcbbs')!;
  const message = deferredFormatMessage(format);
  assert.match(message, /MCBBS/);
  assert.match(message, /not supported by this build yet/);
  assert.match(message, /Nothing was downloaded or changed/);
  // It must not read like a bug report invitation or claim it might work.
  assert.doesNotMatch(message, /could not be read|corrupt|invalid/i);
});

// ---- registry integration ----

test('registry: a deferred-format archive gets the deferred message, not the generic one', async () => {
  await assert.rejects(
    () => registry.resolve({ shape: 'archive', index: fakeArchive(['gdlpack.json', 'mods/a.jar']) }, noopIo),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /GDLauncher/);
      assert.match(message, /not supported by this build yet/);
      assert.doesNotMatch(message, /Unrecognized modpack format/, 'a known format must not be called unrecognised');
      return true;
    },
  );
});

test('registry: an archive matching nothing still gets the generic message with its evidence', async () => {
  await assert.rejects(
    () => registry.resolve({ shape: 'archive', index: fakeArchive(['notes.txt', 'data.bin']) }, noopIo),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /Unrecognized modpack format/);
      assert.match(message, /notes\.txt|data\.bin|checked \d+ entries/, 'must report what it actually saw');
      return true;
    },
  );
});

// ---- drift guard: the app list and the conformance waivers must agree ----

test('the deferred list and scripts/conformance-waivers.json agree on every format', () => {
  const waiversPath = path.join(process.cwd(), 'scripts', 'conformance-waivers.json');
  assert.ok(fs.existsSync(waiversPath), 'conformance-waivers.json must exist; it is the recorded deferrals');
  const parsed = JSON.parse(fs.readFileSync(waiversPath, 'utf8')) as {
    waivers?: { format?: string; reason?: string }[];
  };
  const waived = (parsed.waivers ?? []).map(entry => ({ format: (entry.format ?? '').trim(), reason: (entry.reason ?? '').trim() }));
  assert.ok(waived.length > 0, 'expected recorded waivers');

  // Every deferred format the app can recognise must have a recorded waiver (otherwise we explain a deferral
  // that the conformance report does not know about).
  const appNames = DEFERRED_FORMATS.map(format => format.name.toLowerCase());
  for (const format of DEFERRED_FORMATS) {
    const match = waived.find(entry => entry.format.toLowerCase() === format.name.toLowerCase());
    assert.ok(match, `"${format.name}" is deferred in the app but absent from conformance-waivers.json`);
    assert.ok(format.reason.trim().length > 0, `"${format.name}" must state a reason`);
  }
  // And every waiver whose format the app claims to recognise must carry a reason in both places.
  for (const entry of waived) {
    if (!appNames.includes(entry.format.toLowerCase())) continue;
    assert.ok(entry.reason.length > 0, `waiver for "${entry.format}" must state a reason`);
  }
});
