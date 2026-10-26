// Create step 4 wiring container (backend install card + browser mock), WP-6.5.
import type { Modpack } from '../../types';
import type { LocalMrpackSelection } from '../../tauri';
import type { Kind } from './helpers';
import { StepInstall } from './StepInstall';
import { StepInstallMock } from './StepInstallMock';
import type { InstallState } from './useInstallState';
import type { PipelineReviewState } from './usePipelineReview';
import type { CreateCatalogState } from './useCreateCatalog';
import type { ModrinthBrowseState } from './useModrinthBrowse';
import type { CurseForgeImportState } from './useCreateCurseforgeImport';

interface StepsInstallProps {
  hasBackend: boolean;
  kind: Kind;
  port: number;
  eula: boolean;
  pack: Modpack | null;
  packVer: number;
  autoDeleteCurseForgeZip: boolean;
  localMrpack: LocalMrpackSelection | null;
  install: InstallState;
  pipeline: PipelineReviewState;
  catalogue: CreateCatalogState;
  modrinth: ModrinthBrowseState;
  curseforge: CurseForgeImportState;
  selectedModrinthVersion: ModrinthBrowseState['selectedModrinthVersion'];
  portBlocked: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onFinish: () => void;
  onExitConsole: () => void;
  setStep: (step: number) => void;
}

export function StepsInstall(props: StepsInstallProps) {
  const { install, pipeline } = props;
  return (
    <>
      {props.hasBackend && (
        <StepInstall
          doneId={install.doneId}
          installing={install.installing}
          progress={install.progress}
          installStage={install.installStage}
          installBytes={install.installBytes}
          installError={install.installError}
          installLogs={install.installLogs}
          report={pipeline.pipelineReport}
          cancelRequested={install.cancelRequested}
          kind={props.kind}
          port={props.port}
          eula={props.eula}
          cfInspection={props.curseforge.selectedCurseforgeInspection}
          selectedModrinthPack={props.modrinth.selectedModrinthPack}
          selectedModrinthVersion={props.selectedModrinthVersion}
          modrinthInstallMc={props.modrinth.modrinthInstallMc}
          modrinthInstallLoader={props.modrinth.modrinthInstallLoader}
          vanillaMc={props.catalogue.vanillaMc}
          selectedLoaderChoice={props.catalogue.selectedLoaderChoice}
          serverLoader={props.catalogue.serverLoader}
          autoDeleteCurseForgeZip={props.autoDeleteCurseForgeZip}
          onCancel={props.onCancel}
          onBackToConfigure={() => props.setStep(3)}
          onRetry={props.onRetry}
          retryDisabled={props.portBlocked}
          onExitConsole={props.onExitConsole}
        />
      )}
      {!props.hasBackend && (
        <StepInstallMock
          progress={install.progress}
          installing={install.installing}
          doneId={install.doneId}
          hasBackend={props.hasBackend}
          eula={props.eula}
          port={props.port}
          pack={props.pack}
          packVer={props.packVer}
          vanillaMc={props.catalogue.vanillaMc}
          onBack={() => props.setStep(3)}
          onCancel={props.onCancel}
          onRetry={props.onRetry}
          onFinish={props.onFinish}
          onExitConsole={props.onExitConsole}
        />
      )}
    </>
  );
}
