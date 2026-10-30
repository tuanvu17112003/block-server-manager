// Create step 1 wiring container (separates orchestration from the presenter, WP-6.5).
import type { Modpack } from '../../types';
import type { Kind } from './helpers';
import { StepType } from './StepType';
import type { CreateCatalogState } from './useCreateCatalog';
import type { CurseForgeImportState } from './useCreateCurseforgeImport';
import type { ModrinthBrowseState } from './useModrinthBrowse';
import type { PipelineReviewState } from './usePipelineReview';

interface StepsTypeContainerProps {
  hasBackend: boolean;
  kind: Kind;
  catalogue: CreateCatalogState;
  curseforge: CurseForgeImportState;
  modrinth: ModrinthBrowseState;
  pipeline: PipelineReviewState;
  setKind: (kind: Kind) => void;
  setStep: (step: number) => void;
  setPack: (pack: Modpack | null) => void;
}

export function StepsType(props: StepsTypeContainerProps) {
  const { catalogue, curseforge, modrinth, pipeline, setKind, setStep, setPack } = props;
  return (
    <StepType
      hasBackend={props.hasBackend}
      kind={props.kind}
      serverLoader={catalogue.serverLoader}
      onPickLoader={(loader) => {
        pipeline.clearPipelineReview();
        setKind('vanilla');
        if (catalogue.serverLoader !== loader) {
          catalogue.setSelectedLoaderChoice(null);
          catalogue.setLoaderChoices([]);
          catalogue.setLoaderError('');
        }
        catalogue.setServerLoader(loader);
        setPack(null);
        modrinth.setSelectedModrinthPack(null);
        setStep(3);
      }}
      onPickModrinthPacks={() => {
        pipeline.clearPipelineReview();
        setKind('modrinth');
        setPack(null);
        modrinth.setSelectedModrinthPack(null);
        modrinth.setSourceTab('modrinth');
        setStep(2);
      }}
      onPickCurseforge={() => {
        pipeline.clearPipelineReview();
        setKind('curseforge');
        setPack(null);
        modrinth.setSelectedModrinthPack(null);
        curseforge.selectCurseforgeZip('');
      }}
      curseforgeBrowserMessage={curseforge.curseforgeBrowserMessage}
      curseforgeDownloads={curseforge.curseforgeDownloads}
      curseforgeLoading={curseforge.curseforgeLoading}
      onOpenBrowser={() => { void curseforge.openCurseforgeBrowser(); }}
      onOpenExternal={() => { void curseforge.openCurseforgeExternal(); }}
      onCancelDownload={curseforge.cancelDownload}
      onContinueToZipSelection={() => { void curseforge.continueToCurseforgeZipSelection().then(() => setStep(2)); }}
      cfProjectInput={curseforge.cfProjectInput}
      onCfProjectInputChange={(value) => { curseforge.setCfProjectInput(value); curseforge.clearCfProjectError(); }}
      cfProjectError={curseforge.cfProjectError}
      cfProjectBusy={curseforge.cfProjectBusy}
      cfProjectMeta={curseforge.cfProjectMeta}
      cfProjectId={curseforge.cfProjectId}
      onResolveProject={() => { void curseforge.resolveCurseforgeProject(); }}
      cfKeyConfigured={curseforge.cfKeyStatus ? curseforge.cfKeyStatus.configured : null}
      cfKeyHint={curseforge.cfKeyStatus?.hint ?? ''}
      onRefreshKeyStatus={() => { void curseforge.refreshCurseforgeKeyStatus(); }}
      cfSearchQuery={curseforge.cfSearchQuery}
      onCfSearchQueryChange={curseforge.setCfSearchQuery}
      cfSearchSort={curseforge.cfSearchSort}
      onCfSearchSortChange={curseforge.setCfSearchSort}
      cfSearchBusy={curseforge.cfSearchBusy}
      cfSearchError={curseforge.cfSearchError}
      cfSearchResult={curseforge.cfSearchResult}
      cfResolvingId={curseforge.cfResolvingId}
      onSearchPacks={(loadMore) => { void curseforge.searchCurseforgeModpacks(loadMore); }}
      onPickSearchedPack={(projectId) => {
        // Land on Browse, not Configure.
        //
        // "Use pack" used to jump straight to step 3, which skipped version selection entirely — the user was configured
        // with whatever the installer happened to pick, had to press Back to change it, and Back only returned to Browse
        // because the picker lives there. Browsing is also where the version list is meaningful, so resolving the project
        // and then moving to Browse puts the choice in front of the user instead of behind them.
        void curseforge.pickSearchedCurseforgeModpack(projectId).then((ok) => { if (ok) setStep(2); });
      }}
      // Goes to Browse, not Configure. The version picker lives on Browse, so jumping to Configure would skip the choice
      // this button now promises — the same defect "Use pack" had, reached by a different button.
      onContinueToConfigure={() => { if (curseforge.cfProjectId !== null) setStep(2); }}
      onPickMockKind={(picked) => {
        pipeline.clearPipelineReview();
        setKind(picked);
        setStep(picked === 'vanilla' ? 3 : 2);
      }}
    />
  );
}
