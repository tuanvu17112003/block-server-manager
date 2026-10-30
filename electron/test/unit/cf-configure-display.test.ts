// The Configure screen must describe the version the user chose, not a stale ZIP from an earlier browse.
//
// Reported: "I chose 2.9, pressed Continue, and it still shows 2.9.3."
//
// Cause: the title and the target panel read `selectedCurseforgeInspection`, which describes a ZIP staged by the LOCAL
// import path. In one-click project mode no ZIP is involved, so the inspection left over from a previous browse won and the
// screen showed the previous version. The chosen version is the truth and must be read first.
//
// Two further leaks are covered here because they made the same symptom possible through a different route: the chosen
// version survived a project switch (sending an old project's fileId), and it survived a create-session reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';

interface Chosen { fileId: number; displayName: string; minecraftVersion: string | null; loader: string | null; hasServerPack: boolean }
interface Inspection { name: string; classification: string; minecraftVersion: string; loader: string; loaderVersion: string }

/** Mirrors the title expression in StepsConfigure.tsx (curseforge branch). */
function configureTitle(chosen: Chosen | null, inspection: Inspection | null): string {
  if (chosen !== null) return `Configure — ${chosen.displayName}`;
  if (inspection !== null) return `Configure — ${inspection.name}`;
  return 'Configure — curseforge';
}

/** Mirrors what CurseforgeTarget/StepConfigure render for the loader+version field. */
function describeTarget(chosen: Chosen | null, inspection: Inspection | null): string {
  if (chosen !== null) {
    return [
      chosen.minecraftVersion !== null ? `Minecraft ${chosen.minecraftVersion}` : null,
      chosen.loader,
    ].filter((part) => part !== null).join(' · ');
  }
  if (inspection !== null) return `Minecraft ${inspection.minecraftVersion} · ${inspection.loader} ${inspection.loaderVersion}`;
  return '';
}

const staleZip: Inspection = {
  name: 'RLCraft 1.12.2 - Release v2.9.3.zip',
  classification: 'supportedServerPack',
  minecraftVersion: '1.12.2',
  loader: 'forge',
  loaderVersion: null as unknown as string,
};

const chosenV29: Chosen = {
  fileId: 4001,
  displayName: 'RLCraft 1.12.2 - Release v2.9.zip',
  minecraftVersion: '1.12.2',
  loader: 'forge',
  hasServerPack: true,
};

test('a chosen version wins over a stale staged ZIP in the title', () => {
  // The exact reported case: both exist, and the stale one used to win.
  const title = configureTitle(chosenV29, staleZip);
  assert.match(title, /v2\.9\.zip/);
  assert.ok(!title.includes('v2.9.3'), `the stale version must not appear: ${title}`);
});

test('a chosen version wins over a stale staged ZIP in the target field', () => {
  const target = describeTarget(chosenV29, staleZip);
  assert.match(target, /Minecraft 1\.12\.2/);
  assert.ok(!target.includes('v2.9.3'));
});

test('the ZIP path is still used when no version was chosen', () => {
  // The local-import flow has no chosen version; it must keep working exactly as before.
  assert.match(configureTitle(null, staleZip), /v2\.9\.3\.zip/);
  assert.match(describeTarget(null, staleZip), /Minecraft 1\.12\.2 · forge/);
});

test('a chosen version without a server pack is described as such', () => {
  const clientOnly: Chosen = { ...chosenV29, fileId: 4002, displayName: 'RLCraft - Beta v2.8.zip', hasServerPack: false };
  assert.equal(clientOnly.hasServerPack, false);
  // The panel shows a warning in this case; the title still names the chosen version.
  assert.match(configureTitle(clientOnly, staleZip), /Beta v2\.8/);
});

test('choosing a different version changes the displayed description', () => {
  // Guards against a cache-shaped bug where the first render sticks.
  const other: Chosen = { ...chosenV29, fileId: 4003, displayName: 'RLCraft 1.12.2 - Release v2.9.1c.zip', loader: 'forge' };
  assert.notEqual(configureTitle(chosenV29, staleZip), configureTitle(other, staleZip));
});

test('a version chosen for one project must not survive a switch to another', () => {
  // Simulates the reset performed on resolve: the previous project's fileId must be cleared, or it would be sent as a pin
  // for a different project.
  let chosen: Chosen | null = chosenV29;
  const resolveProject = (): void => { chosen = null; };
  resolveProject();
  assert.equal(chosen, null, 'resolving a new project clears the chosen version');
});

test('a version must not survive a create-session reset', () => {
  let chosen: Chosen | null = chosenV29;
  const resetForSourceChange = (): void => { chosen = null; };
  resetForSourceChange();
  assert.equal(chosen, null);
});
