// Install-readiness derivations for the Create wizard (extracted from Create.tsx, WP-6.5).
import type { LocalMrpackSelection } from '../../tauri';
import type { CreateCatalogState } from './useCreateCatalog';
import type { JavaSelectionState } from './useJavaSelection';
import type { ModrinthBrowseState } from './useModrinthBrowse';
import type { CurseForgeImportState } from './useCreateCurseforgeImport';
import type { PipelineReviewState } from './usePipelineReview';
import type { Kind } from './helpers';

export interface InstallReadinessInput {
  kind: Kind;
  name: string;
  hasBackend: boolean;
  installing: boolean;
  portBlocked: boolean;
  catalogue: CreateCatalogState;
  java: JavaSelectionState;
  modrinth: ModrinthBrowseState;
  curseforge: CurseForgeImportState;
  pipeline: PipelineReviewState;
  localMrpack: LocalMrpackSelection | null;
  currentSource: { request: unknown; key: string } | null;
}

export function useInstallReadiness(input: InstallReadinessInput) {
  const { catalogue, java, modrinth, curseforge, pipeline, kind, localMrpack, currentSource } = input;
  const matches = Boolean(pipeline.pipelinePreview && currentSource && pipeline.pipelinePreviewKey === currentSource.key);
  const decisions = matches ? pipeline.pipelinePreview?.plan.fileDecisions ?? [] : [];
  const unresolvedCount = decisions.filter(
    (decision) => decision.action === 'awaitingUserChoice'
      && pipeline.pipelineFileChoices[decision.path] === undefined,
  ).length;
  const remoteReady = Boolean(
    modrinth.selectedModrinthPack && modrinth.selectedModrinthVersion
    && modrinth.modrinthSupportedGameVersions.includes(modrinth.modrinthInstallMc)
    && modrinth.selectedModrinthLoaderOption?.loader === modrinth.modrinthInstallLoader
    && modrinth.selectedModrinthLoaderChoice && modrinth.modrinthBuildMc === modrinth.modrinthInstallMc
    && modrinth.modrinthBuildVersionId === modrinth.selectedModrinthVersionId
    && !modrinth.modrinthBuildLoading && !modrinth.modrinthBuildError && !modrinth.modrinthBuildUnavailable
    && !modrinth.modrinthVersionsLoading && !modrinth.modrinthVersionsError
    && !catalogue.versionsLoading && java.javaSelected && !java.javaLoading && !java.javaInstalling
    && (!java.javaOverride || java.javaSelected.path === java.javaPath.trim())
  );
  const localReady = Boolean(
    localMrpack && pipeline.pipelinePreview && pipeline.pipelinePreviewKey === `local:${localMrpack.sourceId}`
    && pipeline.pipelinePreview.plan.loader.kind !== 'quilt'
    && java.javaSelected && !java.javaLoading && !java.javaInstalling
    && (!java.javaOverride || java.javaSelected.path === java.javaPath.trim())
  );
  const installLabel = input.hasBackend && (kind === 'modrinth' || kind === 'curseforge')
    ? matches ? 'Install reviewed pack →' : 'Review pack files →'
    : 'Install →';
  const installDisabled = input.hasBackend && (input.portBlocked || (kind === 'curseforge'
    ? input.installing || !input.name.trim() || !curseforge.curseforgeInspectionMatchesSelection || !curseforge.cfInstallable(curseforge.selectedCurseforgeInspection) || java.javaLoading || java.javaInstalling || !java.javaSelected || (java.javaOverride && java.javaSelected.path !== java.javaPath.trim()) || (matches && unresolvedCount > 0)
    : kind === 'modrinth'
      ? input.installing || !input.name.trim() || !(localMrpack ? localReady : remoteReady) || (matches && unresolvedCount > 0)
      : input.installing || !input.name.trim() || catalogue.versionsLoading || catalogue.loaderLoading || !catalogue.selectedLoaderChoice || Boolean(catalogue.loaderError) || Boolean(catalogue.loaderToggleStale) || Boolean(catalogue.snapshotStale) || catalogue.selectedLoaderChoice?.loader !== catalogue.serverLoader || java.javaLoading || java.javaInstalling || !java.javaSelected || (java.javaOverride && java.javaSelected.path !== java.javaPath.trim())));

  return { installLabel, installDisabled, remoteReady, localReady, pipelinePreviewMatchesSource: matches };
}
