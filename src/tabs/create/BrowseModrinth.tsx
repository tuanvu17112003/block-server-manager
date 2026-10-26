// Create step 2 (Modrinth) — live catalogue search + local .mrpack import (extracted from Create.tsx).
import { Badge, Button, Card, inputCls } from '../../components/ui';
import type { LocalMrpackSelection, MinecraftVersionDto, ModrinthModpackDto } from '../../tauri';
import { fmtDl } from './helpers';

interface BrowseModrinthProps {
  q: string;
  onQueryChange: (value: string) => void;
  mc: string;
  onMcChange: (value: string) => void;
  loader: string;
  onLoaderChange: (value: string) => void;
  sort: 'popular' | 'name';
  onSortChange: (value: 'popular' | 'name') => void;
  vanillaVersions: MinecraftVersionDto[];
  packs: ModrinthModpackDto[];
  displayedPacks: ModrinthModpackDto[];
  totalHits: number;
  loading: boolean;
  loadingMore: boolean;
  error: string;
  offset: number;
  hasMore: boolean;
  localMrpack: LocalMrpackSelection | null;
  installing: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
  onImportLocalMrpack: () => void;
  onPickPack: (pack: ModrinthModpackDto) => void;
  onBack: () => void;
}

export function BrowseModrinth(props: BrowseModrinthProps) {
  return (
    <div className="space-y-3">
      <Card>
        <div className="flex flex-wrap gap-2">
          <input aria-label="Search Modrinth modpacks" value={props.q} onChange={(event) => props.onQueryChange(event.target.value)} placeholder="Search Modrinth modpacks…" className={`${inputCls} max-w-xs`} />
          <Badge tone="green">Modrinth</Badge>
          <select aria-label="Filter Modrinth modpacks by Minecraft version" value={props.mc} onChange={(event) => props.onMcChange(event.target.value)} className={`${inputCls} w-auto`}>
            <option value="Any">Any game version</option>
            {Array.from(new Set([
              ...props.vanillaVersions.map((version) => version.id),
              ...props.packs.flatMap((result) => result.gameVersions),
              ...(props.mc === 'Any' ? [] : [props.mc]),
            ])).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((version) => (
              <option key={version} value={version}>{version}</option>
            ))}
          </select>
          <select aria-label="Filter Modrinth modpacks by loader" value={props.loader} onChange={(event) => props.onLoaderChange(event.target.value)} className={`${inputCls} w-auto`}>
            <option value="Any">Any loader</option>
            {Array.from(new Set([
              'fabric', 'forge', 'neoforge', 'quilt', 'vanilla', 'paper',
              ...props.packs.flatMap((result) => result.loaders),
              ...(props.loader === 'Any' ? [] : [props.loader]),
            ])).sort().map((value) => (
              <option key={value} value={value}>{value.charAt(0).toUpperCase() + value.slice(1)}</option>
            ))}
          </select>
          <select aria-label="Sort Modrinth modpacks" value={props.sort} onChange={(event) => props.onSortChange(event.target.value as 'popular' | 'name')} className={`${inputCls} w-auto`}>
            <option value="popular">Sort: Most downloads</option>
            <option value="name">Sort: Name A-Z</option>
          </select>
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          {props.totalHits} Modrinth modpack(s) · Popularity uses Modrinth download ordering.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" disabled={props.installing} onClick={props.onImportLocalMrpack}>
            {props.localMrpack ? 'Choose another local .mrpack' : 'Import local .mrpack'}
          </Button>
          {props.localMrpack && (
            <span role="status" className="break-all text-xs text-zinc-400">
              Selected local pack: {props.localMrpack.fileName}
            </span>
          )}
        </div>
      </Card>
      {props.loading && <p role="status" className="text-sm text-zinc-400">Loading Modrinth modpacks…</p>}
      {props.error && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded border border-red-900 bg-red-950/40 p-3 text-sm text-red-200">
          <span>Modrinth catalog error: {props.error}</span>
          <Button size="sm" variant="secondary" onClick={props.onRetry}>Retry</Button>
        </div>
      )}
      <div className="mc-create-pack-grid grid gap-3">
        {props.displayedPacks.map((result) => (
          <Card key={result.id}>
            <div className="flex gap-3">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded bg-zinc-900 text-2xl">
                {result.iconUrl
                  ? <img src={result.iconUrl} alt="" className="h-full w-full object-cover" />
                  : '💠'}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-semibold">{result.name}</span>
                  <Badge tone="green">MR</Badge>
                </div>
                <div className="text-xs text-zinc-500">
                  by {result.author} · {fmtDl(result.downloads)} downloads · MC {result.gameVersions.join(', ') || '—'} · {result.loaders.join(', ') || 'loader unspecified'}
                </div>
                <p className="mt-1 text-xs text-zinc-400">{result.summary}</p>
                <div className="mt-2"><Button size="sm" onClick={() => props.onPickPack(result)}>Select →</Button></div>
              </div>
            </div>
          </Card>
        ))}
      </div>
      {!props.loading && !props.error && props.packs.length === 0 && (
        <p className="text-sm text-zinc-500">No Modrinth modpacks match these filters.</p>
      )}
      {props.hasMore && (
        <Button variant="secondary" disabled={props.loading || props.loadingMore} onClick={props.onLoadMore}>
          {props.loadingMore ? 'Loading more…' : 'Load more'}
        </Button>
      )}
      <div className="flex gap-2">
        <Button variant="ghost" disabled={props.installing} onClick={props.onBack}>← Back</Button>
      </div>
    </div>
  );
}

export type { BrowseModrinthProps };
