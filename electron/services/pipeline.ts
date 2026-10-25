// Modpack pipeline — preview/install/cancel mapped to the Rust DTO contract (src/tauri.ts).
// Preview = resolve + plan (no install); install = engine run with rollback + sidecar for boot-time L2/L3.
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { IpcContext, Handler } from '../ipc';
import { appError } from './store';
import { Store, type ServerDto } from './store';
import { Jobs } from './jobs';
import { log, ensureServerProperties, writeEula, freePort } from './installer/core';
import { makeCuratedResolver } from './installer/curated';
import { resolveMrpack, splitDeps, installModrinth, type MrIndex } from './installer/modrinth';
import { installCurseforge, inspectStagedZip } from './installer/curseforge';

export type PipelineSourceRequest =
  | { kind: 'modrinthRemote'; projectId: string; versionId: string; loader?: { kind: string; minecraftVersion: string; loaderVersion: string | null }; javaPath?: string }
  | { kind: 'localMrpack'; sourceId: string }
  | { kind: 'curseForgeServerZip'; zipName: string };

export interface PipelineFileDecision { path: string; side: 'server' | 'client' | 'both' | null; action: 'include' | 'exclude' | 'awaitingUserChoice'; reason: string }
export interface PipelinePreviewDto { previewId: string; sourceName: string; warnings: string[]; plan: { loader: { kind: string; minecraftVersion: string; loaderVersion: string | null }; fileDecisions: PipelineFileDecision[] } }

interface HeldPreview {
  source: PipelineSourceRequest;
  sourceName: string;
  loader: { kind: string; minecraftVersion: string; loaderVersion: string | null };
  mrpackPath?: string;
  index?: MrIndex;
  slug?: string | null;
  zipPath?: string;
}

export interface PipelineInstallChoices { files: Record<string, 'include' | 'exclude'>; approvedReplacements: string[]; autoDeleteCurseForgeZip: boolean }
export interface PipelineCreateInput { name: string; port?: number; ramMb: number; javaPath?: string; eulaAccepted?: boolean }
export interface PipelineInstallResult { status: 'complete' | 'failed' | 'cancelled'; server: ServerDto | null; report: { status: string; stages: { stage: string; outcome: string }[]; files: { path: string; outcome: string }[]; warnings: string[]; errors: string[] }; error: string | null }

const LOADER_DTO: Record<string, string> = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt', vanilla: 'Vanilla', paper: 'Paper' };

export class Pipeline {
  private previews = new Map<string, HeldPreview>();

  constructor(private ctx: IpcContext, private jobs: Jobs) {}

  private cacheDir(): string { return path.join(this.ctx.dataRoot, 'cache'); }

  async preview(source: PipelineSourceRequest, jobId: string): Promise<PipelinePreviewDto> {
    const held: HeldPreview = { source, sourceName: '', loader: { kind: 'vanilla', minecraftVersion: '', loaderVersion: null } };
    const warnings: string[] = [];
    const decisions: PipelineFileDecision[] = [];

    if (source.kind === 'modrinthRemote' || source.kind === 'localMrpack') {
      this.jobs.progress(jobId, { progress: 20, stage: 'resolving pack' });
      const r = await resolveMrpack(source.kind === 'modrinthRemote' ? { projectId: source.projectId, versionId: source.versionId } : { localPath: source.sourceId }, this.cacheDir());
      held.mrpackPath = r.mrpackPath; held.index = r.index; held.slug = r.slug;
      const { kind, ver, mc } = splitDeps(r.index);
      if (!kind) throw appError('validation', `Unsupported loader in pack dependencies: ${JSON.stringify(r.index.dependencies)}`);
      held.loader = { kind, minecraftVersion: mc, loaderVersion: ver };
      held.sourceName = r.index.name;
      const curated = makeCuratedResolver({ platform: 'modrinth', packSlug: r.slug, presentPaths: r.index.files.map(f => f.path) });
      for (const f of r.index.files) {
        const v = curated.resolve(f.path, f.env?.server ?? 'required');
        if (v.why !== 'declared') warnings.push(`${f.path}: ${v.why}`);
        const side = f.env?.server === 'unsupported' ? 'client' : f.env?.client === 'required' ? 'both' : 'server';
        const action = v.env === 'unsupported' ? 'exclude' : f.env?.server === 'optional' ? 'awaitingUserChoice' : 'include';
        const reason = v.env === 'unsupported' ? 'serverUnsupported' : f.env?.server === 'optional' ? 'userChoice' : v.env === 'required' && f.env?.server === undefined ? 'missingEnvironmentRetained' : 'required';
        decisions.push({ path: f.path, side, action, reason });
      }
    } else if (source.kind === 'curseForgeServerZip') {
      const zipPath = path.join(this.ctx.dataRoot, 'curseforge-import', source.zipName);
      if (!fs.existsSync(zipPath)) throw appError('not-found', `Staged ZIP "${source.zipName}" not found.`);
      const insp = await inspectStagedZip(zipPath);
      if (insp.classification !== 'supportedServerPack') throw appError('validation', `${source.zipName}: ${insp.reason}`);
      held.zipPath = zipPath; held.sourceName = insp.name.replace(/\.zip$/i, '');
      held.loader = { kind: (insp.loader ?? 'Forge').toLowerCase(), minecraftVersion: insp.minecraftVersion ?? '', loaderVersion: insp.loaderVersion };
      warnings.push(insp.reason);
    }

    const previewId = randomUUID();
    this.previews.set(previewId, held);
    this.jobs.progress(jobId, { progress: 100, stage: 'preview ready' });
    return { previewId, sourceName: held.sourceName, warnings, plan: { loader: held.loader, fileDecisions: decisions } };
  }

  discardPreview(previewId: string): boolean { return this.previews.delete(previewId); }

  async install(previewId: string, input: PipelineCreateInput, choices: PipelineInstallChoices, jobId: string): Promise<PipelineInstallResult> {
    const held = this.previews.get(previewId);
    if (!held) throw appError('not-found', `Preview ${previewId} not found.`);
    const store = new Store(this.ctx.dataRoot);
    const report = { status: 'preparing', stages: [] as { stage: string; outcome: string }[], files: [] as { path: string; outcome: string }[], warnings: [] as string[], errors: [] as string[] };
    const cancelled = (): boolean => this.jobs.isCancelled(jobId);

    let dto: ServerDto | null = null;
    let dir = '';
    try {
      const loaderName = LOADER_DTO[held.loader.kind] ?? 'Vanilla';
      dto = store.createServer({
        name: input.name, loader: loaderName, mcVersion: held.loader.minecraftVersion,
        loaderVersion: held.loader.loaderVersion ?? undefined,
        modpackId: held.source.kind === 'modrinthRemote' ? held.source.projectId : held.slug ?? undefined,
        port: input.port, ramMb: input.ramMb, javaPath: input.javaPath, eulaAccepted: input.eulaAccepted,
      });
      dir = path.join(this.ctx.dataRoot, 'servers', dto.id);

      if (cancelled()) return this.failOrCancel(store, dto, dir, 'cancelled', report, null);

      this.jobs.progress(jobId, { progress: 5, stage: 'preparing' });
      const onProgress = (p: { stage: string; pct?: number }): void => { this.jobs.progress(jobId, { progress: p.pct ?? 10, stage: p.stage }); };

      if (held.index && held.mrpackPath) {
        const res = await installModrinth({
          mrpackPath: held.mrpackPath, index: held.index, slug: held.slug ?? null,
          dir, cacheDir: this.cacheDir(), dataRoot: this.ctx.dataRoot,
          onProgress,
          includeOptional: fp => choices.files[fp] === 'include',
        });
        report.files.push({ path: `${res.installed} files`, outcome: 'installed' });
        report.files.push({ path: `${res.skippedOptional} optional`, outcome: 'skipped-optional' });
        report.files.push({ path: `${res.skippedUnsupported} unsupported`, outcome: 'skipped-server-unsupported' });
        report.warnings.push(...res.warnings);
        report.stages.push({ stage: 'download', outcome: 'complete' });
        this.writeSidecar(dir, { platform: 'modrinth', slug: held.slug, files: held.index.files.map(f => f.path), loader: held.loader.kind, mc: held.loader.minecraftVersion });
      } else if (held.zipPath || held.source.kind === 'curseForgeServerZip') {
        const zipPath = held.zipPath ?? path.join(this.ctx.dataRoot, 'curseforge-import', (held.source as { zipName: string }).zipName);
        const res = await installCurseforge({ zipPath, dir, dataRoot: this.ctx.dataRoot, cacheDir: this.cacheDir(), onProgress });
        report.files.push({ path: `${res.installed} mods`, outcome: 'installed' });
        report.files.push({ path: `${res.skippedClientOnly} client-only`, outcome: 'skipped-client-only' });
        report.warnings.push(...res.warnings);
        for (const m of res.manuallyRequired) report.warnings.push(`manually required: ${m.pageUrl} (${m.reason})`);
        report.stages.push({ stage: `route-${res.route}`, outcome: 'complete' });
        this.writeSidecar(dir, { platform: 'curseforge', slug: null, files: [], loader: res.loader ?? 'forge', mc: res.mc ?? '' });
        if (choices.autoDeleteCurseForgeZip && zipPath.startsWith(path.join(this.ctx.dataRoot, 'curseforge-import'))) {
          fs.rmSync(zipPath, { force: true });
        }
      } else {
        throw appError('validation', 'Unsupported pipeline source.');
      }

      if (cancelled()) return this.failOrCancel(store, dto, dir, 'cancelled', report, null);

      const port = await freePort(input.port && input.port > 0 ? input.port : 25565);
      ensureServerProperties(dir, port);
      if (input.eulaAccepted) writeEula(dir);
      store.updateServer(dto.id, { port });
      report.stages.push({ stage: 'publish', outcome: 'complete' });
      report.status = 'complete';
      this.jobs.progress(jobId, { progress: 100, stage: 'install complete' });
      this.previews.delete(previewId);
      return { status: 'complete', server: store.getServer(dto.id), report, error: null };
    } catch (err) {
      return this.failOrCancel(store, dto, dir, 'failed', report, err instanceof Error ? err.message : String(err));
    }
  }

  private failOrCancel(store: Store, dto: ServerDto | null, dir: string, status: 'failed' | 'cancelled', report: PipelineInstallResult['report'], error: string | null): PipelineInstallResult {
    // rollback: complete-or-nothing (M-7)
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    if (dto) store.deleteServer(dto.id);
    report.status = status;
    if (error) report.errors.push(error);
    log(`[pipeline] ${status}${error ? `: ${error}` : ''}`);
    return { status, server: null, report, error };
  }

  private writeSidecar(dir: string, data: Record<string, unknown>): void {
    try { fs.writeFileSync(path.join(dir, 'msm-install.json'), JSON.stringify({ ...data, at: new Date().toISOString() }, null, 2)); } catch { /* best effort */ }
  }

  handlers(): Record<string, Handler> {
    return {
      modpack_pipeline_pick_local_mrpack: async () => {
        const { dialog } = await import('electron');
        const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Modrinth modpack', extensions: ['mrpack'] }] });
        if (r.canceled || !r.filePaths[0]) return null;
        return { sourceId: r.filePaths[0], fileName: path.basename(r.filePaths[0]) };
      },
      modpack_pipeline_preview: async a => this.preview(a.source as PipelineSourceRequest, String(a.jobId ?? '')),
      modpack_pipeline_install: async a => this.install(String(a.previewId), a.input as PipelineCreateInput, a.choices as PipelineInstallChoices, String(a.jobId ?? '')),
      modpack_pipeline_cancel: a => this.jobs.cancel(String(a.jobId)),
      modpack_pipeline_discard_preview: a => this.discardPreview(String(a.previewId)),
      modpack_pipeline_release_local_mrpack: () => true,
    };
  }
}
