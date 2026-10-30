// Create step 3 wiring container (configure form props assembly), WP-6.5.
import { FREE_RAM_MB } from '../../mocks/data';
import type { Modpack } from '../../types';
import type { Kind } from './helpers';
import { StepConfigure } from './StepConfigure';
import type { CreateCatalogState } from './useCreateCatalog';
import type { JavaSelectionState } from './useJavaSelection';
import type { ModrinthBrowseState } from './useModrinthBrowse';
import type { CurseForgeImportState } from './useCreateCurseforgeImport';
import type { PipelineReviewState } from './usePipelineReview';

interface StepsConfigureProps {
  hasBackend: boolean;
  kind: Kind;
  pack: Modpack | null;
  packVer: number;
  name: string;
  ram: number;
  port: number;
  eula: boolean;
  recommended: number;
  ramBelow: boolean;
  freeWarn: boolean;
  portChecking: boolean;
  portOutOfRange: boolean;
  portConflict: boolean;
  portUnavailable: boolean;
  portBlocked: boolean;
  portSuggested: number | null;
  installing: boolean;
  catalogue: CreateCatalogState;
  modrinth: ModrinthBrowseState;
  curseforge: CurseForgeImportState;
  java: JavaSelectionState;
  pipeline: PipelineReviewState;
  pipelinePreviewMatchesSource: boolean;
  currentPipelineDecisions: PipelineReviewState['pipelineFileChoices'] extends never ? never : PipelinePreviewDecisions;
  installLabel: string;
  installDisabled: boolean;
  setStep: (step: number) => void;
  setName: (value: string) => void;
  setRam: (value: number) => void;
  setPackVer: (value: number) => void;
  setEula: (value: boolean) => void;
  setPort: (value: number) => void;
  setPortCheck: (value: { port: number; available: boolean; suggested: number } | null) => void;
  onInstall: () => void;
}

type PipelinePreviewDecisions = NonNullable<PipelineReviewState['pipelinePreview']>['plan']['fileDecisions'];

export function StepsConfigure(props: StepsConfigureProps) {
  const { catalogue, modrinth, curseforge, java, pipeline, setStep } = props;
  return (
    <StepConfigure
      hasBackend={props.hasBackend}
      kind={props.kind}
      title={(() => {
        // A chosen CurseForge version wins over a staged ZIP.
        //
        // The title used to read only `selectedCurseforgeInspection`, which describes a ZIP already staged by the local-import
        // path. In one-click project mode no such ZIP is involved, so the stale inspection from an earlier browse won and the
        // screen displayed "RLCraft ... v2.9.3.zip" while the user had picked v2.9 — reported as "I chose 2.9 but it still
        // shows 2.9.3". The version the user chose is the truth, so it is checked first.
        const chosen = curseforge.cfSelectedVersion;
        if (props.hasBackend && props.kind === 'curseforge' && chosen !== null) {
          return `Configure — ${chosen.displayName}`;
        }
        const inspection = curseforge.selectedCurseforgeInspection;
        if (props.hasBackend && props.kind === 'curseforge' && inspection) return `Configure — ${inspection.name}`;
        if (props.hasBackend && props.kind === 'modrinth') return `Configure — ${modrinth.selectedModrinthPack?.name ?? 'Modrinth modpack'}`;
        if (props.hasBackend) return `Configure — ${catalogue.selectedLoaderChoice?.loader === catalogue.serverLoader ? catalogue.selectedLoaderChoice.label : catalogue.serverLoader}`;
        return `Configure ${props.kind === 'vanilla' ? '— Vanilla (2-click)' : `— ${props.pack?.name ?? 'modpack'}`}`;
      })()}
      cfInspection={curseforge.selectedCurseforgeInspection}
      cfChosenVersion={props.kind === 'curseforge' ? curseforge.cfSelectedVersion : null}
      modrinth={props.hasBackend && props.kind === 'modrinth' && modrinth.selectedModrinthPack ? {
        pack: modrinth.selectedModrinthPack,
        versions: modrinth.modrinthVersions,
        selectedVersionId: modrinth.selectedModrinthVersionId,
        onVersionChange: modrinth.setSelectedModrinthVersionId,
        versionsLoading: modrinth.modrinthVersionsLoading,
        versionsError: modrinth.modrinthVersionsError,
        onRetryVersions: modrinth.retryModrinthVersions,
        selectedVersion: modrinth.selectedModrinthVersion,
        installMc: modrinth.modrinthInstallMc,
        onInstallMcChange: modrinth.setModrinthInstallMc,
        installLoader: modrinth.modrinthInstallLoader,
        onInstallLoaderChange: (value: string) => {
          const option = modrinth.modrinthLoaderOptionList.find((candidate) => candidate.id === value || candidate.loader === value);
          if (option?.loader) modrinth.setModrinthInstallLoader(option.loader);
        },
        loaderOptions: modrinth.modrinthLoaderOptionList,
        vanillaVersions: catalogue.vanillaVersions,
        supportedGameVersions: modrinth.modrinthSupportedGameVersions,
        buildChoices: modrinth.modrinthBuildChoices,
        buildLoading: modrinth.modrinthBuildLoading,
        buildError: modrinth.modrinthBuildError,
        buildUnavailable: modrinth.modrinthBuildUnavailable,
        buildMc: modrinth.modrinthBuildMc,
        buildVersionId: modrinth.modrinthBuildVersionId,
        selectedLoaderChoice: modrinth.selectedModrinthLoaderChoice,
        onRetryBuilds: modrinth.retryModrinthBuilds,
        onChangePack: () => {
          modrinth.setSelectedModrinthPack(null);
          modrinth.setModrinthVersions([]);
          modrinth.setSelectedModrinthVersionId('');
          modrinth.setModrinthVersionsError('');
          setStep(2);
        },
      } : null}
      mockPack={props.hasBackend ? null : props.pack}
      packVer={props.packVer}
      onPackVerChange={props.setPackVer}
      onChangeMockPack={() => setStep(2)}
      catalogue={{
        kind: props.kind,
        hasBackend: props.hasBackend,
        vanillaMc: catalogue.vanillaMc,
        onVanillaMcChange: catalogue.setVanillaMc,
        configureVersions: catalogue.configureVersions,
        filteredConfigureVersions: catalogue.filteredConfigureVersions,
        versionsLoading: catalogue.versionsLoading,
        versionsError: catalogue.versionsError,
        versionsRetry: catalogue.versionsRetry,
        onRetryVersions: catalogue.retryCatalogue,
        showSnapshots: catalogue.showSnapshots,
        onShowSnapshotsChange: catalogue.setShowSnapshots,
        snapshotStale: catalogue.snapshotStale,
        selectedVersionDto: catalogue.selectedVersionDto,
        loaderChoices: catalogue.loaderChoices,
        displayedLoaderChoices: catalogue.displayedLoaderChoices,
        selectedLoaderChoice: catalogue.selectedLoaderChoice,
        serverLoader: catalogue.serverLoader,
        loaderLoading: catalogue.loaderLoading,
        loaderError: catalogue.loaderError,
        loaderToggleStale: catalogue.loaderToggleStale,
        showAllBuilds: catalogue.showAllBuilds,
        onShowAllBuildsChange: catalogue.setShowAllBuilds,
        onSelectLoaderChoice: (choice) => {
          catalogue.setSelectedLoaderChoice(choice);
          catalogue.setServerLoader(choice.loader);
          catalogue.setLoaderError('');
        },
        onRetryLoaders: catalogue.retryLoaders,
      }}
      ramPort={{
        hasBackend: props.hasBackend,
        ram: props.ram,
        onRamChange: props.setRam,
        recommended: props.recommended,
        ramBelow: props.ramBelow,
        freeWarn: props.freeWarn,
        ramFreeEstimate: FREE_RAM_MB,
        port: props.port,
        onPortChange: (value) => { props.setPort(value); props.setPortCheck(null); },
        portChecking: props.portChecking,
        portOutOfRange: props.portOutOfRange,
        portConflict: props.portConflict,
        portUnavailable: props.portUnavailable,
        portBlocked: props.portBlocked,
        portSuggested: props.portSuggested,
        onUseSuggestedPort: () => { if (props.portSuggested !== null) { props.setPort(props.portSuggested); props.setPortCheck(null); } },
      }}
      java={{
        hasBackend: props.hasBackend,
        javaDetection: java.javaDetection,
        javaSelected: java.javaSelected,
        javaPath: java.javaPath,
        javaOverride: java.javaOverride,
        javaLoading: java.javaLoading,
        javaInstalling: java.javaInstalling,
        javaProgress: java.javaProgress,
        javaProgressLog: java.javaProgressLog,
        javaError: java.javaError,
        onPathChange: (value) => { java.setJavaPath(value); java.setJavaError(''); },
        onValidatePath: () => { void java.validateJavaOverride(); },
        onToggleOverride: (override) => { if (override) java.openJavaOverride(); else java.useDetectedJava(); },
        onUseDetected: java.useDetectedJava,
        onInstallJava: () => { void java.installJava(); },
        onRetryDetection: java.retryJavaDetection,
      }}
      name={props.name}
      onNameChange={props.setName}
      pipeline={props.pipelinePreviewMatchesSource && pipeline.pipelinePreview ? {
        preview: pipeline.pipelinePreview,
        decisions: props.currentPipelineDecisions,
        fileChoices: pipeline.pipelineFileChoices,
        choicePage: pipeline.pipelineChoicePage,
        onChoice: pipeline.pipelineChoice,
        onPageChange: pipeline.setPipelineChoicePage,
      } : null}
      eula={props.eula}
      onEulaChange={props.setEula}
      backLabel="← Back"
      backDisabled={props.installing}
      onBack={() => setStep(props.kind === 'vanilla' ? 1 : 2)}
      installDisabled={props.installDisabled}
      installLabel={props.installLabel}
      onInstall={props.onInstall}
    />
  );
}

export type { StepsConfigureProps };
