// Pick a CurseForge modpack version, with the server-pack distinction made explicit.
//
// Why this exists: CurseForge installs previously had no version choice at all — the installer took the newest file. That
// is wrong for a server in two ways:
//
//  - Authors publish an OPTIONAL server pack beside the client pack, and the newest file frequently has none. The client
//    pack is a manifest whose mods must be resolved, and it contains client-only mods that must not run on a server.
//  - A pack can be actively maintained for one Minecraft version while old files remain the only ones with a server pack.
//
// So each row states whether a server pack exists, and the newest row that HAS one is marked as the recommended choice
// rather than silently assuming the newest row is best.
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/ui';
import { tauriCurseForge, type CurseForgeProjectVersionDto } from '../../tauri';

export interface CurseForgeVersionPickerProps {
  /** Project id or slug. */
  project: string | number;
  /** Currently chosen file id, so the picker survives a re-render. */
  selectedFileId: number | null;
  onChoose: (version: CurseForgeProjectVersionDto) => void;
  /** Callback for the surfaces that can only proceed once a version is chosen. */
  onCancel?: () => void;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(iso: string | null): string {
  if (iso === null || iso === '') return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}

export function CurseForgeVersionPicker(props: CurseForgeVersionPickerProps) {
  const [versions, setVersions] = useState<CurseForgeProjectVersionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const list = await tauriCurseForge.projectVersions(props.project);
        if (!cancelled) setVersions(list);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [props.project]);

  // The newest version that actually has a server pack is the safest default. Falling back to the newest version overall
  // is still better than no selection, because the user can see the badges and choose differently.
  const recommendedFileId = useMemo(() => {
    const withServerPack = versions.find((version) => version.hasServerPack);
    return withServerPack?.fileId ?? versions[0]?.fileId ?? null;
  }, [versions]);

  if (loading) {
    return <p className="text-xs text-zinc-400">Loading versions from CurseForge…</p>;
  }

  if (error !== null) {
    return (
      <div className="rounded border border-amber-800/60 bg-amber-950/30 p-2">
        <p className="text-xs text-amber-200">Could not list versions: {error}</p>
        <p className="mt-1 text-[11px] text-amber-200/70">
          Listing versions needs a CurseForge API key (Settings → CurseForge API key). You can still install from a
          server-pack ZIP you downloaded manually.
        </p>
      </div>
    );
  }

  if (versions.length === 0) {
    return <p className="text-xs text-zinc-400">This project has no published versions.</p>;
  }

  return (
    <div className="space-y-1">
      <p className="text-xs text-zinc-400">
        Choose a version. A <span className="font-semibold text-emerald-300">server pack</span> is the right choice for a
        server — it is ready to run. A client pack has to resolve its mods and includes client-only mods that should not run
        on a server.
      </p>
      <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto thin-scroll">
        {versions.map((version) => {
          const selected = props.selectedFileId === version.fileId;
          const recommended = version.fileId === recommendedFileId && version.hasServerPack;
          return (
            <li key={version.fileId}>
              <button
                type="button"
                onClick={() => props.onChoose(version)}
                className={`mc-btn w-full justify-start text-left ${selected ? 'mc-btn-default' : ''}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">
                    {version.displayName}
                    {recommended ? <span className="ml-2 text-[10px] uppercase text-emerald-300">recommended</span> : null}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-zinc-500">
                    {version.hasServerPack ? (
                      <span className="text-emerald-400">server pack</span>
                    ) : (
                      <span className="text-zinc-500">client pack only</span>
                    )}
                    {version.minecraftVersion !== null ? ` · MC ${version.minecraftVersion}` : ''}
                    {version.loader !== null ? ` · ${version.loader}` : ''}
                    {version.fileLength !== null ? ` · ${formatBytes(version.fileLength)}` : ''}
                    {version.publishedAt !== null ? ` · ${formatDate(version.publishedAt)}` : ''}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {props.onCancel !== undefined && (
        <div className="mt-2">
          <Button size="sm" variant="ghost" onClick={props.onCancel}>Cancel</Button>
        </div>
      )}
    </div>
  );
}
