// Content — installed mods/plugins, enable/disable by reversible rename, remove, and Modrinth
// install (with required dependencies) for the server's exact Minecraft version + loader.
//
// Phase 5 WP-5.1 (M-01/M-07/F-13):
//  - updates are replace-by-project and transactional: every file (primary + required dependencies)
//    is downloaded to a verified staging name first, the old project files are moved to a trash set,
//    then the staged files are published; any failure restores the old tree, and metadata is written
//    only for published files;
//  - enable/disable requires an idle server (running/starting/stopping => conflict);
//  - `content_install` is a real `Jobs` job: cancel checks between files + AbortSignal in downloads;
//  - dependency resolution is project-type aware (Paper plugin deps use project_type:plugin and the
//    plugin loader union) and never re-installs a dependency already present (including disabled).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IpcContext, Handler } from '../ipc';
import { Store, appError, type ServerDto } from './store';
import { Jobs } from './jobs';
import { MODRINTH_ALLOWED_HOSTS, UA, download, fetchTrusted } from './installer/core';
import type { Backups } from './backups';
import type { ServerProcesses } from './server-process';
import {
  acceptsProjectType,
  contentFileName,
  dependencySkipReason,
  isClientOnlyProject,
  loaderMatches,
  mergeContentMeta,
  planContentUpdate,
  presentProjectIds,
  primaryJarFile,
  pruneContentMeta,
  requiredDependencies,
  selectCompatibleVersion,
  stripDisabledSuffix,
  type ContentFileRef,
  type ContentKind,
  type ContentMetaEntry,
  type ContentUpdatePlan,
  type VersionFileLike,
  type VersionLike,
} from './content-core';

const API = 'https://api.modrinth.com/v2';
const TRASH_DIR = '.content-trash';

export interface ContentItemDto {
  fileName: string;
  enabled: boolean;
  sizeBytes: number;
  kind: 'mod' | 'plugin';
  title?: string | null;
  projectId?: string | null;
  versionId?: string | null;
  versionNumber?: string | null;
}

export interface ContentSearchHitDto {
  id: string;
  slug: string;
  name: string;
  author: string;
  downloads: number;
  iconUrl: string | null;
  summary: string;
  versions: string[];
  loaders: string[];
}

export interface ContentVersionDto {
  id: string;
  name: string;
  versionNumber: string;
  gameVersions: string[];
  loaders: string[];
  downloads: number;
  fileName: string;
  fileSize: number;
  dependencies: { projectId: string | null; versionId: string | null; type: string }[];
}

export interface ContentInstallResult {
  installed: number;
  files: string[];
  warnings: string[];
  /** Dependencies deliberately not installed (already present / client-only / no compatible build). */
  skipped: number;
}

export type ContentMeta = Record<string, ContentMetaEntry>;

interface ModrinthVersion extends VersionLike {
  downloads?: number;
  files?: (VersionFileLike & { url?: string; filename?: string; size?: number; hashes?: { sha1?: string; sha512?: string }; primary?: boolean })[];
  dependencies?: { project_id?: string | null; version_id?: string | null; dependency_type?: string }[];
}

interface ModrinthProjectMeta {
  id?: string;
  project_type?: string;
  server_side?: string;
  slug?: string;
  title?: string;
}

/** One file that has been downloaded + hash/size-verified into a hidden staging name. */
interface StagedContentFile {
  fileName: string;
  stagingPath: string;
  entry: ContentMetaEntry;
}

interface ScanFile extends ContentFileRef { path: string }

export class Content {
  constructor(
    private ctx: IpcContext,
    private processes: ServerProcesses,
    private jobs: Jobs,
    private backups: Backups,
  ) {}

  private store(): Store { return new Store(this.ctx.dataRoot); }
  private serverDir(id: string): string { return path.join(this.ctx.dataRoot, 'servers', id); }

  private requireServer(id: string): ServerDto {
    const dto = this.store().getServer(id);
    if (!dto) throw appError('not-found', `Server ${id} not found.`);
    return dto;
  }

  private requireIdle(id: string): ServerDto {
    const dto = this.requireServer(id);
    const status = this.processes.status(id);
    if (status !== 'stopped' && status !== 'crashed') {
      throw appError('conflict', 'Stop the server before changing its mods or plugins.');
    }
    return dto;
  }

  private kindOf(dto: ServerDto): ContentKind {
    return dto.loader === 'Paper' ? 'plugin' : 'mod';
  }

  private dirs(dto: ServerDto): { active: string; disabled: string } {
    const base = this.serverDir(dto.id);
    return this.kindOf(dto) === 'plugin'
      ? { active: path.join(base, 'plugins'), disabled: path.join(base, 'plugins-disabled') }
      : { active: path.join(base, 'mods'), disabled: path.join(base, 'mods-disabled') };
  }

  private loaderKey(dto: ServerDto): string {
    return dto.loader.trim().toLowerCase();
  }

  private metaMap(serverId: string): ContentMeta {
    return this.store().getSetting<ContentMeta>(`content:${serverId}`) ?? {};
  }

  private writeMeta(serverId: string, map: ContentMeta): void {
    this.store().setSetting(`content:${serverId}`, map);
  }

  /** Files currently on disk (active + disabled), enriched with the persisted project metadata. */
  private scanContentFiles(serverId: string, dto: ServerDto): ScanFile[] {
    const { active, disabled } = this.dirs(dto);
    const meta = this.metaMap(serverId);
    const out: ScanFile[] = [];
    const scan = (dir: string, enabled: boolean): void => {
      let names: string[] = [];
      try { names = fs.readdirSync(dir); } catch { return; }
      for (const fileName of names) {
        if (!/\.jar(\.disabled)?$/i.test(fileName)) continue;
        if (fileName.startsWith('.content-')) continue; // our own staging/trash artifacts
        const file = path.join(dir, fileName);
        try { if (!fs.statSync(file).isFile()) continue; } catch { continue; }
        const info = meta[fileName] ?? meta[stripDisabledSuffix(fileName)];
        out.push({
          fileName,
          enabled,
          path: file,
          projectId: info?.projectId ?? null,
          versionId: info?.versionId ?? null,
        });
      }
    };
    scan(active, true);
    scan(disabled, false);
    return out;
  }

  list(serverId: string): ContentItemDto[] {
    const dto = this.requireServer(serverId);
    const { active, disabled } = this.dirs(dto);
    const kind = this.kindOf(dto);
    const meta = this.metaMap(serverId);
    const out = new Map<string, ContentItemDto>();
    const scan = (dir: string, enabled: boolean): void => {
      let files: string[] = [];
      try { files = fs.readdirSync(dir).filter((name) => /\.jar(\.disabled)?$/i.test(name) && !name.startsWith('.content-')); } catch { return; }
      for (const fileName of files) {
        const file = path.join(dir, fileName);
        const info = meta[fileName] ?? meta[stripDisabledSuffix(fileName)];
        out.set(fileName, {
          fileName,
          enabled,
          sizeBytes: fs.statSync(file).size,
          kind,
          title: info?.title ?? null,
          projectId: info?.projectId ?? null,
          versionId: info?.versionId ?? null,
          versionNumber: info?.versionNumber ?? null,
        });
      }
    };
    scan(active, true);
    scan(disabled, false);
    return [...out.values()].sort((a, b) => a.fileName.localeCompare(b.fileName));
  }

  toggle(serverId: string, fileName: string, enabled: boolean): ContentItemDto[] {
    // WP-5.1: renaming a jar under a running server corrupts the loaded mod set — require idle.
    const dto = this.requireIdle(serverId);
    const { active, disabled } = this.dirs(dto);
    const from = path.join(enabled ? disabled : active, fileName);
    const to = path.join(enabled ? active : disabled, fileName);
    if (!fs.existsSync(from)) throw appError('not-found', `Content file "${fileName}" not found.`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(to)) throw appError('conflict', `"${fileName}" already exists in the destination folder.`);
    fs.renameSync(from, to);
    return this.list(serverId);
  }

  remove(serverId: string, fileName: string): ContentItemDto[] {
    this.requireIdle(serverId);
    const dto = this.requireServer(serverId);
    const { active, disabled } = this.dirs(dto);
    const base = stripDisabledSuffix(fileName);
    const targets = [
      path.join(active, fileName),
      path.join(disabled, fileName),
      path.join(disabled, `${fileName}.disabled`),
      path.join(active, `${base}.disabled`),
      path.join(disabled, base),
    ];
    const removed: string[] = [];
    for (const target of new Set(targets)) {
      if (!fs.existsSync(target)) continue;
      fs.rmSync(target, { force: true });
      removed.push(path.basename(target));
    }
    if (removed.length === 0) throw appError('not-found', `Content file "${fileName}" not found.`);
    this.writeMeta(serverId, pruneContentMeta(this.metaMap(serverId), [...removed, fileName, base]));
    return this.list(serverId);
  }

  async search(serverId: string, query: string, offset: number, limit: number): Promise<{ hits: ContentSearchHitDto[]; totalHits: number }> {
    const dto = this.requireServer(serverId);
    const kind = this.kindOf(dto);
    const facets: string[][] = [[`project_type:${kind}`]];
    if (dto.mcVersion) facets.push([`versions:${dto.mcVersion}`]);
    const loader = this.loaderKey(dto);
    if (kind === 'plugin') facets.push(['categories:paper']);
    else if (['fabric', 'forge', 'neoforge', 'quilt'].includes(loader)) facets.push([`categories:${loader}`]);
    const url = `${API}/search?query=${encodeURIComponent(query)}&index=relevance&offset=${Math.max(0, offset)}&limit=${Math.max(1, Math.min(30, limit))}&facets=${encodeURIComponent(JSON.stringify(facets))}`;
    const payload = await this.fetchJson<{
      hits?: { project_id: string; slug: string; title: string; author: string; downloads: number; icon_url?: string; description: string; versions?: string[]; categories?: string[] }[];
      total_hits?: number;
    }>(url);
    return {
      hits: (payload.hits ?? []).map((hit) => ({
        id: hit.project_id,
        slug: hit.slug,
        name: hit.title,
        author: hit.author,
        downloads: hit.downloads,
        iconUrl: hit.icon_url ?? null,
        summary: hit.description,
        versions: hit.versions ?? [],
        loaders: (hit.categories ?? []).filter((category) => ['fabric', 'forge', 'neoforge', 'quilt', 'paper', 'spigot', 'bukkit', 'purpur', 'folia'].includes(category)),
      })),
      totalHits: payload.total_hits ?? 0,
    };
  }

  async versions(serverId: string, projectId: string): Promise<ContentVersionDto[]> {
    const dto = this.requireServer(serverId);
    const kind = this.kindOf(dto);
    const loader = kind === 'plugin' ? 'paper' : this.loaderKey(dto);
    const rows = await this.projectVersions(projectId, dto.mcVersion);
    // F-13: plugin releases are often tagged bukkit/spigot/purpur rather than paper only. Prefer
    // versions accepted by any Paper-compatible loader, but keep the raw list visible if none match.
    const compatible = rows.filter((version) => loaderMatches(version.loaders, kind, loader));
    const visible = compatible.length > 0 ? compatible : rows;
    return visible.map((version) => {
      const file = primaryJarFile(version.files) ?? version.files?.[0];
      return {
        id: String(version.id ?? ''),
        name: version.name ?? version.version_number ?? String(version.id ?? ''),
        versionNumber: version.version_number ?? String(version.id ?? ''),
        gameVersions: version.game_versions ?? [],
        loaders: version.loaders ?? [],
        downloads: version.downloads ?? 0,
        fileName: file?.filename ?? '',
        fileSize: file?.size ?? 0,
        dependencies: (version.dependencies ?? []).map((dep) => ({
          projectId: dep.project_id ?? null,
          versionId: dep.version_id ?? null,
          type: dep.dependency_type ?? 'required',
        })),
      };
    });
  }

  async install(
    serverId: string,
    projectId: string,
    versionId: string | null,
    jobId: string,
    title: string | null,
  ): Promise<ContentInstallResult> {
    const dto = this.requireIdle(serverId);
    const kind = this.kindOf(dto);
    const loader = kind === 'plugin' ? 'paper' : this.loaderKey(dto);
    const { active, disabled } = this.dirs(dto);
    fs.mkdirSync(active, { recursive: true });

    const controller = jobId ? this.jobs.begin(jobId) : null;
    const signal = controller?.signal;
    const progress = (pct: number, stage: string): void => {
      if (jobId) this.jobs.progress(jobId, { progress: Math.max(0, Math.min(100, pct)), stage });
    };
    const throwIfCancelled = (): void => {
      if (jobId && this.jobs.isCancelled(jobId)) throw appError('cancelled', 'Content install cancelled.');
      if (signal?.aborted) throw appError('cancelled', 'Content install cancelled.');
    };

    const staged: StagedContentFile[] = [];
    const warnings: string[] = [];
    let skipped = 0;
    let published: { published: string[]; trashed: { from: string; to: string }[]; trashDir: string } | null = null;

    try {
      progress(5, 'resolving version');
      const version = versionId
        ? await this.fetchVersion(versionId, signal)
        : await this.latestCompatible(projectId, kind, loader, dto.mcVersion, signal);
      if (!version) {
        throw appError('not-found', `No ${kind} version of ${projectId} supports Minecraft ${dto.mcVersion} on ${dto.loader}.`);
      }
      const file = primaryJarFile(version.files);
      if (!file?.url) throw appError('not-found', 'That version has no downloadable file.');
      const targetFileName = contentFileName(file.filename ?? '');

      // Project-level guard (kind + client-only) before touching the server tree.
      const project = await this.tryProject(projectId, signal);
      if (project && isClientOnlyProject(project)) {
        throw appError('validation', `"${title ?? project.title ?? projectId}" is client-only and cannot be installed on a server.`);
      }
      if (project && !acceptsProjectType(project.project_type, kind)) {
        throw appError('validation', `"${title ?? project.title ?? projectId}" is a ${project.project_type ?? 'different project type'}, not a ${kind}.`);
      }

      const scan = this.scanContentFiles(serverId, dto);
      const plan = planContentUpdate({ files: scan, projectId, targetFileName });
      if (plan.conflict) {
        throw appError('conflict', `"${plan.conflict.fileName}" already exists and belongs to a different project; remove it before installing ${title ?? projectId}.`);
      }
      const previousProjectFiles = scan.filter((entry) => entry.projectId === projectId);
      if (previousProjectFiles.length > 0) {
        try { await this.backups.create(serverId, `before update ${previousProjectFiles[0].fileName}`, 'Pre-install'); }
        catch (error) { warnings.push(`Pre-update backup failed: ${(error as Error).message}`); }
      }

      throwIfCancelled();
      progress(15, `downloading ${targetFileName}`);
      staged.push(await this.stageFile(file, active, targetFileName, {
        projectId,
        versionId: version.id ?? versionId ?? undefined,
        versionNumber: version.version_number ?? version.id ?? undefined,
        title: title ?? version.name ?? projectId,
      }, signal, throwIfCancelled));

      const alreadyPresent = presentProjectIds(scan);
      const declaredDependencies = requiredDependencies(
        (version.dependencies ?? []).map((dep) => ({
          projectId: dep.project_id ?? null,
          versionId: dep.version_id ?? null,
          type: dep.dependency_type ?? 'required',
        })),
        { selfProjectId: projectId },
      );
      const dependencies = declaredDependencies.filter((dep) => !alreadyPresent.has(dep.projectId));
      skipped += declaredDependencies.length - dependencies.length; // already present (incl. disabled copies)
      const usedNames = new Set(staged.map((entry) => entry.fileName.toLowerCase()));
      for (let index = 0; index < dependencies.length; index += 1) {
        throwIfCancelled();
        const dep = dependencies[index];
        progress(20 + Math.round(60 * index / Math.max(1, dependencies.length)), `dependency ${index + 1}/${dependencies.length}`);
        try {
          const resolved = await this.resolveDependency(dep, kind, loader, dto.mcVersion, signal, scan, usedNames);
          if (!resolved.file) {
            warnings.push(resolved.warning ?? `Required dependency ${dep.projectId} could not be resolved.`);
            skipped += 1;
            continue;
          }
          const depName = contentFileName(resolved.file.filename ?? '');
          usedNames.add(depName.toLowerCase());
          staged.push(await this.stageFile(resolved.file, active, depName, {
            projectId: resolved.projectId ?? dep.projectId,
            versionId: resolved.version?.id ?? dep.versionId ?? undefined,
            versionNumber: resolved.version?.version_number ?? resolved.version?.id ?? undefined,
            title: resolved.title ?? String(resolved.projectId ?? dep.projectId),
          }, signal, throwIfCancelled));
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === 'cancelled') throw error;
          warnings.push(`Required dependency ${dep.projectId}: ${(error as Error).message}`);
          skipped += 1;
        }
      }

      throwIfCancelled();
      progress(85, 'publishing files');
      published = this.publishStaged(staged, plan, { active, disabled });

      progress(95, 'saving metadata');
      try {
        const removedNames = [...plan.stale.map((entry) => entry.fileName), ...(plan.overwrite ? [plan.overwrite.fileName] : [])];
        let meta = pruneContentMeta(this.metaMap(serverId), removedNames);
        meta = mergeContentMeta(meta, staged.map((entry) => ({ fileName: entry.fileName, entry: entry.entry })));
        this.writeMeta(serverId, meta);
      } catch (error) {
        this.restorePublished(published);
        published = null;
        throw error;
      }
      try {
        fs.rmSync(published.trashDir, { recursive: true, force: true });
        fs.rmdirSync(path.dirname(published.trashDir)); // remove the empty .content-trash parent too
      } catch { /* best effort */ }
      published = null;

      progress(100, 'content installed');
      return { installed: staged.length, files: staged.map((entry) => entry.fileName), warnings, skipped };
    } catch (error) {
      if (published) { try { this.restorePublished(published); } catch { /* best effort */ } }
      for (const entry of staged) {
        try { fs.rmSync(entry.stagingPath, { force: true }); } catch { /* best effort */ }
        try { fs.rmSync(`${entry.stagingPath}.part`, { force: true }); } catch { /* best effort */ }
      }
      throw error;
    } finally {
      if (jobId) this.jobs.end(jobId);
    }
  }

  // ---- network helpers ----

  private async fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetchTrusted(url, MODRINTH_ALLOWED_HOSTS, { signal, headers: { 'User-Agent': UA } });
    } catch (error) {
      if (signal?.aborted) throw appError('cancelled', 'Content install cancelled.');
      throw appError('io', `Modrinth request failed: ${(error as Error).message}`);
    }
    if (response.status === 404) throw appError('not-found', `Modrinth resource not found: ${url}`);
    if (!response.ok) throw appError('io', `Modrinth HTTP ${response.status} for ${url}`);
    return await response.json() as T;
  }

  private async fetchVersion(versionId: string, signal?: AbortSignal): Promise<ModrinthVersion> {
    return this.fetchJson<ModrinthVersion>(`${API}/version/${encodeURIComponent(versionId)}`, signal);
  }

  /** Project metadata; `null` when the id/slug is unknown (404), other failures surface. */
  private async tryProject(projectId: string, signal?: AbortSignal): Promise<ModrinthProjectMeta | null> {
    try {
      return await this.fetchJson<ModrinthProjectMeta>(`${API}/project/${encodeURIComponent(projectId)}`, signal);
    } catch (error) {
      if ((error as { code?: string }).code === 'not-found') return null;
      throw error;
    }
  }

  /**
   * Dependency projects are normally looked up by id (direct fetch). A project id that Modrinth no
   * longer resolves (renamed/deleted, or a slug in a hand-written dependency) falls back to a
   * kind-scoped search: project_type = mod|plugin, filtered by the pack's game version.
   */
  private async findProject(projectIdOrSlug: string, kind: ContentKind, mcVersion: string, signal?: AbortSignal): Promise<ModrinthProjectMeta | null> {
    const direct = await this.tryProject(projectIdOrSlug, signal);
    if (direct) return direct;
    const facets: string[][] = [[`project_type:${kind}`]];
    if (mcVersion) facets.push([`versions:${mcVersion}`]);
    const url = `${API}/search?query=${encodeURIComponent(projectIdOrSlug)}&limit=1&facets=${encodeURIComponent(JSON.stringify(facets))}`;
    try {
      const payload = await this.fetchJson<{ hits?: { project_id?: string }[] }>(url, signal);
      const hit = payload.hits?.[0]?.project_id;
      return hit ? await this.tryProject(hit, signal) : null;
    } catch (error) {
      if ((error as { code?: string }).code === 'cancelled') throw error;
      return null;
    }
  }

  private async projectVersions(projectId: string, mcVersion: string): Promise<ModrinthVersion[]> {
    // Fetch by game version only; loader filtering is done locally so Paper's plugin-loader union
    // (paper/spigot/bukkit/purpur/folia) works for both the UI list and dependency resolution.
    const query = mcVersion ? `?game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}` : '';
    return this.fetchJson<ModrinthVersion[]>(`${API}/project/${encodeURIComponent(projectId)}/version${query}`);
  }

  private async latestCompatible(projectId: string | null, kind: ContentKind, loader: string, mcVersion: string, signal?: AbortSignal): Promise<ModrinthVersion | null> {
    if (!projectId) return null;
    const rows = await this.projectVersions(projectId, mcVersion);
    return selectCompatibleVersion(rows, { mcVersion, kind, loader });
  }

  /** Resolve one required dependency project for the current kind (plugin vs mod), or explain why not. */
  private async resolveDependency(
    dep: { projectId: string; versionId: string | null },
    kind: ContentKind,
    loader: string,
    mcVersion: string,
    signal: AbortSignal | undefined,
    scan: ScanFile[],
    usedNames: Set<string>,
  ): Promise<{ projectId: string | null; version: ModrinthVersion | null; file: VersionFileLike | null; title?: string; warning?: string }> {
    const project = await this.findProject(dep.projectId, kind, mcVersion, signal);
    if (!project) return { projectId: dep.projectId, version: null, file: null, warning: `Required dependency ${dep.projectId} was not found on Modrinth.` };
    if (isClientOnlyProject(project)) {
      return { projectId: dep.projectId, version: null, file: null, title: project.title, warning: `Required dependency ${project.title ?? dep.projectId} is client-only and was skipped.` };
    }
    if (!acceptsProjectType(project.project_type, kind)) {
      return {
        projectId: dep.projectId, version: null, file: null, title: project.title,
        warning: `Required dependency ${project.title ?? dep.projectId} is a ${project.project_type}, not a ${kind}; skipped.`,
      };
    }
    const version = dep.versionId
      ? await this.fetchVersion(dep.versionId, signal)
      : await this.latestCompatible(project.id ?? dep.projectId, kind, loader, mcVersion, signal);
    if (!version) {
      return {
        projectId: dep.projectId, version: null, file: null, title: project.title,
        warning: `Required dependency ${project.title ?? dep.projectId} has ${dependencySkipReason(kind, loader)}.`,
      };
    }
    const file = primaryJarFile(version.files);
    if (!file) return { projectId: project.id ?? dep.projectId, version, file: null, title: project.title, warning: `Required dependency ${project.title ?? dep.projectId} has no downloadable .jar.` };
    const fileName = contentFileName(file.filename ?? '');
    if (usedNames.has(fileName.toLowerCase())) {
      return { projectId: project.id ?? dep.projectId, version, file: null, title: project.title, warning: `Required dependency ${project.title ?? dep.projectId} resolves to an already-selected file name ${fileName}; skipped.` };
    }
    const collision = scan.find((entry) => entry.fileName.toLowerCase() === fileName.toLowerCase());
    if (collision && collision.projectId !== (project.id ?? dep.projectId)) {
      return {
        projectId: project.id ?? dep.projectId, version, file: null, title: project.title,
        warning: `Required dependency ${project.title ?? dep.projectId} file ${fileName} collides with an existing file; skipped.`,
      };
    }
    return { projectId: project.id ?? dep.projectId, version, file, title: project.title };
  }

  // ---- filesystem staging/publish ----

  private async stageFile(
    file: VersionFileLike,
    dir: string,
    fileName: string,
    entry: ContentMetaEntry,
    signal: AbortSignal | undefined,
    throwIfCancelled: () => void,
  ): Promise<StagedContentFile> {
    if (!file.url) throw appError('not-found', 'That file has no download URL.');
    throwIfCancelled();
    const stagingPath = path.join(dir, `.content-stage-${randomUUID()}.jar`);
    await download(String(file.url), stagingPath, {
      sha1: file.hashes?.sha1,
      sha512: file.hashes?.sha512,
      size: file.size,
      signal,
      allowedHosts: MODRINTH_ALLOWED_HOSTS,
    });
    return { fileName, stagingPath, entry };
  }

  /**
   * Publish = move old project files (and same-name overwrite target) into a per-install trash dir,
   * then rename every staged file into place (dependencies first, primary last). Synchronous on
   * purpose: no IPC can interleave between the renames.
   */
  private publishStaged(
    staged: StagedContentFile[],
    plan: ContentUpdatePlan,
    dirs: { active: string; disabled: string },
  ): { published: string[]; trashed: { from: string; to: string }[]; trashDir: string } {
    const trashDir = path.join(dirs.active, TRASH_DIR, `${Date.now()}-${randomUUID()}`);
    const trashed: { from: string; to: string }[] = [];
    const published: string[] = [];
    const moveToTrash = (from: string): void => {
      if (!fs.existsSync(from)) return;
      fs.mkdirSync(trashDir, { recursive: true });
      const to = path.join(trashDir, `${trashed.length}-${path.basename(from)}`);
      fs.renameSync(from, to);
      trashed.push({ from, to });
    };
    try {
      if (plan.overwrite) moveToTrash(path.join(dirs.active, plan.overwrite.fileName));
      for (const stale of plan.stale) moveToTrash(path.join(stale.enabled ? dirs.active : dirs.disabled, stale.fileName));
      // Primary first in `staged`; publish it last so a dependency publish failure never replaces it.
      for (const entry of [...staged].reverse()) {
        const target = path.join(dirs.active, entry.fileName);
        if (fs.existsSync(target)) moveToTrash(target);
        fs.renameSync(entry.stagingPath, target);
        published.push(target);
      }
    } catch (error) {
      for (const target of published.reverse()) {
        try { fs.rmSync(target, { force: true }); } catch { /* best effort */ }
      }
      for (const move of trashed.reverse()) {
        try { fs.renameSync(move.to, move.from); } catch { /* best effort */ }
      }
      throw error;
    }
    return { published, trashed, trashDir };
  }

  private restorePublished(published: { published: string[]; trashed: { from: string; to: string }[]; trashDir: string }): void {
    for (const target of [...published.published].reverse()) {
      try { fs.rmSync(target, { force: true }); } catch { /* best effort */ }
    }
    for (const move of [...published.trashed].reverse()) {
      try { fs.renameSync(move.to, move.from); } catch { /* best effort */ }
    }
    try { fs.rmSync(published.trashDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmdirSync(path.dirname(published.trashDir)); } catch { /* best effort */ }
  }

  handlers(): Record<string, Handler> {
    return {
      content_list: (a) => this.list(String(a.id)),
      content_toggle: (a) => this.toggle(String(a.id), String(a.fileName), Boolean(a.enabled)),
      content_remove: (a) => this.remove(String(a.id), String(a.fileName)),
      content_search: (a) => this.search(String(a.id), String(a.query ?? ''), Number(a.offset ?? 0), Number(a.limit ?? 20)),
      content_versions: (a) => this.versions(String(a.id), String(a.projectId)),
      content_install: (a) => this.install(
        String(a.id),
        String(a.projectId),
        a.versionId ? String(a.versionId) : null,
        String(a.jobId ?? ''),
        a.title ? String(a.title) : null,
      ),
    };
  }
}
