// Content — installed mods/plugins, enable/disable by reversible rename, remove, and Modrinth
// install (with required dependencies) for the server's exact Minecraft version + loader.
import fs from 'node:fs';
import path from 'node:path';
import type { IpcContext, Handler } from '../ipc';
import { Store, appError, type ServerDto } from './store';
import { Jobs } from './jobs';
import { download, fetchOk, UA } from './installer/core';
import { fetchModrinthDependency } from './installer/modrinth';
import type { Backups } from './backups';
import type { ServerProcesses } from './server-process';

const API = 'https://api.modrinth.com/v2';

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

interface ContentMeta {
  projectId?: string;
  versionId?: string;
  versionNumber?: string;
  title?: string;
}

interface ModrinthVersion {
  id: string;
  name?: string;
  version_number?: string;
  game_versions?: string[];
  loaders?: string[];
  downloads?: number;
  files?: { url: string; filename: string; primary?: boolean; size?: number; hashes?: { sha1?: string; sha512?: string } }[];
  dependencies?: { project_id?: string | null; version_id?: string | null; dependency_type?: string }[];
}

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
    if (this.processes.status(id) !== 'stopped' && this.processes.status(id) !== 'crashed') {
      throw appError('conflict', 'Stop the server before changing its mods or plugins.');
    }
    return dto;
  }

  private kindOf(dto: ServerDto): 'mod' | 'plugin' {
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

  private metaMap(serverId: string): Record<string, ContentMeta> {
    return this.store().getSetting<Record<string, ContentMeta>>(`content:${serverId}`) ?? {};
  }

  private writeMeta(serverId: string, map: Record<string, ContentMeta>): void {
    this.store().setSetting(`content:${serverId}`, map);
  }

  list(serverId: string): ContentItemDto[] {
    const dto = this.requireServer(serverId);
    const { active, disabled } = this.dirs(dto);
    const kind = this.kindOf(dto);
    const meta = this.metaMap(serverId);
    const out = new Map<string, ContentItemDto>();
    const scan = (dir: string, enabled: boolean): void => {
      let files: string[] = [];
      try { files = fs.readdirSync(dir).filter((name) => /\.jar(\.disabled)?$/i.test(name)); } catch { return; }
      for (const fileName of files) {
        const file = path.join(dir, fileName);
        const info = meta[fileName] ?? meta[fileName.replace(/\.disabled$/i, '')];
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
    const dto = this.requireServer(serverId);
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
    const targets = [path.join(active, fileName), path.join(disabled, fileName), path.join(disabled, `${fileName}.disabled`)];
    let removed = false;
    for (const target of targets) {
      if (!fs.existsSync(target)) continue;
      fs.rmSync(target, { force: true });
      removed = true;
    }
    if (!removed) throw appError('not-found', `Content file "${fileName}" not found.`);
    const map = this.metaMap(serverId);
    delete map[fileName];
    delete map[`${fileName}.disabled`];
    this.writeMeta(serverId, map);
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
    const payload = await (await fetchOk(url, { headers: { 'User-Agent': UA } })).json() as {
      hits?: { project_id: string; slug: string; title: string; author: string; downloads: number; icon_url?: string; description: string; versions?: string[]; categories?: string[] }[];
      total_hits?: number;
    };
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
    const loader = this.kindOf(dto) === 'plugin' ? 'paper' : this.loaderKey(dto);
    const query = `?game_versions=${encodeURIComponent(JSON.stringify([dto.mcVersion]))}&loaders=${encodeURIComponent(JSON.stringify([loader]))}`;
    const rows = await (await fetchOk(`${API}/project/${encodeURIComponent(projectId)}/version${query}`, { headers: { 'User-Agent': UA } })).json() as ModrinthVersion[];
    return rows.map((version) => {
      const file = version.files?.find((entry) => entry.primary) ?? version.files?.[0];
      return {
        id: version.id,
        name: version.name ?? version.version_number ?? version.id,
        versionNumber: version.version_number ?? version.id,
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
  ): Promise<{ installed: number; files: string[]; warnings: string[] }> {
    const dto = this.requireIdle(serverId);
    const kind = this.kindOf(dto);
    const loader = kind === 'plugin' ? 'paper' : this.loaderKey(dto);
    const { active } = this.dirs(dto);
    fs.mkdirSync(active, { recursive: true });
    const progress = (pct: number, stage: string): void => {
      if (jobId) this.jobs.progress(jobId, { progress: pct, stage });
    };
    let version: ModrinthVersion | null = null;
    if (versionId) {
      version = await (await fetchOk(`${API}/version/${encodeURIComponent(versionId)}`, { headers: { 'User-Agent': UA } })).json() as ModrinthVersion;
    } else {
      const query = `?game_versions=${encodeURIComponent(JSON.stringify([dto.mcVersion]))}&loaders=${encodeURIComponent(JSON.stringify([loader]))}`;
      const rows = await (await fetchOk(`${API}/project/${encodeURIComponent(projectId)}/version${query}`, { headers: { 'User-Agent': UA } })).json() as ModrinthVersion[];
      version = rows[0] ?? null;
    }
    if (!version) throw appError('not-found', `No ${kind} version of ${projectId} supports Minecraft ${dto.mcVersion} on ${dto.loader}.`);
    const file = version.files?.find((entry) => entry.primary) ?? version.files?.[0];
    if (!file?.url) throw appError('not-found', 'That version has no downloadable file.');

    const meta = this.metaMap(serverId);
    const existing = Object.entries(meta).find(([, value]) => value.projectId === projectId);
    if (existing) {
      try { await this.backups.create(serverId, `before update ${existing[0]}`, 'Pre-install'); }
      catch (error) { console.warn(`[content] pre-update backup failed: ${(error as Error).message}`); }
    }

    progress(15, `downloading ${path.basename(file.filename)}`);
    const dest = path.join(active, path.basename(file.filename));
    await download(file.url, dest, { sha1: file.hashes?.sha1, sha512: file.hashes?.sha512, size: file.size });
    meta[path.basename(file.filename)] = {
      projectId,
      versionId: version.id,
      versionNumber: version.version_number ?? version.id,
      title: title ?? version.name ?? projectId,
    };
    this.writeMeta(serverId, meta);

    const installed: string[] = [path.basename(file.filename)];
    const warnings: string[] = [];
    const required = (version.dependencies ?? []).filter((dep) => (dep.dependency_type ?? 'required') === 'required' && dep.project_id);
    let index = 0;
    for (const dep of required) {
      index += 1;
      progress(20 + Math.round(70 * index / Math.max(1, required.length)), `dependency ${index}/${required.length}`);
      try {
        const jar = await fetchModrinthDependency({
          mc: dto.mcVersion,
          loader: kind === 'plugin' ? 'paper' : loader,
          modId: String(dep.project_id),
          modsDir: active,
        });
        if (jar) {
          installed.push(path.basename(jar));
          if (!meta[path.basename(jar)]) {
            meta[path.basename(jar)] = { projectId: String(dep.project_id), title: String(dep.project_id) };
            this.writeMeta(serverId, meta);
          }
        } else {
          warnings.push(`Required dependency ${dep.project_id} could not be resolved.`);
        }
      } catch (error) {
        warnings.push(`Required dependency ${dep.project_id}: ${(error as Error).message}`);
      }
    }
    progress(100, 'content installed');
    return { installed: installed.length, files: installed, warnings };
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
