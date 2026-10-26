// Service suite for world lifecycle (WP-5.3): NBT seed/corruption, delete safety archive,
// export→import round-trip (root / single-folder / server-style layouts), duplicate dimensions
// with job progress, and the pending-world clear/no-ghost lifecycle.
// Runs inside Electron via --servicestest against throwaway data roots (no network/dialogs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { TestRun, tempRoot, type TempRoot } from '../harness';
import { withHarness, type Harness } from '../service-harness';
import { Worlds } from '../../services/worlds';
import { collectInputs, writeZip } from '../../services/zip';
import { extractZip } from '../../services/installer/core';
import type { Backups } from '../../services/backups';
import type { ServerProcesses } from '../../services/server-process';

// ---------- minimal NBT fixture (gzip level.dat) ----------
function nbtNamed(type: number, name: string, payload: Buffer): Buffer {
  const nameBody = Buffer.from(name, 'utf8');
  const nameLength = Buffer.alloc(2);
  nameLength.writeUInt16BE(nameBody.length);
  return Buffer.concat([Buffer.from([type]), nameLength, nameBody, payload]);
}
function nbtString(value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(body.length);
  return Buffer.concat([length, body]);
}
function nbtLong(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(value);
  return buffer;
}
function levelDatFile(seed = 8675309n, levelName = 'world'): Buffer {
  const end = Buffer.from([0]);
  const data = Buffer.concat([
    nbtNamed(8, 'LevelName', nbtString(levelName)),
    nbtNamed(4, 'RandomSeed', nbtLong(seed)),
    nbtNamed(10, 'Version', Buffer.concat([nbtNamed(8, 'Name', nbtString('19133')), end])),
    end,
  ]);
  return gzipSync(Buffer.concat([Buffer.from([10]), nbtString(''), nbtNamed(10, 'Data', data), end]));
}
function writeWorldLevelDat(serverDir: string, worldName: string, seed = 8675309n): void {
  fs.mkdirSync(path.join(serverDir, worldName), { recursive: true });
  fs.writeFileSync(path.join(serverDir, worldName, 'level.dat'), levelDatFile(seed, worldName));
}
function writeFileWithDirs(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function relativeFiles(root: string, skipNames = new Set<string>()): string[] {
  const out: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (skipNames.has(rel)) continue;
      if (entry.isDirectory()) visit(path.join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  visit(root, '');
  return out.sort();
}
function assertCode(promise: Promise<unknown>, code: string, pattern?: RegExp): Promise<void> {
  return assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    if (pattern) assert.match((error as Error).message, pattern);
    return true;
  });
}

/** Direct service instance for dialog-free entry points (exportTo/importFrom). */
function directWorlds(h: Harness): Worlds {
  const processes = { status: () => 'stopped' } as unknown as ServerProcesses;
  const backups = {} as unknown as Backups;
  return new Worlds(h.ctx, processes, backups);
}

let fixtureSeq = 0;
async function makeFixtureZip(fixtures: TempRoot, files: Record<string, string | Buffer>): Promise<string> {
  fixtureSeq += 1;
  const source = path.join(fixtures.root, `zip-src-${fixtureSeq}`);
  for (const [name, content] of Object.entries(files)) writeFileWithDirs(path.join(source, name), content);
  const zipPath = path.join(fixtures.root, `fixture-${fixtureSeq}.zip`);
  const inputs = await collectInputs(source, ['.']);
  await writeZip(zipPath, inputs);
  return zipPath;
}

function jobEvents(h: Harness, jobId: string): unknown[] {
  return h.events.filter((event) => event.channel === `job://progress/${jobId}`).map((event) => event.payload);
}

export async function runWorldsSuite(run: TestRun): Promise<void> {
  const fixtures = tempRoot('msm-worlds-suite');
  try {
    await withHarness(run, async (h) => {
      // ---- level.dat seed + corrupt detection ----
      await run.must('worlds_list: seed from level.dat and corrupt-level warning (additive DTO fields)', async () => {
        const server = await h.createServer({ name: 'Worlds NBT', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 2048 } as never);
        const dir = h.scaffoldServer(server.id);
        // scaffold writes plain-text level.dat → corrupt by NBT rules.
        const corruptRows = await h.invoke<{ name: string; seed?: string | null; warning?: string | null }[]>('worlds_list', { id: server.id });
        const corrupt = corruptRows.find((row) => row.name === 'world')!;
        assert.equal(corrupt.seed ?? null, null);
        assert.match(corrupt.warning ?? '', /corrupt|unreadable/);

        fs.writeFileSync(path.join(dir, 'world', 'level.dat'), levelDatFile(8675309n, 'world'));
        const rows = await h.invoke<{ name: string; seed?: string | null; warning?: string | null }[]>('worlds_list', { id: server.id });
        const good = rows.find((row) => row.name === 'world')!;
        assert.equal(good.seed, '8675309');
        assert.equal(good.warning ?? null, null);
      });

      // ---- duplicate copies dimensions, reports size, emits progress ----
      await run.must('world_duplicate: copies nether/end, returns size, emits job progress', async () => {
        const server = await h.createServer({ name: 'Worlds Dup', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 2048 } as never);
        const dir = h.scaffoldServer(server.id);
        writeWorldLevelDat(dir, 'world');
        writeFileWithDirs(path.join(dir, 'world_nether', 'region', 'r.0.0.mca'), 'nether-data');
        writeFileWithDirs(path.join(dir, 'world_the_end', 'region', 'r.0.0.mca'), 'end-data');
        const result = await h.invoke<{ name: string; sizeBytes: number; active: boolean }>(
          'world_duplicate', { id: server.id, name: 'world', jobId: 'job-dup-1' },
        );
        assert.equal(result.name, 'world-copy');
        assert.equal(result.active, false);
        assert.ok(fs.existsSync(path.join(dir, 'world-copy', 'level.dat')));
        assert.equal(fs.readFileSync(path.join(dir, 'world-copy_nether', 'region', 'r.0.0.mca'), 'utf8'), 'nether-data');
        assert.equal(fs.readFileSync(path.join(dir, 'world-copy_the_end', 'region', 'r.0.0.mca'), 'utf8'), 'end-data');
        assert.ok(result.sizeBytes > 0);
        const events = jobEvents(h, 'job-dup-1') as { progress: number; stage?: string }[];
        assert.ok(events.length >= 2, 'expected multiple progress events');
        assert.equal(events[events.length - 1]!.progress, 100);
        assert.ok(events.some((event) => /copying/.test(event.stage ?? '')));
        // Dimension-less duplicate keeps working and gets a unique second name.
        const second = await h.invoke<{ name: string }>('world_duplicate', { id: server.id, name: 'world' });
        assert.equal(second.name, 'world-copy-2');
      });

      // ---- delete safety backup uses the deleted world, not the active one ----
      await run.must('world_delete: safety backup archives the deleted world + dimensions, never the active world', async () => {
        const server = await h.createServer({ name: 'Worlds Delete', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 2048 } as never);
        const dir = h.scaffoldServer(server.id);
        writeWorldLevelDat(dir, 'world', 111n);
        writeFileWithDirs(path.join(dir, 'world', 'active-only.txt'), 'active-world-marker');
        writeWorldLevelDat(dir, 'old', 222n);
        writeFileWithDirs(path.join(dir, 'old', 'old-marker.txt'), 'deleted-world-marker');
        writeWorldLevelDat(dir, 'old_nether', 222n);
        writeFileWithDirs(path.join(dir, 'old_nether', 'nether-marker.txt'), 'deleted-nethers-marker');

        await assertCode(h.invoke('world_delete', { id: server.id, name: 'world' }), 'conflict', /active world/);
        await h.invoke('world_delete', { id: server.id, name: 'old' });
        assert.equal(fs.existsSync(path.join(dir, 'old')), false);
        assert.equal(fs.existsSync(path.join(dir, 'old_nether')), false);
        assert.ok(fs.existsSync(path.join(dir, 'world', 'active-only.txt')), 'active world must survive');

        const backups = await h.invoke<{ id: string; kind: string; path: string; name: string }[]>('backups_list', { id: server.id });
        const safety = backups.filter((row) => row.kind === 'World-delete');
        assert.equal(safety.length, 1);
        assert.ok(fs.existsSync(safety[0]!.path));
        assert.match(path.basename(safety[0]!.path), /world-delete\.zip$/);

        const extracted = path.join(fixtures.root, 'safety-extracted');
        await extractZip(safety[0]!.path, extracted, { skipExisting: false });
        const files = relativeFiles(extracted);
        assert.ok(files.includes('old/level.dat'));
        assert.ok(files.includes('old/old-marker.txt'));
        assert.ok(files.includes('old_nether/nether-marker.txt'));
        assert.ok(!files.some((file) => file.startsWith('world/')), `active world leaked into safety archive: ${files.join(', ')}`);
      });

      // ---- export → import round-trip and external layouts ----
      await run.must('world_export/world_import: one-unit round-trip with dimensions + root/folder layouts', async () => {
        const server = await h.createServer({ name: 'Worlds RT', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 2048 } as never);
        const dir = h.scaffoldServer(server.id);
        writeWorldLevelDat(dir, 'world', 333n);
        writeFileWithDirs(path.join(dir, 'world_nether', 'level.dat'), levelDatFile(333n, 'world_nether'));
        writeFileWithDirs(path.join(dir, 'world_the_end', 'region', 'r.0.0.mca'), 'end-region');
        const worlds = directWorlds(h);

        const exportPath = path.join(fixtures.root, 'roundtrip.zip');
        await worlds.exportTo(server.id, 'world', exportPath, 'job-export-1');
        assert.ok(fs.existsSync(exportPath));
        const exportEvents = jobEvents(h, 'job-export-1') as { progress: number }[];
        assert.equal(exportEvents[exportEvents.length - 1]!.progress, 100);

        const exported = path.join(fixtures.root, 'roundtrip-extracted');
        await extractZip(exportPath, exported, { skipExisting: false });
        const exportFiles = relativeFiles(exported);
        assert.ok(exportFiles.includes('world/level.dat'));
        assert.ok(exportFiles.includes('world_nether/level.dat'));
        assert.ok(exportFiles.includes('world_the_end/region/r.0.0.mca'));

        const imported = await worlds.importFrom(server.id, exportPath, 'job-import-1');
        assert.equal(imported.name, 'world-2');
        assert.ok(fs.existsSync(path.join(dir, 'world-2', 'level.dat')));
        assert.ok(fs.existsSync(path.join(dir, 'world-2_nether', 'level.dat')));
        assert.equal(fs.readFileSync(path.join(dir, 'world-2_the_end', 'region', 'r.0.0.mca'), 'utf8'), 'end-region');
        const importEvents = jobEvents(h, 'job-import-1') as { progress: number }[];
        assert.equal(importEvents[importEvents.length - 1]!.progress, 100);

        // Root-level level.dat archive (single-player world) → base name from the zip stem.
        const rootZip = await makeFixtureZip(fixtures, { 'level.dat': levelDatFile(444n), 'region/r.0.0.mca': 'root-region' });
        const rootResult = await worlds.importFrom(server.id, rootZip);
        assert.equal(rootResult.name, 'fixture-1');
        assert.ok(fs.existsSync(path.join(dir, 'fixture-1', 'level.dat')));
        assert.equal(fs.readFileSync(path.join(dir, 'fixture-1', 'region', 'r.0.0.mca'), 'utf8'), 'root-region');

        // Single-folder single-player archive → folder name.
        const folderZip = await makeFixtureZip(fixtures, { 'spworld/level.dat': levelDatFile(555n), 'spworld/region/r.0.0.mca': 'sp' });
        const folderResult = await worlds.importFrom(server.id, folderZip);
        assert.equal(folderResult.name, 'spworld');

        // Server-style archive whose dimension folders also carry level.dat.
        const serverZip = await makeFixtureZip(fixtures, {
          'netherunit/level.dat': levelDatFile(666n),
          'netherunit_nether/level.dat': levelDatFile(666n),
          'netherunit_the_end/region/r.0.0.mca': 'end',
        });
        const serverResult = await worlds.importFrom(server.id, serverZip);
        assert.equal(serverResult.name, 'netherunit');
      });

      await run.must('world_import: rejects mixed/multi/dimension-only/world-less/slip archives with validation', async () => {
        const server = await h.createServer({ name: 'Worlds Import Reject', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 2048 } as never);
        const dir = h.scaffoldServer(server.id);
        writeWorldLevelDat(dir, 'world', 777n);
        const before = fs.readdirSync(dir).sort();
        const worlds = directWorlds(h);

        const mixed = await makeFixtureZip(fixtures, { 'level.dat': levelDatFile(), 'nested/level.dat': levelDatFile() });
        await assertCode(worlds.importFrom(server.id, mixed), 'validation', /level\.dat at its root/);

        const multi = await makeFixtureZip(fixtures, { 'w1/level.dat': levelDatFile(), 'w2/level.dat': levelDatFile() });
        await assertCode(worlds.importFrom(server.id, multi), 'validation', /multiple world folders/);

        const dimensionOnly = await makeFixtureZip(fixtures, { 'orphan_nether/level.dat': levelDatFile() });
        await assertCode(worlds.importFrom(server.id, dimensionOnly), 'validation', /only contains dimension folder/);

        const worldLess = await makeFixtureZip(fixtures, { 'readme.txt': 'no world here' });
        await assertCode(worlds.importFrom(server.id, worldLess), 'validation', /does not contain a world/);

        // Zip-slip entry: extraction must fail closed before any world folder is created.
        const source = path.join(fixtures.root, 'slip-src');
        writeFileWithDirs(path.join(source, 'escape.txt'), 'escape');
        const slipInputs = await collectInputs(source, ['escape.txt']);
        const slipZip = path.join(fixtures.root, 'slip.zip');
        await writeZip(slipZip, [{ name: '../escape.txt', path: slipInputs[0]!.path }]);
        await assert.rejects(() => worlds.importFrom(server.id, slipZip));
        assert.deepEqual(fs.readdirSync(dir).sort(), before, 'rejected imports must not create folders');
      });

      // ---- pending lifecycle ----
      await run.must('pending world: ghost cannot be deleted/activated, clears when the folder appears', async () => {
        const server = await h.createServer({ name: 'Worlds Pending', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 2048 } as never);
        const dir = h.scaffoldServer(server.id);
        writeWorldLevelDat(dir, 'world', 888n);

        const created = await h.invoke<{ pending?: boolean; active: boolean }>(
          'world_create', { id: server.id, name: 'newworld', seed: '42', levelType: 'minecraft:flat' },
        );
        assert.equal(created.pending, true);
        let rows: { name: string; pending?: boolean; seed?: string | null }[] =
          await h.invoke<{ name: string; pending?: boolean }[]>('worlds_list', { id: server.id });
        assert.equal(rows.find((row) => row.name === 'newworld')?.pending, true);
        await assertCode(h.invoke('world_delete', { id: server.id, name: 'newworld' }), 'conflict', /not been generated/);
        await assertCode(h.invoke('world_activate', { id: server.id, name: 'newworld' }), 'conflict', /next time the server starts/);

        // Activating an existing world clears the stale pending marker.
        await h.invoke('world_activate', { id: server.id, name: 'world' });
        assert.equal(h.store().pendingWorld(server.id), null);

        // A freshly scheduled pending world is cleared by list() once its folder exists.
        await h.invoke('world_create', { id: server.id, name: 'newgen', seed: '7', levelType: 'minecraft:normal' });
        writeWorldLevelDat(dir, 'newgen', 999n);
        rows = await h.invoke<{ name: string; pending?: boolean; seed?: string | null }[]>('worlds_list', { id: server.id });
        const generated = rows.find((row) => row.name === 'newgen')!;
        assert.equal(generated.pending ?? false, false);
        assert.equal(generated.seed, '999');
        assert.equal(h.store().pendingWorld(server.id), null);
        rows = await h.invoke<{ name: string; pending?: boolean }[]>('worlds_list', { id: server.id });
        assert.equal(rows.some((row) => row.pending === true), false, 'no ghost after the pending world was generated');
      });
    });
  } finally {
    fixtures.cleanup();
  }
}
