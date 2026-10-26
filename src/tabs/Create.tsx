// Create wizard orchestrator (Phase 6 WP-6.3 flow fixes + WP-6.5 decomposition).
// Step UI, state hooks and install flows live in src/tabs/create/*; this file wires them together and
// owns the wizard-local state shared across steps (edition, name/RAM/port/EULA, local .mrpack).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Modpack, TabId } from '../types';
import { FREE_RAM_MB, modpacks } from '../mocks/data';
import { useStore } from '../store';
import { hasBackend, isDesktop, tauriModpackPipeline } from '../tauri';
import type { LocalMrpackSelection, PipelineLoaderPin, PipelineSourceRequest } from '../tauri';
import { CreateChrome } from './create/CreateChrome';
import { StepsType } from './create/StepsType';
import { StepsBrowse } from './create/StepsBrowse';
import { StepsConfigure } from './create/StepsConfigure';
import { StepsInstall } from './create/StepsInstall';
import { useCreateCatalog } from './create/useCreateCatalog';
import { useJavaSelection } from './create/useJavaSelection';
import { useModrinthBrowse } from './create/useModrinthBrowse';
import { useCurseForgeImport } from './create/useCreateCurseforgeImport';
import { usePipelineReview } from './create/usePipelineReview';
import { useInstallState } from './create/useInstallState';
import { usePipelineInstallFlow } from './create/usePipelineInstallFlow';
import { useServerInstallFlow } from './create/useServerInstallFlow';
import { useInstallReadiness } from './create/useInstallReadiness';
import { usePortAvailability } from './create/usePortAvailability';
import { useCreateWizardCleanup } from './create/useCreateWizardCleanup';
import {
  CURSEFORGE_AUTO_DELETE_KEY,
  cfInstallable,
  errorText,
  serverFromInstall,
  validatesMrpackFile,
  type Kind,
} from './create/helpers';

const javaView = (java: ReturnType<typeof useJavaSelection>) => ({
  selected: java.javaSelected,
  loading: java.javaLoading,
  installing: java.javaInstalling,
  override: java.javaOverride,
  path: java.javaPath,
});

export default function Create({ onExit }: { onExit: (next: TabId) => void }) {
  const { addServer, usedPorts, pushToast } = useStore();
  const [step, setStep] = useState(1);
  const [kind, setKind] = useState<Kind>('vanilla');
  const localMrpackInputRef = useRef<HTMLInputElement>(null);
  const curseforgeZipInputRef = useRef<HTMLInputElement>(null);
  const [localMrpack, setLocalMrpack] = useState<LocalMrpackSelection | null>(null);
  const localMrpackRef = useRef<LocalMrpackSelection | null>(null);
  const [autoDeleteCurseForgeZip] = useState(() => {
    try {
      return window.localStorage.getItem(CURSEFORGE_AUTO_DELETE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [pack, setPack] = useState<Modpack | null>(null);
  const [packVer, setPackVer] = useState(0);
  const [name, setName] = useState('My Server');
  const [ram, setRam] = useState(4096);
  const [port, setPort] = useState(25568);
  const [eula, setEula] = useState(false);

  const updateLocalMrpackSelection = (selection: LocalMrpackSelection | null): void => {
    localMrpackRef.current = selection;
    setLocalMrpack(selection);
  };

  const releaseLocalMrpackSelection = (selection = localMrpackRef.current): void => {
    if (!selection) return;
    if (hasBackend()) {
      void tauriModpackPipeline.releaseLocalMrpack(selection.sourceId).catch(() => undefined);
    }
    if (localMrpackRef.current?.sourceId === selection.sourceId) {
      localMrpackRef.current = null;
      setLocalMrpack(null);
    }
  };

  const pipeline = usePipelineReview({
    discardPreview: (previewId) => { void tauriModpackPipeline.discardPreview(previewId).catch(() => undefined); },
    onReleaseLocal: () => releaseLocalMrpackSelection(),
  });
  const install = useInstallState();
  install.pipelinePreviewRef.current = pipeline.pipelinePreview;
  install.installCleanupRef.current = { jobId: install.installJobId, installing: install.installing, kind };

  const catalogue = useCreateCatalog({ kind });
  const modrinth = useModrinthBrowse({
    step,
    kind,
    vanillaVersions: catalogue.vanillaVersions,
    catalogueVersionsLoading: catalogue.versionsLoading,
  });
  const curseforge = useCurseForgeImport({ kind, clearPipelineReview: pipeline.clearPipelineReview, pushToast });

  const configuredMcVersion = hasBackend() && kind === 'modrinth'
    ? modrinth.modrinthInstallMc || catalogue.vanillaMc
    : hasBackend() && kind === 'curseforge'
      ? curseforge.selectedCurseforgeInspection?.minecraftVersion ?? ''
      : kind !== 'vanilla' && pack ? pack.packVersions[packVer].mc : catalogue.vanillaMc;
  const java = useJavaSelection({ configuredMcVersion, pushToast });

  useCreateWizardCleanup({ localMrpackRef, pipelinePreviewRef: install.pipelinePreviewRef, installCleanupRef: install.installCleanupRef, installTimerRef: install.installTimerRef });
  const { portChecking, portConflict, portOutOfRange, portUnavailable, portBlocked, portSuggested, setPortCheck } = usePortAvailability(port, usedPorts);

  const results = useMemo(() => {
    if (hasBackend()) return [];
    let filtered = modpacks.filter((entry) => (modrinth.sourceTab === 'all' ? true : entry.source === modrinth.sourceTab));
    if (kind === 'curseforge') filtered = filtered.filter((entry) => entry.source === 'curseforge');
    if (kind === 'modrinth') filtered = filtered.filter((entry) => entry.source === 'modrinth');
    if (modrinth.q) filtered = filtered.filter((entry) => (entry.name + entry.author + entry.summary).toLowerCase().includes(modrinth.q.toLowerCase()));
    if (modrinth.mc !== 'Any') filtered = filtered.filter((entry) => entry.mcVersions.includes(modrinth.mc));
    if (modrinth.loader !== 'Any') filtered = filtered.filter((entry) => entry.loaders.includes(modrinth.loader));
    if (modrinth.sort === 'name') return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    return [...filtered].sort((a, b) => b.downloads - a.downloads);
  }, [modrinth.q, modrinth.sourceTab, modrinth.mc, modrinth.loader, kind, modrinth.sort]);

  const hasPackSelected = Boolean(pack || localMrpack)
    || (hasBackend() && Boolean(modrinth.selectedModrinthPack))
    || (hasBackend() && cfInstallable(curseforge.selectedCurseforgeInspection));
  const recommended = hasPackSelected ? 8192 : 4096;
  const ramBelow = ram < recommended;
  const freeWarn = ram > FREE_RAM_MB;

  const activePipelineSource = (): { request: PipelineSourceRequest; key: string } | null => {
    if (kind === 'curseforge') {
      if (curseforge.cfProjectId !== null && curseforge.cfProjectMeta) {
        return {
          request: { kind: 'curseforgeProject', projectId: curseforge.cfProjectId },
          key: `curseforge-project:${curseforge.cfProjectId}`,
        };
      }
      if (!curseforge.curseforgeSelectedName || !cfInstallable(curseforge.selectedCurseforgeInspection)) return null;
      return {
        request: { kind: 'curseForgeServerZip', zipName: curseforge.curseforgeSelectedName },
        key: `curseforge:${curseforge.curseforgeSelectedName}`,
      };
    }
    if (kind !== 'modrinth') return null;
    if (localMrpack) {
      return {
        request: { kind: 'localMrpack', sourceId: localMrpack.sourceId },
        key: `local:${localMrpack.sourceId}`,
      };
    }
    if (!modrinth.selectedModrinthPack || !modrinth.selectedModrinthVersion || !modrinth.modrinthInstallLoader
      || !modrinth.selectedModrinthLoaderChoice || !java.javaSelected) return null;
    const loaderKind: PipelineLoaderPin['kind'] = modrinth.modrinthInstallLoader === 'minecraft'
      ? 'vanilla'
      : modrinth.modrinthInstallLoader === 'neoforge'
        ? 'neoForge'
        : modrinth.modrinthInstallLoader;
    const loaderPin: PipelineLoaderPin = {
      kind: loaderKind,
      minecraftVersion: modrinth.modrinthInstallMc,
      loaderVersion: loaderKind === 'vanilla' ? null : modrinth.selectedModrinthLoaderChoice.version ?? null,
    };
    return {
      request: {
        kind: 'modrinthRemote',
        projectId: modrinth.selectedModrinthPack.id,
        versionId: modrinth.selectedModrinthVersion.id,
        loader: loaderPin,
        javaPath: java.javaSelected.path,
      },
      key: `remote:${modrinth.selectedModrinthPack.id}:${modrinth.selectedModrinthVersion.id}:${modrinth.modrinthInstallMc}:${loaderKind}:${loaderPin.loaderVersion}:${java.javaSelected.path}`,
    };
  };

  const pipelineFlow = usePipelineInstallFlow({
    step,
    setStep,
    kind,
    name,
    ram,
    port,
    eula,
    autoDeleteCurseForgeZip,
    localMrpack,
    modpackName: modrinth.selectedModrinthPack?.name ?? null,
    curseforgeSelectedName: curseforge.curseforgeSelectedName,
    activeSource: activePipelineSource,
    java: javaView(java),
    toServer: (dto, modpackLabel) => serverFromInstall(dto, recommended, modpackLabel),
    recommended,
    addServer,
    pushToast,
    state: install,
    pipeline,
    setModrinthInstallMc: modrinth.setModrinthInstallMc,
    setModrinthInstallLoader: modrinth.setModrinthInstallLoader,
    setVanillaMc: catalogue.setVanillaMc,
  });

  const serverFlow = useServerInstallFlow({
    kind,
    name,
    ram,
    port,
    eula,
    pack,
    packVer,
    recommended,
    catalogue: {
      vanillaMc: catalogue.vanillaMc,
      serverLoader: catalogue.serverLoader,
      selectedLoaderChoice: catalogue.selectedLoaderChoice,
      loaderLoading: catalogue.loaderLoading,
      versionsLoading: catalogue.versionsLoading,
      snapshotStale: catalogue.snapshotStale,
      loaderError: catalogue.loaderError,
      loaderToggleStale: catalogue.loaderToggleStale,
    },
    java: javaView(java),
    state: install,
    addServer,
    pushToast,
    setStep,
    portBlocked,
    portOutOfRange,
    portConflict,
    activeSource: activePipelineSource,
    pipeline,
    runPipelinePreview: () => pipelineFlow.runPipelinePreview(),
    installPipelinePreview: () => pipelineFlow.installPipelinePreview(),
  });

  const pickLocalMrpack = async (file?: File): Promise<void> => {
    try {
      // WP-6.3: validate the browser-upload path locally too (desktop pick is validated backend-side).
      if (file) {
        const invalid = validatesMrpackFile(file);
        if (invalid) {
          pushToast(invalid, 'err');
          return;
        }
      }
      const selection = isDesktop()
        ? await tauriModpackPipeline.pickLocalMrpack()
        : file
          ? await tauriModpackPipeline.uploadLocalMrpack(file)
          : null;
      if (!selection) return;
      pipeline.clearPipelineReview();
      updateLocalMrpackSelection(selection);
      modrinth.setSelectedModrinthPack(null);
      modrinth.setModrinthVersions([]);
      modrinth.setSelectedModrinthVersionId('');
      pipeline.setPipelinePreview(null);
      pipeline.setPipelinePreviewKey('');
      setKind('modrinth');
      setStep(2);
      await pipelineFlow.runPipelinePreview({
        request: { kind: 'localMrpack', sourceId: selection.sourceId },
        key: `local:${selection.sourceId}`,
      });
    } catch (error) {
      pushToast(errorText(error, 'Could not select a local .mrpack file.'), 'err');
    }
  };

  const pickPack = (modpack: Modpack): void => {
    setPack(modpack);
    setPackVer(0);
    modrinth.setSelectedModrinthPack(null);
    setKind(modpack.source);
    setRam(8192);
    setStep(3);
  };

  const pickModrinthPack = (modpack: NonNullable<typeof modrinth.selectedModrinthPack>): void => {
    pipeline.clearPipelineReview();
    setPack(null);
    modrinth.setSelectedModrinthPack(modpack);
    modrinth.setSelectedModrinthVersionId('');
    setKind('modrinth');
    setRam(8192);
    setStep(3);
  };

  const currentPipelineSource = activePipelineSource();
  const pipelinePreviewMatchesSource = Boolean(
    pipeline.pipelinePreview && currentPipelineSource && pipeline.pipelinePreviewKey === currentPipelineSource.key,
  );
  const currentPipelineDecisions = pipelinePreviewMatchesSource
    ? pipeline.pipelinePreview?.plan.fileDecisions ?? []
    : [];
  const readiness = useInstallReadiness({
    kind,
    name,
    hasBackend: hasBackend(),
    installing: install.installing,
    portBlocked,
    catalogue,
    java,
    modrinth,
    curseforge,
    pipeline,
    localMrpack,
    currentSource: currentPipelineSource,
  });

  return (
    <div className="mc-create-container mx-auto w-full min-w-0 max-w-4xl space-y-4">
      <CreateChrome
        step={step}
        localMrpackInputRef={localMrpackInputRef}
        curseforgeZipInputRef={curseforgeZipInputRef}
        onLocalMrpackFile={(file) => { void pickLocalMrpack(file); }}
        onCurseforgeZipFile={(file) => { void curseforge.browseCurseforgeZip(file); }}
      />

      {step === 1 && (
        <StepsType
          hasBackend={hasBackend()}
          kind={kind}
          catalogue={catalogue}
          curseforge={curseforge}
          modrinth={modrinth}
          pipeline={pipeline}
          setKind={setKind}
          setStep={setStep}
          setPack={setPack}
        />
      )}

      {step === 2 && (
        <StepsBrowse
          hasBackend={hasBackend()}
          kind={kind}
          catalogue={catalogue}
          modrinth={modrinth}
          curseforge={curseforge}
          localMrpack={localMrpack}
          installing={install.installing}
          results={results}
          localMrpackInputRef={localMrpackInputRef}
          curseforgeZipInputRef={curseforgeZipInputRef}
          onPickLocalMrpack={() => { void pickLocalMrpack(); }}
          onPickPack={pickPack}
          onPickModrinthPack={pickModrinthPack}
          setStep={setStep}
        />
      )}

      {step === 3 && (
        <StepsConfigure
          hasBackend={hasBackend()}
          kind={kind}
          pack={pack}
          packVer={packVer}
          name={name}
          ram={ram}
          port={port}
          eula={eula}
          recommended={recommended}
          ramBelow={ramBelow}
          freeWarn={freeWarn}
          portChecking={portChecking}
          portOutOfRange={portOutOfRange}
          portConflict={portConflict}
          portUnavailable={portUnavailable}
          portBlocked={portBlocked}
          portSuggested={portSuggested}
          installing={install.installing}
          catalogue={catalogue}
          modrinth={modrinth}
          curseforge={curseforge}
          java={java}
          pipeline={pipeline}
          pipelinePreviewMatchesSource={pipelinePreviewMatchesSource}
          currentPipelineDecisions={currentPipelineDecisions}
          installLabel={readiness.installLabel}
          installDisabled={readiness.installDisabled}
          setStep={setStep}
          setName={setName}
          setRam={setRam}
          setPackVer={setPackVer}
          setEula={setEula}
          setPort={setPort}
          setPortCheck={setPortCheck}
          onInstall={() => { void serverFlow.beginInstall(); }}
        />
      )}
      {step === 4 && (
        <StepsInstall
          hasBackend={hasBackend()}
          kind={kind}
          port={port}
          eula={eula}
          pack={pack}
          packVer={packVer}
          autoDeleteCurseForgeZip={autoDeleteCurseForgeZip}
          localMrpack={localMrpack}
          install={install}
          pipeline={pipeline}
          catalogue={catalogue}
          modrinth={modrinth}
          curseforge={curseforge}
          selectedModrinthVersion={modrinth.selectedModrinthVersion}
          portBlocked={portBlocked}
          onCancel={() => { void serverFlow.cancelInstall(); }}
          onRetry={() => { void serverFlow.beginInstall(); }}
          onFinish={serverFlow.finishInstall}
          onExitConsole={() => onExit('console')}
          setStep={setStep}
        />
      )}
    </div>
  );
}
