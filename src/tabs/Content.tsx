import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TabId } from '../types';
import { useStore } from '../store';
import { Badge, Button, Card, Confirm, Empty, Modal, ProgressBar, inputCls } from '../components/ui';
import { hasBackend, onJobProgress, tauriContent, tauriServers } from '../tauri';
import type { ContentItemDto, ContentSearchHitDto, ContentVersionDto } from '../tauri';

function errorText(error: unknown, fallback: string): string {
  return error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : fallback;
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function downloadsLabel(value: number): string {
  return value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : `${Math.round(value / 1e3)}K`;
}

export default function Content({ go }: { go: (tab: TabId) => void }) {
  const { active, pushToast } = useStore();
  const backend = hasBackend();
  const [items, setItems] = useState<ContentItemDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ContentSearchHitDto[]>([]);
  const [totalHits, setTotalHits] = useState(0);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<ContentSearchHitDto | null>(null);
  const [versions, setVersions] = useState<ContentVersionDto[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState('');
  const [installing, setInstalling] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [progressStage, setProgressStage] = useState('');
  const [removeTarget, setRemoveTarget] = useState<ContentItemDto | null>(null);

  const stopped = active.status === 'stopped' || active.status === 'crashed';
  const kind = active.loader === 'Paper' ? 'plugin' : 'mod';
  const folder = kind === 'plugin' ? 'plugins' : 'mods';

  const load = useCallback(async () => {
    if (!backend || !active.id) return;
    setLoading(true);
    setError('');
    try {
      setItems(await tauriContent.list(active.id));
    } catch (err) {
      const message = errorText(err, 'Could not list installed content.');
      setError(message);
      pushToast(message, 'err');
    } finally {
      setLoading(false);
    }
  }, [active.id, backend, pushToast]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => { setHits([]); setTotalHits(0); setSelected(null); setVersions([]); }, [active.id]);

  const search = async () => {
    if (!backend || !active.id) return;
    setSearching(true);
    setError('');
    try {
      const result = await tauriContent.search(active.id, query.trim(), 0, 20);
      setHits(result.hits);
      setTotalHits(result.totalHits);
    } catch (err) {
      const message = errorText(err, 'Could not search Modrinth.');
      setError(message);
      pushToast(message, 'err');
    } finally {
      setSearching(false);
    }
  };

  const openVersions = async (hit: ContentSearchHitDto) => {
    setSelected(hit);
    setVersions([]);
    setVersionsError('');
    setVersionsLoading(true);
    try {
      setVersions(await tauriContent.versions(active.id, hit.id));
    } catch (err) {
      setVersionsError(errorText(err, 'Could not read this project’s versions.'));
    } finally {
      setVersionsLoading(false);
    }
  };

  const install = async (hit: ContentSearchHitDto, version: ContentVersionDto | null) => {
    if (!backend || !stopped) return;
    const jobId = `content-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setInstalling(hit.id);
    setProgress(0);
    setProgressStage('queued');
    const off = await onJobProgress(jobId, (payload) => {
      setProgress(payload.progress);
      setProgressStage(payload.stage ?? 'working');
    });
    try {
      const result = await tauriContent.install(active.id, hit.id, version?.id ?? null, hit.name, jobId);
      pushToast(`Installed ${result.installed} file${result.installed === 1 ? '' : 's'} from ${hit.name}. Restart the server to load it.`, 'ok');
      for (const warning of result.warnings.slice(0, 3)) pushToast(warning, 'err');
      setSelected(null);
      await load();
    } catch (err) {
      pushToast(errorText(err, 'Content install failed.'), 'err');
    } finally {
      off();
      setInstalling(null);
      setProgress(null);
      setProgressStage('');
    }
  };

  const toggle = (item: ContentItemDto) => {
    if (!backend) return;
    void tauriContent.toggle(active.id, item.fileName, !item.enabled)
      .then((rows) => {
        setItems(rows);
        pushToast(`${item.fileName} ${item.enabled ? 'disabled' : 'enabled'}. Restart the server to apply.`, 'ok');
      })
      .catch((err: unknown) => pushToast(errorText(err, 'Could not change the file state.'), 'err'));
  };

  const remove = (item: ContentItemDto) => {
    if (!backend) return;
    void tauriContent.remove(active.id, item.fileName)
      .then((rows) => {
        setItems(rows);
        pushToast(`${item.fileName} removed.`, 'ok');
      })
      .catch((err: unknown) => pushToast(errorText(err, 'Could not remove the file.'), 'err'));
  };

  const enabledCount = useMemo(() => items.filter((item) => item.enabled).length, [items]);

  if (!backend) {
    return <Empty title="Content management needs the desktop backend." body="Start the Electron app to install, enable or remove mods and plugins." />;
  }

  if (active.loader === 'Vanilla') {
    return <Empty title="Vanilla servers do not load mods or plugins." body="Create a Fabric, Forge, NeoForge or Paper server to manage content. Datapacks are not part of this tab yet." />;
  }

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={kind === 'plugin' ? 'blue' : 'green'}>{kind === 'plugin' ? 'Plugins' : 'Mods'}</Badge>
          <span className="text-sm font-medium">{enabledCount} enabled · {items.length} total</span>
          <span className="text-xs text-zinc-500">Minecraft {active.mcVersion} · {active.loader}</span>
          <div className="ml-auto flex gap-1.5">
            <Button size="sm" variant="outline" onClick={() => { void load(); }} disabled={loading}>{loading ? 'Refreshing…' : '↻ Refresh'}</Button>
            <Button size="sm" variant="outline" onClick={() => {
              void tauriServers.openFolder(active.id, folder)
                .catch((err: unknown) => pushToast(errorText(err, 'Could not open the folder.'), 'err'));
            }}>Open folder</Button>
          </div>
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          Enable/disable renames the jar into <code>{folder}-disabled/</code>; removal is permanent and requires a stopped server.
          {!stopped && <span className="ml-1 text-amber-300">Stop the server to install or remove files.</span>}
        </p>
      </Card>

      {progress !== null && (
        <Card>
          <ProgressBar value={progress} />
          <p className="mt-1 text-xs text-zinc-400">{progress}% · {progressStage}</p>
        </Card>
      )}

      {error && <p role="alert" className="rounded border border-red-800 bg-red-950/60 px-3 py-2 text-xs text-red-200">{error}</p>}

      <Card>
        <div className="flex flex-wrap gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
            placeholder={`Search Modrinth ${kind === 'plugin' ? 'plugins' : 'mods'} for ${active.mcVersion}…`}
            className={`${inputCls} max-w-md`}
          />
          <Button onClick={() => { void search(); }} disabled={searching}>{searching ? 'Searching…' : 'Search Modrinth'}</Button>
          {hits.length > 0 && <span className="self-center text-xs text-zinc-500">{totalHits.toLocaleString()} results · compatible versions only</span>}
        </div>

        {hits.length > 0 && (
          <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
            {hits.map((hit) => (
              <div key={hit.id} className="rounded border border-zinc-800 bg-zinc-950 p-3">
                <div className="flex items-start gap-2">
                  {hit.iconUrl
                    ? <img src={hit.iconUrl} alt="" className="h-9 w-9 rounded object-cover" />
                    : <span className="text-2xl">{kind === 'plugin' ? '🔌' : '🧩'}</span>}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{hit.name}</p>
                    <p className="truncate text-xs text-zinc-500">{hit.author} · {downloadsLabel(hit.downloads)} downloads</p>
                    <p className="mt-1 line-clamp-2 text-xs text-zinc-400">{hit.summary}</p>
                  </div>
                </div>
                <div className="mt-2 flex justify-end">
                  <Button size="sm" disabled={!stopped || installing !== null} title={stopped ? 'Choose a version' : 'Stop the server first'} onClick={() => { void openVersions(hit); }}>Choose version…</Button>
                </div>
              </div>
            ))}
          </div>
        )}
        {hits.length === 0 && query !== '' && !searching && (
          <p className="mt-3 text-xs text-zinc-500">No compatible {kind === 'plugin' ? 'plugins' : 'mods'} matched. Try a different search.</p>
        )}
      </Card>

      <div className="mc-table overflow-x-auto">
        <table>
          <thead className="bg-zinc-900 text-xs uppercase text-zinc-500">
            <tr><th className="px-3 py-2">File</th><th className="px-3 py-2">Project</th><th className="px-3 py-2">Version</th><th className="px-3 py-2">Size</th><th className="px-3 py-2">State</th><th className="px-3 py-2">Actions</th></tr>
          </thead>
          <tbody>
            {items.length === 0 && !loading && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-xs text-zinc-500">No {folder} installed yet. Search Modrinth above or drop jars into the {folder} folder.</td></tr>
            )}
            {items.map((item) => (
              <tr key={item.fileName} className="border-t border-zinc-800 hover:bg-zinc-900/60">
                <td className="px-3 py-2">
                  <p className="font-mono text-xs">{item.fileName}</p>
                  {item.title && <p className="text-xs text-zinc-500">{item.title}</p>}
                </td>
                <td className="px-3 py-2 text-xs text-zinc-400">{item.projectId ?? 'manual'}</td>
                <td className="px-3 py-2 text-xs text-zinc-400">{item.versionNumber ?? '—'}</td>
                <td className="px-3 py-2 text-xs text-zinc-400">{sizeLabel(item.sizeBytes)}</td>
                <td className="px-3 py-2">{item.enabled ? <Badge tone="green">enabled</Badge> : <Badge tone="amber">disabled</Badge>}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="outline" onClick={() => toggle(item)}>{item.enabled ? 'Disable' : 'Enable'}</Button>
                    <Button size="sm" variant="outline" disabled={!stopped} title={stopped ? 'Remove the file' : 'Stop the server first'} onClick={() => setRemoveTarget(item)}>Remove</Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Card>
        <p className="text-xs text-zinc-500">
          Changes apply on the next start. Keep a backup before large updates: <button className="underline" onClick={() => go('backups')}>open Backups</button>.
        </p>
      </Card>

      <Modal open={!!selected} title={`${selected?.name ?? 'Project'} — versions`} onClose={() => setSelected(null)}>
        {versionsLoading && <p className="text-xs text-zinc-500">Loading compatible versions…</p>}
        {versionsError && <p role="alert" className="text-xs text-red-300">{versionsError}</p>}
        {!versionsLoading && !versionsError && versions.length === 0 && (
          <p className="text-xs text-zinc-500">No version supports Minecraft {active.mcVersion} on {active.loader}.</p>
        )}
        <div className="mt-2 max-h-80 space-y-2 overflow-y-auto thin-scroll">
          {versions.map((version) => (
            <div key={version.id} className="rounded border border-zinc-800 bg-zinc-950 p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm">{version.name}</p>
                  <p className="text-xs text-zinc-500">{version.fileName} · {sizeLabel(version.fileSize)} · {version.gameVersions.slice(0, 4).join(', ')}</p>
                  {version.dependencies.filter((dep) => dep.type === 'required').length > 0 && (
                    <p className="text-xs text-zinc-500">{version.dependencies.filter((dep) => dep.type === 'required').length} required dependencies will be installed.</p>
                  )}
                </div>
                <Button size="sm" disabled={!stopped || installing !== null} onClick={() => { if (selected) void install(selected, version); }}>
                  {installing === selected?.id ? 'Installing…' : 'Install'}
                </Button>
              </div>
            </div>
          ))}
        </div>
        {selected && (
          <div className="mt-3 flex justify-end">
            <Button variant="ghost" onClick={() => { void install(selected, null); }} disabled={!stopped || installing !== null || versionsLoading}>
              Install latest compatible
            </Button>
          </div>
        )}
      </Modal>

      <Confirm
        open={!!removeTarget}
        title={`Remove "${removeTarget?.fileName}"?`}
        message={<p>The jar is deleted from disk. This cannot be undone; take a backup first if unsure.</p>}
        confirmLabel="Remove file"
        onConfirm={() => { if (removeTarget) remove(removeTarget); }}
        onClose={() => setRemoveTarget(null)}
      />

      {installing && progress === null && (
        <p className="text-xs text-zinc-500">Installing {installing}…</p>
      )}
    </div>
  );
}
