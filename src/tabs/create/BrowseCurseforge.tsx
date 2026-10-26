// Create step 2 (CurseForge) — choose/inspect a staged SERVER ZIP (extracted from Create.tsx, WP-6.5).
import { Badge, Button, Card, CardTitle } from '../../components/ui';
import type { CurseForgeArchiveInspection, CurseForgeStagedZip } from '../../tauri';
import { cfInstallable, formatBytes } from './helpers';

interface BrowseCurseforgeProps {
  zips: CurseForgeStagedZip[];
  selectedName: string;
  inspection: CurseForgeArchiveInspection | null;
  loading: boolean;
  inspecting: boolean;
  error: string;
  onRefresh: () => void;
  onBrowse: () => void;
  onSelect: (name: string) => void;
  onInspect: () => void;
  onContinue: () => void;
  onBack: () => void;
}

export function BrowseCurseforge(props: BrowseCurseforgeProps) {
  const selected = props.inspection;
  return (
    <div className="space-y-3">
      <Card>
        <CardTitle>Choose a downloaded SERVER ZIP</CardTitle>
        <p className="text-xs text-zinc-400">
          The list contains completed ZIPs in app-managed CurseForge staging. Browse copies an external ZIP here without changing the original file.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={props.loading || props.inspecting} onClick={props.onRefresh}>
            {props.loading ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button size="sm" variant="secondary" disabled={props.loading || props.inspecting} onClick={props.onBrowse}>
            Browse for ZIP
          </Button>
        </div>
        {props.error && <p role="alert" className="mt-2 text-xs text-red-300">{props.error}</p>}
      </Card>
      {props.zips.length > 0 ? (
        <fieldset className="space-y-2">
          <legend className="sr-only">Available CurseForge ZIP files</legend>
          {props.zips.map((file) => (
            <label key={file.name} className={`flex cursor-pointer items-start gap-3 rounded border p-3 ${props.selectedName === file.name ? 'border-emerald-700 bg-emerald-950/20' : 'border-zinc-800 bg-zinc-950'}`}>
              <input
                type="radio"
                name="curseforge-zip"
                value={file.name}
                checked={props.selectedName === file.name}
                disabled={props.loading || props.inspecting}
                onChange={() => props.onSelect(file.name)}
                className="mt-1"
              />
              <span className="min-w-0 flex-1">
                <span className="block break-all text-sm font-medium">{file.name}</span>
                <span className="block text-xs text-zinc-500">
                  {formatBytes(file.size)} · {file.modifiedAt === null ? 'Modified time unavailable' : new Date(file.modifiedAt * 1000).toLocaleString()}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p role="status" className="text-sm text-zinc-500">
          {props.loading ? 'Scanning staged ZIPs…' : 'No completed ZIPs found. Open CurseForge or use Browse for ZIP.'}
        </p>
      )}
      {props.selectedName && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <CardTitle>Inspect selected archive</CardTitle>
              <p className="break-all text-xs text-zinc-400">{props.selectedName}</p>
            </div>
            <Button size="sm" disabled={props.inspecting} onClick={props.onInspect}>
              {props.inspecting ? 'Inspecting…' : 'Inspect ZIP'}
            </Button>
          </div>
          {selected && (
            <div className="mt-3 rounded border border-zinc-800 bg-zinc-950 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={selected.classification === 'supportedServerPack' ? 'green' : selected.classification === 'clientExport' ? 'amber' : 'red'}>
                  {selected.classification === 'supportedServerPack'
                    ? 'Supported server pack'
                    : selected.classification === 'clientExport'
                      ? 'Client pack — manifest install'
                      : 'Invalid or unsupported archive'}
                </Badge>
                {selected.minecraftVersion && <span className="text-xs text-zinc-300">Minecraft {selected.minecraftVersion}</span>}
                {selected.loader && <span className="text-xs text-zinc-300">{selected.loader} {selected.loaderVersion}</span>}
              </div>
              <p role="status" className="mt-2 text-sm text-zinc-300">{selected.reason}</p>
              {cfInstallable(selected) && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-zinc-500">
                    {selected.classification === 'clientExport'
                      ? 'Mods are resolved keylessly from manifest.json; client-only files are skipped. This ZIP is preserved unless automatic deletion is enabled.'
                      : 'This ZIP is preserved after installation unless automatic deletion is enabled in Settings.'}
                  </p>
                  <Button onClick={props.onContinue}>Continue to Configure →</Button>
                </div>
              )}
            </div>
          )}
        </Card>
      )}
      <Button variant="ghost" onClick={props.onBack}>← Back</Button>
    </div>
  );
}

export type { BrowseCurseforgeProps };
