// Create configure — version/loader catalogue, RAM and port fields (extracted from Create.tsx, WP-6.5).
import { Badge, Button, Field, inputCls } from '../../components/ui';
import type { LoaderChoiceDto, MinecraftVersionDto } from '../../tauri';
import { MC_VERSIONS } from '../../mocks/data';
import type { Kind } from './helpers';

interface CatalogueFieldsProps {
  kind: Kind;
  hasBackend: boolean;
  vanillaMc: string;
  onVanillaMcChange: (value: string) => void;
  configureVersions: MinecraftVersionDto[];
  filteredConfigureVersions: MinecraftVersionDto[];
  versionsLoading: boolean;
  versionsError: string;
  versionsRetry: number;
  onRetryVersions: () => void;
  showSnapshots: boolean;
  onShowSnapshotsChange: (value: boolean) => void;
  snapshotStale: boolean;
  selectedVersionDto: MinecraftVersionDto | null;
  loaderChoices: LoaderChoiceDto[];
  displayedLoaderChoices: LoaderChoiceDto[];
  selectedLoaderChoice: LoaderChoiceDto | null;
  serverLoader: string;
  loaderLoading: boolean;
  loaderError: string;
  loaderToggleStale: boolean;
  showAllBuilds: boolean;
  onShowAllBuildsChange: (value: boolean) => void;
  onSelectLoaderChoice: (choice: LoaderChoiceDto) => void;
  onRetryLoaders: () => void;
}

export function CatalogueFields(props: CatalogueFieldsProps) {
  const displayed = props.displayedLoaderChoices;
  const selectedIndex = props.selectedLoaderChoice?.loader === props.serverLoader
    ? displayed.indexOf(props.selectedLoaderChoice)
    : -1;
  return (
    <>
      {props.kind === 'vanilla' && (
        <Field label="Minecraft version" hint={props.hasBackend ? (props.showSnapshots ? 'Releases and snapshots. Snapshots install through the same verified Mojang artifact path.' : 'Releases by default. Enable snapshots to install pre-releases and weeklies.') : undefined}>
          {props.hasBackend ? (
            <>
              <select
                aria-label="Minecraft version"
                value={props.vanillaMc}
                onChange={(event) => props.onVanillaMcChange(event.target.value)}
                className={inputCls}
                disabled={props.versionsLoading || props.configureVersions.length === 0}
              >
                {props.filteredConfigureVersions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.id}{version.versionType !== 'release' ? ' — Snapshot' : ''}
                  </option>
                ))}
              </select>
              <label className="mt-2 flex items-center gap-2 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={props.showSnapshots}
                  onChange={(event) => props.onShowSnapshotsChange(event.target.checked)}
                  className="h-3.5 w-3.5"
                />
                Show snapshots
              </label>
              {props.versionsLoading && <p className="mt-1 text-xs text-zinc-500">Loading provider-supported releases…</p>}
              {props.versionsError && (
                <p role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-xs text-amber-300">
                  <span>{props.versionsError}</span>
                  <Button size="sm" variant="secondary" disabled={props.versionsLoading} onClick={props.onRetryVersions}>
                    Retry catalogue
                  </Button>
                </p>
              )}
              {props.snapshotStale && props.selectedVersionDto && (
                <p role="status" className="mt-1 text-xs text-amber-300">
                  {props.selectedVersionDto.id} is a snapshot and is hidden while snapshots are off. Enable snapshots or choose a release before installing.
                </p>
              )}
            </>
          ) : (
            <select aria-label="Minecraft version" value={props.vanillaMc} onChange={(event) => props.onVanillaMcChange(event.target.value)} className={inputCls}>
              {MC_VERSIONS.map((version) => <option key={version}>{version}</option>)}
            </select>
          )}
        </Field>
      )}
      {props.hasBackend && props.kind === 'vanilla' && (
        <Field label="Server loader and version" hint="Stable builds first. Enable all builds to install provider-verified non-stable versions.">
          <select
            aria-label="Server loader and version"
            value={selectedIndex >= 0 ? String(selectedIndex) : ''}
            onChange={(event) => {
              const choice = displayed[Number(event.target.value)];
              if (choice) props.onSelectLoaderChoice(choice);
            }}
            className={inputCls}
            disabled={props.loaderLoading || displayed.length === 0}
          >
            {displayed.map((choice) => (
              <option key={choice.loader + ':' + (choice.version ?? '')} value={displayed.indexOf(choice)}>{choice.label}</option>
            ))}
          </select>
          <label className="mt-2 flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={props.showAllBuilds}
              onChange={(event) => props.onShowAllBuildsChange(event.target.checked)}
              className="h-3.5 w-3.5"
            />
            Show all builds
          </label>
          {props.loaderLoading && <p className="mt-1 text-xs text-zinc-500">Resolving compatible loader versions…</p>}
          {props.loaderError && (
            <p role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-xs text-amber-300">
              <span>{props.loaderError}</span>
              <Button size="sm" variant="secondary" disabled={props.loaderLoading} onClick={props.onRetryLoaders}>
                Retry loaders
              </Button>
            </p>
          )}
          {props.loaderToggleStale && props.selectedLoaderChoice && (
            <p role="status" className="mt-1 text-xs text-amber-300">
              {props.selectedLoaderChoice.label} is hidden while all builds are off. Enable all builds or choose a stable version before installing.
            </p>
          )}
        </Field>
      )}
    </>
  );
}

interface RamPortFieldsProps {
  hasBackend: boolean;
  ram: number;
  onRamChange: (value: number) => void;
  recommended: number;
  ramBelow: boolean;
  freeWarn: boolean;
  ramFreeEstimate: number;
  port: number;
  onPortChange: (value: number) => void;
  portChecking: boolean;
  portOutOfRange: boolean;
  portConflict: boolean;
  portUnavailable: boolean;
  portBlocked: boolean;
  portSuggested: number | null;
  onUseSuggestedPort: () => void;
}

export function RamPortFields(props: RamPortFieldsProps) {
  return (
    <>
      <Field label={`RAM: ${props.ram} MB (recommended ${props.recommended} MB)`} hint={props.freeWarn ? `Warning: exceeds free RAM estimate (${props.ramFreeEstimate} MB).` : props.ramBelow ? 'Below recommended — large packs may crash.' : 'Looks good.'}>
        <input type="range" aria-label="Allocated RAM in MB" min={1024} max={16384} step={256} value={props.ram} onChange={(event) => props.onRamChange(Number(event.target.value))} className="ram-slider" />
        {props.ramBelow && <span className="mt-1 inline-block"><Badge tone="amber">below recommended</Badge></span>}
      </Field>
      <Field label="Port" hint={props.hasBackend
        ? props.portOutOfRange
          ? 'Port must be between 1 and 65535.'
          : props.portConflict
            ? 'Another saved server uses this port.'
            : props.portChecking
              ? 'Checking port availability…'
              : props.portUnavailable
                ? `Port ${props.port} is not available on this machine.${props.portSuggested ? ` Suggested: ${props.portSuggested}.` : ''}`
                : 'Port is available (checked before publish).'
        : props.portConflict ? 'Conflict: another server already uses this port (mock check).' : 'Port looks free (mock check).'}>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            aria-label="Server port"
            min={1}
            max={65535}
            value={props.port}
            onChange={(event) => props.onPortChange(Number(event.target.value))}
            className={`${inputCls} w-32`}
            aria-invalid={props.portBlocked}
          />
          {props.portSuggested !== null && (
            <Button size="sm" variant="secondary" onClick={props.onUseSuggestedPort}>
              Use suggested port {props.portSuggested}
            </Button>
          )}
        </div>
        {(props.portOutOfRange || props.portConflict || props.portUnavailable) && (
          <p role="alert" className="mt-1 text-xs text-red-300">
            {props.portOutOfRange
              ? 'Enter a port between 1 and 65535.'
              : props.portConflict
                ? 'Choose a port no saved server is using.'
                : 'The backend could not bind this port. Pick the suggested port or another free one.'}
          </p>
        )}
      </Field>
    </>
  );
}

export type { CatalogueFieldsProps, RamPortFieldsProps };
