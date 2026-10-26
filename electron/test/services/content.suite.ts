// Content service suite (Phase 5 WP-5.1: M-01/M-07/F-13).
// Runs inside Electron via `--servicestest` with a throwaway data root and a stubbed global fetch:
// no network, no real server process. Covers atomic replace-by-project updates (success, hash
// failure, cancellation), idle toggle/remove, plugin dependency resolution + disabled de-dupe, and
// the plugin-aware version listing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TestRun, sleep, waitUntil, writeJson, readJson } from '../harness';
import { withHarness, type Harness } from '../service-harness';
import { Content } from '../../services/content';
import { Jobs } from '../../services/jobs';
import type { Backups } from '../../services/backups';
import type { ServerProcesses } from '../../services/server-process';
import type { ServerDto } from '../../services/store';

const API = 'https://api.modrinth.com/v2';

// ---- fixtures / stubs ----

const sha1 = (body: Buffer): string => createHash('sha1').update(body).digest('hex');
const sha512 = (body: Buffer): string => createHash('sha512').update(body).digest('hex');
const jarBody = (label: string): Buffer => Buffer.from(`fake-jar-body:${label}`);

interface StubDependency { projectId: string; versionId?: string | null; type?: string }

function versionPayload(opts: {
  id: string;
  fileName: string;
  body: Buffer;
  loaders?: string[];
  gameVersions?: string[];
  versionNumber?: string;
  name?: string;
  dependencies?: StubDependency[];
}): Record<string, unknown> {
  return {
    id: opts.id,
    name: opts.name ?? opts.fileName,
    version_number: opts.versionNumber ?? opts.id,
    game_versions: opts.gameVersions ?? ['1.21.1'],
    loaders: opts.loaders ?? ['fabric'],
    downloads: 1,
    files: [{
      url: `https://cdn.modrinth.com/data/suite/versions/${opts.id}/files/${opts.fileName}`,
      filename: opts.fileName,
      primary: true,
      size: opts.body.length,
      hashes: { sha1: sha1(opts.body), sha512: sha512(opts.body) },
    }],
    dependencies: (opts.dependencies ?? []).map((dep) => ({
      project_id: dep.projectId,
      version_id: dep.versionId ?? null,
      dependency_type: dep.type ?? 'required',
    })),
  };
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const fileResponse = (body: Buffer): Response => new Response(new Uint8Array(body), { status: 200 });

/** Install a stub fetch; returns captured request URLs + a restore function. */
function stubFetch(handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>): {
  urls: string[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    urls.push(url.toString());
    return handler(url, init);
  }) as typeof fetch;
  return { urls, restore: () => { globalThis.fetch = original; } };
}

async function seedServer(h: Harness, name: string, loader: 'Fabric' | 'Paper', mcVersion = '1.21.1'): Promise<ServerDto> {
  const dto = await h.createServer({ name, loader, mcVersion, ramMb: 1024 } as never);
  const dir = h.scaffoldServer(dto.id);
  // scaffoldServer seeds an unmanaged example jar; content tests manage their own files.
  fs.rmSync(path.join(dir, 'mods', 'example.jar'), { force: true });
  return dto;
}

function contentDirs(h: Harness, dto: ServerDto): { active: string; disabled: string } {
  const base = path.join(h.dataRoot, 'servers', dto.id);
  return dto.loader === 'Paper'
    ? { active: path.join(base, 'plugins'), disabled: path.join(base, 'plugins-disabled') }
    : { active: path.join(base, 'mods'), disabled: path.join(base, 'mods-disabled') };
}

function metaOf(h: Harness, dto: ServerDto): Record<string, { projectId?: string; versionId?: string; title?: string }> {
  return h.store().getSetting<Record<string, { projectId?: string; versionId?: string; title?: string }>>(`content:${dto.id}`) ?? {};
}

function setMeta(h: Harness, dto: ServerDto, meta: Record<string, { projectId?: string; versionId?: string; title?: string }>): void {
  h.store().setSetting(`content:${dto.id}`, meta);
}

function writeJar(dir: string, fileName: string, body: Buffer): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, body);
  return file;
}

function listing(dir: string): string[] {
  try { return fs.readdirSync(dir).sort(); } catch { return []; }
}

/** Direct Content instance with controllable process status + captured job events. */
function makeContent(h: Harness, status: () => string = () => 'stopped'): {
  content: Content;
  jobs: Jobs;
  events: { channel: string; payload: unknown }[];
} {
  const events: { channel: string; payload: unknown }[] = [];
  const jobs = new Jobs((channel, payload) => events.push({ channel, payload }));
  const processes = { status } as unknown as ServerProcesses;
  const backups = {
    create: async () => ({ id: 'stub-backup', serverId: 'x', kind: 'Pre-install', note: '', createdAt: new Date().toISOString(), bytes: 0 }),
  } as unknown as Backups;
  return { content: new Content(h.ctx, processes, jobs, backups), jobs, events };
}

export async function runContentSuite(run: TestRun): Promise<void> {
  await withHarness(run, async (h) => {
    await run.must('list/toggle/remove round-trip + toggle requires an idle server', async () => {
      const dto = await seedServer(h, 'Content Basics', 'Fabric');
      const { active, disabled } = contentDirs(h, dto);
      writeJar(active, 'manual.jar', jarBody('manual'));
      const listed = await h.invoke<{ fileName: string; enabled: boolean }[]>('content_list', { id: dto.id });
      assert.deepEqual(listed.map((item) => `${item.fileName}:${item.enabled}`), ['manual.jar:true']);

      await h.invoke('content_toggle', { id: dto.id, fileName: 'manual.jar', enabled: false });
      assert.ok(fs.existsSync(path.join(disabled, 'manual.jar')));
      const disabledList = await h.invoke<{ fileName: string; enabled: boolean }[]>('content_list', { id: dto.id });
      assert.equal(disabledList.find((item) => item.fileName === 'manual.jar')?.enabled, false);

      // WP-5.1: a running/starting/stopping server must reject toggle and remove with conflict.
      for (const status of ['running', 'starting', 'stopping']) {
        const running = makeContent(h, () => status);
        assert.throws(() => running.content.toggle(dto.id, 'manual.jar', true), (error: unknown) => (error as { code?: string }).code === 'conflict');
        assert.throws(() => running.content.remove(dto.id, 'manual.jar'), (error: unknown) => (error as { code?: string }).code === 'conflict');
      }
      const toggled = await h.invoke<{ fileName: string; enabled: boolean }[]>('content_toggle', { id: dto.id, fileName: 'manual.jar', enabled: true });
      assert.equal(toggled.find((item) => item.fileName === 'manual.jar')?.enabled, true);
      await h.invoke('content_remove', { id: dto.id, fileName: 'manual.jar' });
      assert.deepEqual(listing(active).filter((name) => name.endsWith('.jar')), []);
      assert.deepEqual(listing(disabled).filter((name) => name.endsWith('.jar')), []);
    });

    await run.must('update replaces the old version atomically and writes metadata only after publish', async () => {
      const dto = await seedServer(h, 'Content Update', 'Fabric');
      const { active } = contentDirs(h, dto);
      writeJar(active, 'projA-1.0.jar', jarBody('v1'));
      setMeta(h, dto, { 'projA-1.0.jar': { projectId: 'projA', versionId: 'oldv', title: 'Project A' } });

      const newBody = jarBody('v2');
      const payload = versionPayload({ id: 'newv', fileName: 'projA-2.0.jar', body: newBody, versionNumber: '2.0.0' });
      const stub = stubFetch((url) => {
        if (url.pathname === `/v2/version/newv`) return json(payload);
        if (url.pathname === '/v2/project/projA') return json({ id: 'projA', project_type: 'mod', server_side: 'required', title: 'Project A' });
        if (url.hostname === 'cdn.modrinth.com') return fileResponse(newBody);
        return json({}, 404);
      });
      try {
        const result = await h.invoke<{ installed: number; files: string[]; warnings: string[]; skipped: number }>('content_install', {
          id: dto.id, projectId: 'projA', versionId: 'newv', title: 'Project A', jobId: 'job-content-update',
        });
        assert.equal(result.installed, 1);
        assert.deepEqual(result.files, ['projA-2.0.jar']);
        assert.deepEqual(listing(active).filter((name) => name.endsWith('.jar')), ['projA-2.0.jar']);
        assert.equal(fs.readFileSync(path.join(active, 'projA-2.0.jar')).toString(), newBody.toString());
        assert.ok(!fs.existsSync(path.join(active, '.content-trash')), 'trash directory must be cleaned after success');
        assert.ok(!listing(active).some((name) => name.startsWith('.content-stage')), 'staging files left behind');
        const meta = metaOf(h, dto);
        assert.equal(meta['projA-1.0.jar'], undefined);
        assert.equal(meta['projA-2.0.jar']?.projectId, 'projA');
        assert.equal(meta['projA-2.0.jar']?.versionId, 'newv');
        assert.ok(h.events.some((event) => event.channel === 'job://progress/job-content-update' && (event.payload as { progress: number }).progress === 100));
      } finally {
        stub.restore();
      }
    });

    await run.must('update with the identical file name overwrites in place (one live version)', async () => {
      const dto = await seedServer(h, 'Content Same Name', 'Fabric');
      const { active } = contentDirs(h, dto);
      writeJar(active, 'projB.jar', jarBody('old'));
      setMeta(h, dto, { 'projB.jar': { projectId: 'projB', versionId: 'old', title: 'B' } });

      const newBody = jarBody('new-bytes');
      const stub = stubFetch((url) => {
        if (url.pathname === '/v2/version/b2') return json(versionPayload({ id: 'b2', fileName: 'projB.jar', body: newBody, versionNumber: '2.0.0' }));
        if (url.pathname === '/v2/project/projB') return json({ id: 'projB', project_type: 'mod', server_side: 'required' });
        if (url.hostname === 'cdn.modrinth.com') return fileResponse(newBody);
        return json({}, 404);
      });
      try {
        const result = await h.invoke<{ installed: number; files: string[] }>('content_install', {
          id: dto.id, projectId: 'projB', versionId: 'b2', title: 'B', jobId: '',
        });
        assert.equal(result.installed, 1);
        assert.deepEqual(result.files, ['projB.jar']);
        assert.deepEqual(listing(active).filter((name) => name.endsWith('.jar')), ['projB.jar']);
        assert.equal(fs.readFileSync(path.join(active, 'projB.jar')).toString(), newBody.toString());
        assert.equal(metaOf(h, dto)['projB.jar']?.versionId, 'b2');
      } finally {
        stub.restore();
      }
    });

    await run.must('failed update keeps the old version and writes no metadata', async () => {
      const dto = await seedServer(h, 'Content Fail', 'Fabric');
      const { active } = contentDirs(h, dto);
      const oldBody = jarBody('old-version');
      writeJar(active, 'projC-1.0.jar', oldBody);
      setMeta(h, dto, { 'projC-1.0.jar': { projectId: 'projC', versionId: 'old', title: 'C' } });

      const newBody = jarBody('new-version');
      const payload = versionPayload({ id: 'c2', fileName: 'projC-2.0.jar', body: newBody });
      // Corrupt the declared hash so the download verification fails after the metadata fetch.
      (payload.files as { hashes: { sha1: string; sha512: string } }[])[0].hashes.sha1 = '0'.repeat(40);
      const stub = stubFetch((url) => {
        if (url.pathname === '/v2/version/c2') return json(payload);
        if (url.pathname === '/v2/project/projC') return json({ id: 'projC', project_type: 'mod', server_side: 'required' });
        if (url.hostname === 'cdn.modrinth.com') return fileResponse(newBody);
        return json({}, 404);
      });
      try {
        await assert.rejects(
          () => h.invoke('content_install', { id: dto.id, projectId: 'projC', versionId: 'c2', title: 'C', jobId: 'job-content-fail' }),
          /sha1 mismatch/,
        );
        assert.deepEqual(listing(active).filter((name) => name.endsWith('.jar')), ['projC-1.0.jar']);
        assert.equal(fs.readFileSync(path.join(active, 'projC-1.0.jar')).toString(), oldBody.toString());
        assert.deepEqual(listing(active).filter((name) => name.includes('.content-stage') || name.endsWith('.part')), []);
        assert.equal(metaOf(h, dto)['projC-1.0.jar']?.versionId, 'old');
        assert.equal(metaOf(h, dto)['projC-2.0.jar'], undefined);
      } finally {
        stub.restore();
      }
    });

    await run.must('cancel mid-download leaves the old tree and metadata unchanged', async () => {
      const dto = await seedServer(h, 'Content Cancel', 'Fabric');
      const { active } = contentDirs(h, dto);
      const oldBody = jarBody('kept');
      writeJar(active, 'projD-1.0.jar', oldBody);
      setMeta(h, dto, { 'projD-1.0.jar': { projectId: 'projD', versionId: 'old', title: 'D' } });

      const newBody = jarBody('never-published');
      const payload = versionPayload({ id: 'd2', fileName: 'projD-2.0.jar', body: newBody });
      const stub = stubFetch((url, init) => {
        if (url.pathname === '/v2/version/d2') return json(payload);
        if (url.pathname === '/v2/project/projD') return json({ id: 'projD', project_type: 'mod', server_side: 'required' });
        if (url.hostname === 'cdn.modrinth.com') {
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              init?.signal?.addEventListener('abort', () => {
                try { controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); } catch { /* already closed */ }
              }, { once: true });
            },
          }), { status: 200 });
        }
        return json({}, 404);
      });
      const { content, jobs } = makeContent(h);
      try {
        const pending = content.install(dto.id, 'projD', 'd2', 'job-content-cancel', 'D');
        await waitUntil(() => Boolean(jobs.signalFor('job-content-cancel')), { label: 'job registration', timeoutMs: 3000 });
        await sleep(30);
        assert.equal(jobs.cancel('job-content-cancel'), true);
        await assert.rejects(pending, (error: unknown) => (error as { code?: string }).code === 'cancelled');
        assert.deepEqual(listing(active).filter((name) => name.endsWith('.jar')), ['projD-1.0.jar']);
        assert.equal(fs.readFileSync(path.join(active, 'projD-1.0.jar')).toString(), oldBody.toString());
        assert.deepEqual(listing(active).filter((name) => name.includes('.content-stage') || name.endsWith('.part')), []);
        assert.equal(metaOf(h, dto)['projD-2.0.jar'], undefined);
      } finally {
        stub.restore();
      }
    });

    await run.must('Paper plugin dependencies resolve project_type:plugin via the plugin loader union', async () => {
      const dto = await seedServer(h, 'Content Plugins', 'Paper');
      const { active } = contentDirs(h, dto);
      const pluginBody = jarBody('main-plugin');
      const depBody = jarBody('dependency-plugin');
      const primary = versionPayload({
        id: 'pv1', fileName: 'SuitePlugin-1.0.jar', body: pluginBody, loaders: ['paper'],
        dependencies: [{ projectId: 'depPlugin', versionId: null, type: 'required' }],
      });
      const depVersion = versionPayload({ id: 'depv1', fileName: 'DepPlugin-1.0.jar', body: depBody, loaders: ['spigot'] });
      const stub = stubFetch((url) => {
        if (url.pathname === '/v2/version/pv1') return json(primary);
        if (url.pathname === '/v2/project/SuitePlugin') return json({ id: 'SuitePlugin', project_type: 'plugin', server_side: 'required' });
        if (url.pathname === '/v2/project/depPlugin') return json({ id: 'depPlugin', project_type: 'plugin', server_side: 'required', title: 'Dep Plugin' });
        if (url.pathname === '/v2/project/depPlugin/version') return json([depVersion]);
        if (url.hostname === 'cdn.modrinth.com') return fileResponse(url.pathname.includes('DepPlugin') ? depBody : pluginBody);
        return json({}, 404);
      });
      try {
        const result = await h.invoke<{ installed: number; files: string[]; warnings: string[]; skipped: number }>('content_install', {
          id: dto.id, projectId: 'SuitePlugin', versionId: 'pv1', title: 'Suite Plugin', jobId: '',
        });
        assert.equal(result.installed, 2);
        assert.deepEqual([...result.files].sort(), ['DepPlugin-1.0.jar', 'SuitePlugin-1.0.jar']);
        assert.deepEqual(listing(active).filter((name) => name.endsWith('.jar')), ['DepPlugin-1.0.jar', 'SuitePlugin-1.0.jar']);
        const meta = metaOf(h, dto);
        assert.equal(meta['SuitePlugin-1.0.jar']?.projectId, 'SuitePlugin');
        assert.equal(meta['DepPlugin-1.0.jar']?.projectId, 'depPlugin');
        assert.deepEqual(result.warnings, []);
        assert.equal(result.skipped, 0);
      } finally {
        stub.restore();
      }
    });

    await run.must('unresolved dependency id falls back to a project_type-scoped search (plugin deps)', async () => {
      const dto = await seedServer(h, 'Content Dep Search', 'Paper');
      const { active } = contentDirs(h, dto);
      const primaryBody = jarBody('search-main');
      const depBody = jarBody('search-dep');
      const primary = versionPayload({
        id: 'qs1', fileName: 'SearchPlugin-1.0.jar', body: primaryBody, loaders: ['paper'],
        dependencies: [{ projectId: 'depSlug', versionId: null, type: 'required' }],
      });
      const depVersion = versionPayload({ id: 'qdv1', fileName: 'FoundDep-1.0.jar', body: depBody, loaders: ['spigot'] });
      const stub = stubFetch((url) => {
        if (url.pathname === '/v2/version/qs1') return json(primary);
        if (url.pathname === '/v2/project/SearchPlugin') return json({ id: 'SearchPlugin', project_type: 'plugin', server_side: 'required' });
        if (url.pathname === '/v2/project/depSlug') return json({}, 404);
        if (url.pathname === '/v2/search') return json({ hits: [{ project_id: 'depFound' }], total_hits: 1 });
        if (url.pathname === '/v2/project/depFound') return json({ id: 'depFound', project_type: 'plugin', server_side: 'required', title: 'Found Dep' });
        if (url.pathname === '/v2/project/depFound/version') return json([depVersion]);
        if (url.hostname === 'cdn.modrinth.com') return fileResponse(url.pathname.includes('FoundDep') ? depBody : primaryBody);
        return json({}, 404);
      });
      try {
        const result = await h.invoke<{ installed: number; files: string[]; warnings: string[] }>('content_install', {
          id: dto.id, projectId: 'SearchPlugin', versionId: 'qs1', title: 'Search Plugin', jobId: '',
        });
        assert.equal(result.installed, 2);
        assert.deepEqual([...result.files].sort(), ['FoundDep-1.0.jar', 'SearchPlugin-1.0.jar']);
        assert.deepEqual(listing(active).filter((name) => name.endsWith('.jar')), ['FoundDep-1.0.jar', 'SearchPlugin-1.0.jar']);
        const searchCall = stub.urls.find((url) => url.includes('/v2/search')) ?? '';
        assert.ok(searchCall.includes('project_type%3Aplugin') || searchCall.includes('project_type:plugin'), searchCall);
        assert.deepEqual(result.warnings, []);
      } finally {
        stub.restore();
      }
    });

    await run.must('dependency already present in mods-disabled is not reinstalled', async () => {
      const dto = await seedServer(h, 'Content Dedupe', 'Fabric');
      const { active, disabled } = contentDirs(h, dto);
      writeJar(disabled, 'dep1.jar', jarBody('disabled-dep'));
      setMeta(h, dto, { 'dep1.jar': { projectId: 'dep1', title: 'Dep One' } });
      const primaryBody = jarBody('main-mod');
      const primary = versionPayload({
        id: 'dv1', fileName: 'MainMod-1.0.jar', body: primaryBody,
        dependencies: [{ projectId: 'dep1', versionId: null, type: 'required' }],
      });
      const stub = stubFetch((url) => {
        if (url.pathname === '/v2/version/dv1') return json(primary);
        if (url.pathname === '/v2/project/MainMod') return json({ id: 'MainMod', project_type: 'mod', server_side: 'required' });
        if (url.hostname === 'cdn.modrinth.com') return fileResponse(primaryBody);
        return json({}, 404);
      });
      try {
        const result = await h.invoke<{ installed: number; files: string[]; skipped: number }>('content_install', {
          id: dto.id, projectId: 'MainMod', versionId: 'dv1', title: 'Main Mod', jobId: '',
        });
        assert.equal(result.installed, 1);
        assert.deepEqual(result.files, ['MainMod-1.0.jar']);
        assert.equal(result.skipped, 1);
        assert.ok(!stub.urls.some((url) => url.includes('/project/dep1')), 'disabled dependency must not be re-fetched');
        assert.deepEqual(listing(active).filter((name) => name.endsWith('.jar')), ['MainMod-1.0.jar']);
        assert.ok(fs.existsSync(path.join(disabled, 'dep1.jar')), 'disabled copy must be preserved');
      } finally {
        stub.restore();
      }
    });

    await run.must('client-only projects and dependencies are rejected/skipped', async () => {
      const dto = await seedServer(h, 'Content Client Only', 'Fabric');
      const { active } = contentDirs(h, dto);
      const primaryBody = jarBody('server-mod');
      const primary = versionPayload({
        id: 'co1', fileName: 'ServerMod-1.0.jar', body: primaryBody,
        dependencies: [{ projectId: 'clientDep', versionId: null, type: 'required' }],
      });
      const stub = stubFetch((url) => {
        if (url.pathname === '/v2/version/co1') return json(primary);
        if (url.pathname === '/v2/project/ServerMod') return json({ id: 'ServerMod', project_type: 'mod', server_side: 'required' });
        if (url.pathname === '/v2/project/clientDep') return json({ id: 'clientDep', project_type: 'mod', server_side: 'unsupported', title: 'Client Mod' });
        if (url.hostname === 'cdn.modrinth.com') return fileResponse(primaryBody);
        return json({}, 404);
      });
      try {
        const result = await h.invoke<{ installed: number; warnings: string[]; skipped: number }>('content_install', {
          id: dto.id, projectId: 'ServerMod', versionId: 'co1', title: 'Server Mod', jobId: '',
        });
        assert.equal(result.installed, 1);
        assert.equal(result.skipped, 1);
        assert.ok(result.warnings.some((warning) => warning.includes('client-only')), String(result.warnings));

        // A client-only primary project is refused before anything is written.
        const clientVersion = versionPayload({ id: 'cl1', fileName: 'ClientOnly-1.0.jar', body: jarBody('client') });
        const stub2 = stubFetch((url) => {
          if (url.pathname === '/v2/version/cl1') return json(clientVersion);
          if (url.pathname === '/v2/project/ClientOnly') return json({ id: 'ClientOnly', project_type: 'mod', server_side: 'unsupported' });
          return json({}, 404);
        });
        try {
          await assert.rejects(
            () => h.invoke('content_install', { id: dto.id, projectId: 'ClientOnly', versionId: 'cl1', title: 'Client Only', jobId: '' }),
            (error: unknown) => (error as { code?: string }).code === 'validation',
          );
          assert.ok(!fs.existsSync(path.join(active, 'ClientOnly-1.0.jar')));
        } finally {
          stub2.restore();
        }
      } finally {
        stub.restore();
      }
    });

    await run.must('content_versions on Paper accepts spigot/bukkit-tagged plugin releases (F-13)', async () => {
      const dto = await seedServer(h, 'Content Versions', 'Paper');
      const stub = stubFetch((url) => {
        if (url.pathname === '/v2/project/somePlugin/version') {
          return json([
            versionPayload({ id: 's1', fileName: 'SpigotPlugin-1.0.jar', body: jarBody('s1'), loaders: ['spigot'] }),
            versionPayload({ id: 'b1', fileName: 'BukkitPlugin-1.0.jar', body: jarBody('b1'), loaders: ['bukkit'] }),
            versionPayload({ id: 'f1', fileName: 'FabricOnly-1.0.jar', body: jarBody('f1'), loaders: ['fabric'] }),
          ]);
        }
        return json({}, 404);
      });
      try {
        const versions = await h.invoke<{ id: string; loaders: string[] }[]>('content_versions', { id: dto.id, projectId: 'somePlugin' });
        assert.deepEqual(versions.map((version) => version.id), ['s1', 'b1']);
        const request = stub.urls.find((url) => url.includes('/project/somePlugin/version')) ?? '';
        assert.ok(request.includes('game_versions='), request);
        assert.ok(!request.includes('loaders='), `plugin version query must not pre-filter loaders: ${request}`);
      } finally {
        stub.restore();
      }
    });

    await run.must('preview/meta JSON state stays consistent after an update (store round-trip)', async () => {
      const dto = await seedServer(h, 'Content Meta Roundtrip', 'Fabric');
      const { active } = contentDirs(h, dto);
      writeJar(active, 'm1.jar', jarBody('m1'));
      setMeta(h, dto, { 'm1.jar': { projectId: 'projM', versionId: 'v1', title: 'M' } });
      const newBody = jarBody('m2');
      const stub = stubFetch((url) => {
        if (url.pathname === '/v2/version/m2') return json(versionPayload({ id: 'm2', fileName: 'm2.jar', body: newBody, versionNumber: '2.0' }));
        if (url.pathname === '/v2/project/projM') return json({ id: 'projM', project_type: 'mod', server_side: 'required' });
        if (url.hostname === 'cdn.modrinth.com') return fileResponse(newBody);
        return json({}, 404);
      });
      try {
        await h.invoke('content_install', { id: dto.id, projectId: 'projM', versionId: 'm2', title: 'M', jobId: '' });
        writeJson(path.join(h.dataRoot, 'content-suite-seen.json'), metaOf(h, dto));
        const roundTrip = readJson<Record<string, { versionId?: string }>>(path.join(h.dataRoot, 'content-suite-seen.json'), {});
        assert.equal(roundTrip['m2.jar']?.versionId, 'm2');
        assert.equal(roundTrip['m1.jar'], undefined);
      } finally {
        stub.restore();
      }
    });
  });
}
