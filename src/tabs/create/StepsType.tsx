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
      onContinueToConfigure={() => { if (curseforge.cfProjectId !== null) setStep(3); }}
      onPickMockKind={(picked) => {
        pipeline.clearPipelineReview();
        setKind(picked);
        setStep(picked === 'vanilla' ? 3 : 2);
      }}
    />
  );
}
