// Create step 1 — server type / pack source picker (extracted from Create.tsx, WP-6.5).
import { Badge, Button, Card, CardTitle, inputCls } from '../../components/ui';
import type { CurseForgeDownloadUpdate, CurseForgeModpackSearchResult, CurseForgeModpackSort, CurseForgeProjectMetaDto } from '../../tauri';
import { MAX_LOCAL_MRPACK_BYTES, formatBytes, type Kind } from './helpers';

interface StepTypeProps {
  hasBackend: boolean;
  kind: Kind;
  serverLoader: string;
  onPickLoader: (loader: string) => void;
  onPickModrinthPacks: () => void;
  onPickCurseforge: () => void;
  // CurseForge discovery panel
  curseforgeBrowserMessage: string;
  curseforgeDownloads: CurseForgeDownloadUpdate[];
  curseforgeLoading: boolean;
  onOpenBrowser: () => void;
  onOpenExternal: () => void;
  onCancelDownload: (downloadId: string) => void;
  onContinueToZipSelection: () => void;
  // CurseForge API key status + in-app browser
  cfKeyConfigured: boolean | null;
  cfKeyHint: string;
  onRefreshKeyStatus: () => void;
  cfSearchQuery: string;
  onCfSearchQueryChange: (value: string) => void;
  cfSearchSort: CurseForgeModpackSort;
  onCfSearchSortChange: (sort: CurseForgeModpackSort) => void;
  cfSearchBusy: boolean;
  cfSearchError: string;
  cfSearchResult: CurseForgeModpackSearchResult | null;
  cfResolvingId: number | null;
  onSearchPacks: (loadMore?: boolean) => void;
  onPickSearchedPack: (projectId: number) => void;
  // CurseForge key-mode project resolver
  cfProjectInput: string;
  onCfProjectInputChange: (value: string) => void;
  cfProjectError: string;
  cfProjectBusy: boolean;
  cfProjectMeta: CurseForgeProjectMetaDto | null;
  cfProjectId: number | null;
  onResolveProject: () => void;
  onContinueToConfigure: () => void;
  // Browser/mock mode
  onPickMockKind: (kind: Kind) => void;
}

const SERVER_TYPES: { loader: string; title: string; detail: string }[] = [
  { loader: 'Vanilla', title: 'Vanilla', detail: 'Official Mojang server JAR.' },
  { loader: 'Paper', title: 'Paper', detail: 'Full Paper build catalogue, stable first.' },
  { loader: 'Fabric', title: 'Fabric', detail: 'Provider-verified Fabric server builds.' },
  { loader: 'Forge', title: 'Forge', detail: 'Full Forge catalogue including specific versions.' },
  { loader: 'NeoForge', title: 'NeoForge', detail: 'Versions mapped to supported Minecraft releases.' },
];

export function StepType(props: StepTypeProps) {
  if (!props.hasBackend) {
    return (
      <div className="mc-create-type-grid grid gap-3">
        {([
          { k: 'vanilla', t: 'Vanilla', d: 'Official server, 2-click setup. Pick MC version → name/RAM/port/EULA → done.', e: '🧱' },
          { k: 'curseforge', t: 'CurseForge Modpack', d: 'Browse local mock entries; live access is currently unavailable.', e: '🔥' },
          { k: 'modrinth', t: 'Modrinth Modpack', d: 'Browse Modrinth packs. Open API, default source.', e: '💠' },
        ] as { k: Kind; t: string; d: string; e: string }[]).map((choice) => (
          <button key={choice.k} onClick={() => props.onPickMockKind(choice.k)}
            className={`mc-edition ${props.kind === choice.k ? 'mc-edition-active' : ''}`}>
            {choice.k === 'vanilla' && <span className="mc-splash">NEW!</span>}
            <div className="text-3xl">{choice.e}</div>
            <div className="mc-pixel mt-2 text-[10px]">{choice.t}</div>
            <div className="mc-edition-sub mt-1 text-xs">{choice.d}</div>
          </button>
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="mc-create-type-grid grid gap-3">
        {SERVER_TYPES.map((choice) => (
          <button
            key={choice.loader}
            onClick={() => props.onPickLoader(choice.loader)}
            className={'mc-edition ' + (props.serverLoader === choice.loader ? 'mc-edition-active' : '')}
          >
            <div className="mc-pixel text-[10px]">{choice.title}</div>
            <div className="mc-edition-sub mt-1 text-xs">{choice.detail}</div>
          </button>
        ))}
      </div>
      <button onClick={props.onPickModrinthPacks} className="mc-edition">
        <div className="text-3xl">💠</div>
        <div className="mc-pixel mt-2 text-[10px]">Modrinth modpacks</div>
        <div className="mc-edition-sub mt-1 text-xs">Browse the live Modrinth catalog and inspect exact versions.</div>
      </button>
      <button
        type="button"
        onClick={props.onPickCurseforge}
        className={'mc-edition ' + (props.kind === 'curseforge' ? 'mc-edition-active' : '')}
      >
        <div className="text-3xl">🔥</div>
        <div className="mc-pixel mt-2 text-[10px]">CurseForge server pack</div>
        <div className="mc-edition-sub mt-1 text-xs">Open CurseForge and import an author-provided SERVER ZIP.</div>
      </button>
      {props.kind === 'curseforge' && (
        <Card>
          <CardTitle>Find the server pack</CardTitle>
          <p className="text-sm text-zinc-300">
            On a modpack page, open <strong>Files</strong>, choose a version, then open <strong>Additional Files</strong> and download the <strong>SERVER</strong> pack.
            The regular client modpack ZIP is also installable: its <code>manifest.json</code> is resolved keylessly and client-only files are skipped.
            With a CurseForge API key saved in Settings, you can browse and install packs in-app below, or paste a project URL for a one-click server-pack install.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={props.onOpenBrowser}>Open CurseForge</Button>
            <Button variant="secondary" onClick={props.onOpenExternal}>Open in External Browser</Button>
          </div>
          {props.curseforgeBrowserMessage && <p role="status" className="mt-2 text-xs text-zinc-300">{props.curseforgeBrowserMessage}</p>}
          {props.curseforgeDownloads.length > 0 && (
            <div className="mt-3 space-y-2" aria-label="CurseForge downloads">
              {props.curseforgeDownloads.map((download) => {
                const activeDownload = ['starting', 'downloading', 'canceling'].includes(download.status);
                const percent = download.totalBytes && download.totalBytes > 0
                  ? Math.min(100, Math.round(download.bytesReceived / download.totalBytes * 100))
                  : null;
                return (
                  <div key={download.id} className="rounded border border-zinc-800 bg-zinc-950 p-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 break-all text-sm">{download.name}</span>
                      <span className="text-xs text-zinc-300">{download.status}</span>
                    </div>
                    {activeDownload && (
                      <div
                        role="progressbar"
                        aria-label={`Downloading ${download.name}`}
                        aria-valuemin={0}
                        aria-valuemax={download.totalBytes ?? undefined}
                        aria-valuenow={percent === null ? undefined : download.bytesReceived}
                        className="mt-2 h-1.5 overflow-hidden rounded bg-zinc-800"
                      >
                        <div
                          className={`h-full bg-emerald-500 ${percent === null ? 'w-1/3 animate-pulse' : ''}`}
                          style={percent === null ? undefined : { width: `${percent}%` }}
                        />
                      </div>
                    )}
                    <p role={download.status === 'failed' ? 'alert' : 'status'} className="mt-1 text-xs text-zinc-400">
                      {download.totalBytes
                        ? `${formatBytes(download.bytesReceived)} / ${formatBytes(download.totalBytes)} · `
                        : download.bytesReceived > 0 ? `${formatBytes(download.bytesReceived)} · ` : ''}
                      {download.message}
                    </p>
                    {activeDownload && download.status !== 'canceling' && (
                      <Button size="sm" variant="destructive" className="mt-2" onClick={() => props.onCancelDownload(download.id)}>Cancel download</Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-zinc-500">Downloads are staged under app data. They are not written into an existing server.</p>
            <Button disabled={props.curseforgeLoading} onClick={props.onContinueToZipSelection}>
              {props.curseforgeLoading ? 'Scanning ZIPs…' : 'Next — Choose a downloaded ZIP →'}
            </Button>
          </div>
        </Card>
      )}
      {props.kind === 'curseforge' && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Browse CurseForge modpacks</CardTitle>
            <Badge tone={props.cfKeyConfigured === true ? 'green' : 'amber'}>
              {props.cfKeyConfigured === null ? 'checking key…' : props.cfKeyConfigured ? 'API key configured' : 'API key needed'}
            </Badge>
          </div>
          {props.cfKeyConfigured !== true ? (
            <>
              <p className="text-sm text-zinc-300">
                Add a classic CurseForge API key in <strong>Settings → CurseForge API key</strong>. Once saved, this wizard can
                search the CurseForge modpack catalogue in-app and install the latest server pack with one click. Without a key you
                can still open CurseForge, download a SERVER ZIP manually, and use “Browse for ZIP” above.
              </p>
              {props.cfKeyHint && <p className="mt-1 text-xs text-zinc-500">{props.cfKeyHint}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={props.onRefreshKeyStatus} disabled={props.cfKeyConfigured === null}>
                  I saved the key — check again
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-zinc-400">
                Search the official CurseForge modpack catalogue. Selecting a pack resolves its latest file and server pack automatically.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  aria-label="Search CurseForge modpacks"
                  value={props.cfSearchQuery}
                  onChange={(event) => props.onCfSearchQueryChange(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') props.onSearchPacks(); }}
                  placeholder="Search modpacks, e.g. skyfactory"
                  className={`${inputCls} max-w-md`}
                />
                <select
                  aria-label="Sort CurseForge results"
                  value={props.cfSearchSort}
                  onChange={(event) => props.onCfSearchSortChange(event.target.value as CurseForgeModpackSort)}
                  className={`${inputCls} max-w-[170px]`}
                >
                  <option value="popularity">Popular</option>
                  <option value="downloads">Most downloads</option>
                  <option value="recent">Recently updated</option>
                  <option value="name">Name</option>
                </select>
                <Button size="sm" onClick={() => props.onSearchPacks()} disabled={props.cfSearchBusy}>
                  {props.cfSearchBusy ? 'Searching…' : 'Search'}
                </Button>
              </div>
              {props.cfSearchError && <p role="alert" className="mt-2 text-xs text-red-300">{props.cfSearchError}</p>}
              {props.cfSearchResult && (
                props.cfSearchResult.hits.length === 0 ? (
                  <p role="status" className="mt-3 text-sm text-zinc-500">
                    No modpacks matched{props.cfSearchQuery ? ` “${props.cfSearchQuery}”` : ''}.
                  </p>
                ) : (
                  <div className="mt-3 space-y-2">
                    {props.cfSearchResult.hits.map((hit) => (
                      <div key={hit.projectId} className="flex flex-wrap items-center gap-3 rounded border border-zinc-800 bg-zinc-950 p-2.5">
                        {hit.iconUrl
                          ? <img src={hit.iconUrl} alt="" className="h-9 w-9 rounded" loading="lazy" />
                          : <div className="flex h-9 w-9 items-center justify-center rounded bg-zinc-800 text-lg">📦</div>}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-2">
                            <strong className="text-sm">{hit.name}</strong>
                            {hit.author && <span className="text-xs text-zinc-500">by {hit.author}</span>}
                            <span className="text-xs text-zinc-500">{hit.downloads.toLocaleString()} downloads</span>
                          </div>
                          {hit.summary && <p className="line-clamp-2 text-xs text-zinc-400">{hit.summary}</p>}
                        </div>
                        <Button
                          size="sm"
                          onClick={() => props.onPickSearchedPack(hit.projectId)}
                          disabled={props.cfResolvingId !== null || props.cfProjectBusy}
                        >
                          {props.cfResolvingId === hit.projectId ? 'Resolving…' : 'Use pack'}
                        </Button>
                      </div>
                    ))}
                    {props.cfSearchResult.totalHits > props.cfSearchResult.hits.length && (
                      <div className="flex justify-center">
                        <Button size="sm" variant="secondary" onClick={() => props.onSearchPacks(true)} disabled={props.cfSearchBusy}>
                          {props.cfSearchBusy ? 'Loading…' : `Load more (${props.cfSearchResult.hits.length} of ${props.cfSearchResult.totalHits})`}
                        </Button>
                      </div>
                    )}
                  </div>
                )
              )}
            </>
          )}
        </Card>
      )}
      {props.kind === 'curseforge' && (
        <Card>
          <CardTitle>Or resolve a project link</CardTitle>
          <p className="text-sm text-zinc-300">
            Paste a modpack URL, slug or numeric project id; the latest file's <code>serverPackFileId</code> is resolved automatically with your saved API key.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              aria-label="CurseForge project URL, slug or id"
              value={props.cfProjectInput}
              onChange={(event) => props.onCfProjectInputChange(event.target.value)}
              placeholder="https://www.curseforge.com/minecraft/modpacks/skyfactory-5 or 392141"
              className={`${inputCls} max-w-xl`}
            />
            <Button onClick={props.onResolveProject} disabled={props.cfProjectBusy || !props.hasBackend || props.cfKeyConfigured !== true}>
              {props.cfProjectBusy ? 'Resolving…' : 'Resolve project'}
            </Button>
          </div>
          {props.cfKeyConfigured !== true && (
            <p className="mt-2 text-xs text-zinc-500">Resolving a project link also needs the API key saved in Settings.</p>
          )}
          {props.cfProjectError && <p role="alert" className="mt-2 text-xs text-red-300">{props.cfProjectError}</p>}
          {props.cfProjectMeta && (
            <div className="mt-3 rounded border border-emerald-800 bg-emerald-950/30 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="green">{props.cfProjectMeta.hasServerPack ? 'server pack' : 'client manifest'}</Badge>
                <strong className="text-sm">{props.cfProjectMeta.name}</strong>
                <span className="text-xs text-zinc-300">Minecraft {props.cfProjectMeta.minecraftVersion ?? '?'} · {props.cfProjectMeta.loader ?? '?'}</span>
              </div>
              <p className="mt-1 text-xs text-zinc-400">Project id {props.cfProjectMeta.projectId}. {props.cfProjectMeta.hasServerPack ? 'The latest server pack is downloaded and installed.' : 'No server pack on the latest file; manifest mods are resolved keylessly.'}</p>
              <div className="mt-3 flex justify-end">
                <Button onClick={props.onContinueToConfigure} disabled={props.cfProjectId === null}>Continue to Configure →</Button>
              </div>
            </div>
          )}
        </Card>
      )}
    </>
  );
}

export type { StepTypeProps };
export { MAX_LOCAL_MRPACK_BYTES };
