// Create step 3 — configure server name/target/version/loader/Java/EULA and start install (WP-6.5).
import { Badge, Button, Card, CardTitle, Field, inputCls } from '../../components/ui';
import type {
  CurseForgeArchiveInspection,
  CurseForgeProjectVersionDto,
  LoaderChoiceDto,
  ModrinthInstallLoader,
  ModrinthModpackDto,
  ModrinthProjectVersionDto,
  PipelineFileChoice,
  PipelinePreviewDto,
} from '../../tauri';
import type { Modpack } from '../../types';
import { CatalogueFields, RamPortFields, type CatalogueFieldsProps, type RamPortFieldsProps } from './ConfigureFields';
import { JavaSection, type JavaSectionProps } from './JavaSection';
import { PipelineReview } from './PipelineReview';
import { MODRINTH_INSTALLER_LOADER_NAMES, MODRINTH_LOADER_NAMES, cfInstallable, type Kind, type ModrinthLoaderOption } from './helpers';

export interface ModrinthConfigureState {
  pack: ModrinthModpackDto | null;
  versions: ModrinthProjectVersionDto[];
  selectedVersionId: string;
  onVersionChange: (versionId: string) => void;
  versionsLoading: boolean;
  versionsError: string;
  onRetryVersions: () => void;
  selectedVersion: ModrinthProjectVersionDto | null;
  installMc: string;
  onInstallMcChange: (value: string) => void;
  installLoader: ModrinthInstallLoader | '';
  onInstallLoaderChange: (value: string) => void;
  loaderOptions: ModrinthLoaderOption[];
  vanillaVersions: { id: string; versionType: string }[];
  supportedGameVersions: string[];
  buildChoices: LoaderChoiceDto[];
  buildLoading: boolean;
  buildError: string;
  buildUnavailable: boolean;
  buildMc: string;
  buildVersionId: string;
  selectedLoaderChoice: LoaderChoiceDto | null;
  onRetryBuilds: () => void;
  onChangePack: () => void;
}

export interface StepConfigureProps {
  hasBackend: boolean;
  kind: Kind;
  title: string;
  cfInspection: CurseForgeArchiveInspection | null;
  /**
   * The CurseForge version the user chose, when the one-click path is in use.
   *
   * Separate from `cfInspection` because they describe different things: the inspection describes a locally staged ZIP,
   * while this describes a published file selected from the API. In one-click mode there is no ZIP at all, so the panel
   * must read its loader/MC from here — otherwise it shows the previous browse's ZIP, which is how a user who picked v2.9
   * saw v2.9.3 on screen.
   */
  cfChosenVersion: CurseForgeProjectVersionDto | null;
  modrinth: ModrinthConfigureState | null;
  mockPack: Modpack | null;
  packVer: number;
  onPackVerChange: (index: number) => void;
  onChangeMockPack: () => void;
  catalogue: CatalogueFieldsProps;
  ramPort: RamPortFieldsProps;
  java: JavaSectionProps;
  name: string;
  onNameChange: (value: string) => void;
  pipeline: {
    preview: PipelinePreviewDto;
    decisions: PipelinePreviewDto['plan']['fileDecisions'];
    fileChoices: Record<string, PipelineFileChoice>;
    choicePage: number;
    onChoice: (path: string, choice: PipelineFileChoice) => void;
    onPageChange: (page: number) => void;
  } | null;
  eula: boolean;
  onEulaChange: (value: boolean) => void;
  backLabel: string;
  backDisabled: boolean;
  onBack: () => void;
  installDisabled: boolean;
  installLabel: string;
  onInstall: () => void;
}

/**
 * What the install will actually use.
 *
 * Two different sources, and they must not be confused: a chosen API version (one-click project mode) or a staged ZIP
 * (local import). Reading only the ZIP is what made a chosen v2.9 display as v2.9.3 — the stale ZIP from an earlier browse
 * won over the user's actual choice.
 */
function CurseforgeTarget(props: { inspection: CurseForgeArchiveInspection | null; chosen: CurseForgeProjectVersionDto | null }) {
  if (props.chosen !== null) {
    return (
      <div className="mb-3 rounded border border-zinc-800 bg-zinc-950 p-3">
        <p className="text-sm font-medium">
          {props.chosen.hasServerPack ? 'Selected server pack' : 'Selected client pack (manifest)'}
        </p>
        <p className="mt-1 text-xs text-zinc-300">
          {props.chosen.displayName}
          {props.chosen.minecraftVersion !== null ? ` · Minecraft ${props.chosen.minecraftVersion}` : ''}
          {props.chosen.loader !== null ? ` · ${props.chosen.loader}` : ''}
        </p>
        {!props.chosen.hasServerPack && (
          <p className="mt-1 text-xs text-amber-300">
            This version has no server pack. Its mods are resolved from the client manifest, and client-only mods are
            skipped — pick a version marked "server pack" if the result misbehaves.
          </p>
        )}
      </div>
    );
  }
  if (props.inspection === null) return null;
  return (
    <div className="mb-3 rounded border border-zinc-800 bg-zinc-950 p-3">
      <p className="text-sm font-medium">
        {props.inspection.classification === 'clientExport' ? 'Detected client pack (manifest)' : 'Detected server pack'}
      </p>
      <p className="mt-1 text-xs text-zinc-300">
        Minecraft {props.inspection.minecraftVersion} · {props.inspection.loader} {props.inspection.loaderVersion}
      </p>
      <p className="mt-1 text-xs text-zinc-500">
        A new server folder will be created. The importer will not run scripts from the archive.
      </p>
    </div>
  );
}

function ModrinthTarget({ state }: { state: ModrinthConfigureState }) {
  const selected = state.selectedVersion;
  return (
    <div className="mb-3 rounded border border-zinc-800 bg-zinc-950 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {state.pack?.iconUrl
          ? <img src={state.pack.iconUrl} alt="" className="h-8 w-8 rounded object-cover" />
          : <span className="text-xl">💠</span>}
        <strong className="text-sm">{state.pack?.name}</strong>
        {state.versions.length > 0 && (
          <select
            aria-label={`Select ${state.pack?.name} version`}
            value={state.selectedVersionId}
            onChange={(event) => state.onVersionChange(event.target.value)}
            className={`${inputCls} w-auto`}
            disabled={state.versionsLoading}
          >
            {state.versions.map((version) => (
              <option key={version.id} value={version.id}>
                {version.name} · {version.versionNumber} · MC {version.gameVersions.join(', ')} · {version.loaders.join(', ')}
              </option>
            ))}
          </select>
        )}
      </div>
      {state.versionsLoading && <p role="status" className="mt-2 text-xs text-zinc-400">Loading exact Modrinth versions…</p>}
      {state.versionsError && (
        <p role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-red-300">
          <span>Modrinth version error: {state.versionsError}</span>
          <Button size="sm" variant="secondary" onClick={state.onRetryVersions}>Retry</Button>
        </p>
      )}
      {!state.versionsLoading && !state.versionsError && state.versions.length === 0 && (
        <p role="status" className="mt-2 text-xs text-zinc-400">No Modrinth versions match the selected game version and loader filters.</p>
      )}
      {selected && (
        <>
          <p className="mt-1 text-xs text-zinc-500">
            Exact version ID: {selected.id} · MC {selected.gameVersions.join(', ')} · {selected.loaders.join(', ')}
          </p>
          <p className="mt-1 text-xs text-zinc-300">
            Server target: Minecraft {state.installMc || 'choose a supported game version'} · {state.installLoader ? MODRINTH_LOADER_NAMES[state.installLoader] : 'choose a supported loader'}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-400">
            Changelog ({selected.versionNumber}): {selected.changelog || 'No changelog provided.'}
          </p>
          {selected.files[0] && (
            <p className="mt-1 text-xs text-zinc-500">Primary file: {selected.files.find((file) => file.primary)?.filename ?? selected.files[0].filename}</p>
          )}
        </>
      )}
      <button className="mt-1 text-xs text-emerald-400 underline" onClick={state.onChangePack}>Change pack</button>
    </div>
  );
}

export function StepConfigure(props: StepConfigureProps) {
  const mr = props.modrinth;
  return (
    <Card>
      <CardTitle>{props.title}</CardTitle>
      {props.hasBackend && props.kind === 'curseforge' && (props.cfChosenVersion !== null || (props.cfInspection !== null && cfInstallable(props.cfInspection))) && (
        <CurseforgeTarget inspection={props.cfInspection} chosen={props.cfChosenVersion} />
      )}
      {props.hasBackend && props.kind === 'modrinth' && mr && mr.pack && <ModrinthTarget state={mr} />}
      {props.mockPack && (
        <div className="mb-3 rounded border border-zinc-800 bg-zinc-950 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xl">{props.mockPack.icon}</span>
            <strong className="text-sm">{props.mockPack.name}</strong>
            <select aria-label="Pack version" value={props.packVer} onChange={(event) => props.onPackVerChange(Number(event.target.value))} className={`${inputCls} w-auto`}>
              {props.mockPack.packVersions.map((version, index) => <option key={version.v} value={index}>{version.v} · MC {version.mc} · {version.loader}</option>)}
            </select>
          </div>
          <p className="mt-1 text-xs text-zinc-500">Changelog ({props.mockPack.packVersions[props.packVer].v}): {props.mockPack.packVersions[props.packVer].changelog}</p>
          <p className="mt-1 text-xs text-zinc-500">MC + loader resolved read-only: {props.mockPack.packVersions[props.packVer].mc} / {props.mockPack.packVersions[props.packVer].loader}</p>
          <button className="mt-1 text-xs text-emerald-400 underline" onClick={props.onChangeMockPack}>Change pack</button>
        </div>
      )}
      {props.pipeline && (
        <PipelineReview
          preview={props.pipeline.preview}
          decisions={props.pipeline.decisions}
          fileChoices={props.pipeline.fileChoices}
          choicePage={props.pipeline.choicePage}
          onChoice={props.pipeline.onChoice}
          onPageChange={props.pipeline.onPageChange}
        />
      )}
      <div className="mc-create-form-grid grid gap-3">
        <Field label="Server name (unique)">
          <input aria-label="Server name" value={props.name} onChange={(event) => props.onNameChange(event.target.value)} className={inputCls} />
        </Field>
        {props.hasBackend && props.kind === 'curseforge' && props.cfChosenVersion !== null && (
          <Field label={props.cfChosenVersion.hasServerPack ? 'Selected version (server pack)' : 'Selected version (client pack)'}>
            <input
              readOnly
              // Reflects the CHOSEN version, not a stale ZIP inspection. This field is what the user reads to confirm the
              // install will match their selection, so showing the previous browse's values here is actively misleading.
              value={[
                props.cfChosenVersion.minecraftVersion !== null ? `Minecraft ${props.cfChosenVersion.minecraftVersion}` : null,
                props.cfChosenVersion.loader,
              ].filter((part) => part !== null).join(' · ')}
              className={`${inputCls} opacity-80`}
            />
          </Field>
        )}
        {props.hasBackend && props.kind === 'curseforge' && props.cfChosenVersion === null && props.cfInspection && cfInstallable(props.cfInspection) && (
          <Field label="Imported Minecraft version and loader">
            <input
              readOnly
              value={`Minecraft ${props.cfInspection.minecraftVersion} · ${props.cfInspection.loader} ${props.cfInspection.loaderVersion}`}
              className={`${inputCls} opacity-80`}
            />
          </Field>
        )}
        {props.hasBackend && props.kind === 'modrinth' && mr?.selectedVersion && (
          <>
            <Field
              label="Minecraft game version"
              hint={`Choose a release declared by exact pack version ${mr.selectedVersion.versionNumber}.`}
            >
              <select
                aria-label="Modrinth pack Minecraft game version"
                value={mr.installMc}
                onChange={(event) => mr.onInstallMcChange(event.target.value)}
                className={inputCls}
                disabled={props.catalogue.versionsLoading || mr.vanillaVersions.length === 0}
              >
                <option value="" disabled>Choose a supported game version</option>
                {mr.selectedVersion.gameVersions.map((version) => {
                  const supported = mr.vanillaVersions.some((candidate) => candidate.id === version && candidate.versionType === 'release');
                  return (
                    <option key={version} value={version} disabled={!supported}>
                      {version}{supported ? '' : ' — unsupported by the server installer'}
                    </option>
                  );
                })}
              </select>
              {props.catalogue.versionsLoading && <p role="status" className="mt-1 text-xs text-zinc-500">Checking supported Minecraft releases…</p>}
              {!props.catalogue.versionsLoading && mr.vanillaVersions.length === 0 && (
                <p role="alert" className="mt-1 text-xs text-red-300">
                  {props.catalogue.versionsError || 'Minecraft release metadata is unavailable; this pack cannot be installed right now.'}
                </p>
              )}
              {!props.catalogue.versionsLoading && mr.vanillaVersions.length > 0 && mr.supportedGameVersions.length === 0 && (
                <p role="status" className="mt-1 text-xs text-amber-300">
                  This exact Modrinth version has no Minecraft release supported by the server installer.
                </p>
              )}
            </Field>
            <Field label="Dedicated server loader" hint="Only Vanilla, Fabric, Forge, and NeoForge can be installed for a new Modrinth server.">
              <select
                aria-label="Modrinth pack dedicated server loader"
                value={mr.installLoader}
                onChange={(event) => mr.onInstallLoaderChange(event.target.value)}
                className={inputCls}
                disabled={mr.buildLoading || mr.loaderOptions.length === 0}
              >
                <option value="" disabled>Choose a supported server loader</option>
                {mr.loaderOptions.map((option) => {
                  const installerLoader = option.loader ? MODRINTH_INSTALLER_LOADER_NAMES[option.loader] : null;
                  const providerBuildAvailable = installerLoader !== null && mr.buildChoices.some((choice) => choice.loader === installerLoader);
                  const noProviderBuild = Boolean(
                    option.loader && mr.buildMc === mr.installMc && mr.buildVersionId === mr.selectedVersionId
                    && !mr.buildLoading && !mr.buildError && !providerBuildAvailable,
                  );
                  return (
                    <option key={option.id} value={option.loader ?? `unsupported:${option.id}`} disabled={!option.loader || noProviderBuild}>
                      {option.label}{noProviderBuild ? ` — no verified server build for ${mr.installMc}` : ''}
                    </option>
                  );
                })}
              </select>
              {mr.buildLoading && <p role="status" className="mt-1 text-xs text-zinc-500">Verifying server loader builds for Minecraft {mr.installMc}…</p>}
              {mr.buildError && (
                <p role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-xs text-red-300">
                  <span>Could not verify loader support: {mr.buildError}</span>
                  <Button size="sm" variant="secondary" onClick={mr.onRetryBuilds}>Retry</Button>
                </p>
              )}
              {mr.buildUnavailable && (
                <p role="status" className="mt-1 text-xs text-amber-300">
                  {mr.loaderOptions.find((option) => option.loader === mr.installLoader)?.label ?? 'The selected loader'} has no provider-verified server build for Minecraft {mr.installMc}.
                </p>
              )}
              {!mr.buildLoading && mr.loaderOptions.length > 0 && mr.loaderOptions.every((option) => option.loader === null) && (
                <p role="status" className="mt-1 text-xs text-amber-300">
                  This exact version declares only unsupported loaders: {mr.loaderOptions.map((option) => option.label).join(', ')}.
                </p>
              )}
            </Field>
          </>
        )}
        <CatalogueFields {...props.catalogue} />
        <RamPortFields {...props.ramPort} />
        <JavaSection {...props.java} />
      </div>
      <label className="mt-3 flex items-start gap-2 rounded border border-zinc-800 bg-zinc-950 p-3 text-sm">
        <input type="checkbox" checked={props.eula} onChange={(event) => props.onEulaChange(event.target.checked)} className="mt-1" />
        <span>
          I accept the <a className="underline" href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">Minecraft EULA</a>.
          <span className="block text-xs text-zinc-500">Required. The app never accepts it for you, and Start stays blocked until checked.</span>
        </span>
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="ghost" disabled={props.backDisabled} onClick={props.onBack}>{props.backLabel}</Button>
        <Button disabled={props.installDisabled} onClick={props.onInstall}>{props.installLabel}</Button>
      </div>
    </Card>
  );
}

export type { PipelinePreviewDto };
