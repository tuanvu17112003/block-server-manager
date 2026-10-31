// Create step 2 wiring container (CurseForge ZIP / Modrinth catalogue / browser mock), WP-6.5.
import { isDesktop } from '../../tauri';
import type { LocalMrpackSelection, ModrinthModpackDto } from '../../tauri';
import type { Modpack } from '../../types';
import { cfInstallable, type Kind } from './helpers';
import { BrowseCurseforge } from './BrowseCurseforge';
import { CurseForgeVersionPicker } from './CurseForgeVersionPicker';
import { BrowseModrinth } from './BrowseModrinth';
import { BrowseMock } from './BrowseMock';
import type { CreateCatalogState } from './useCreateCatalog';
import type { ModrinthBrowseState } from './useModrinthBrowse';
import type { CurseForgeImportState } from './useCreateCurseforgeImport';

interface StepsBrowseProps {
  hasBackend: boolean;
  kind: Kind;
  catalogue: CreateCatalogState;
  modrinth: ModrinthBrowseState;
  curseforge: CurseForgeImportState;
  localMrpack: LocalMrpackSelection | null;
  installing: boolean;
  results: Modpack[];
  localMrpackInputRef: { current: HTMLInputElement | null };
  curseforgeZipInputRef: { current: HTMLInputElement | null };
  onPickLocalMrpack: () => void;
  onPickPack: (pack: Modpack) => void;
  onPickModrinthPack: (pack: ModrinthModpackDto) => void;
  setStep: (step: number) => void;
}

export function StepsBrowse(props: StepsBrowseProps) {
  const { modrinth, curseforge, catalogue, setStep } = props;
  return (
    <>
      {props.hasBackend && props.kind === 'curseforge' && (
        <>
          {/* One-click install: pick the project version explicitly. The newest file is not automatically the right one for
              a server, because the server pack is published per version and may not exist for it.
              Gated on `curseforgeMode === 'project'` rather than on cfProjectId being non-null, so the two branches cannot
              both render their controls at once. */}
          {curseforge.curseforgeMode === 'project' && curseforge.cfProjectId !== null && (
            <div className="mb-3 rounded border border-zinc-800 bg-zinc-900/40 p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  {curseforge.cfProjectMeta?.name ?? `Project ${curseforge.cfProjectId}`}
                </span>
                {curseforge.activeCfVersion !== null && (
                  <span className="ml-auto text-[11px] text-emerald-300">
                    {curseforge.activeCfVersion.hasServerPack ? 'server pack' : 'client pack only'}
                  </span>
                )}
              </div>
              <CurseForgeVersionPicker
                project={curseforge.cfProjectId}
                selectedFileId={curseforge.activeCfVersion?.fileId ?? null}
                onChoose={(version) => { curseforge.setCfSelectedVersion(version); }}
                onContinue={() => {
                  // Only meaningful once a version is chosen; the picker disables the button until then.
                  if (curseforge.activeCfVersion !== null) setStep(3);
                }}
              />
            </div>
          )}
          {/* Hidden while the project branch is live.
              Both controls were rendered together before, so a user looking at the version picker also saw a ZIP list below
              it with its own "Continue" button — two competing ways to install, with no indication which one would be
              used. The request priority says the project wins, so the ZIP list is only shown when it actually applies. */}
          {curseforge.curseforgeMode !== 'project' && (
          <BrowseCurseforge
          zips={curseforge.curseforgeZips}
          selectedName={curseforge.curseforgeSelectedName}
          inspection={curseforge.selectedCurseforgeInspection}
          loading={curseforge.curseforgeLoading}
          inspecting={curseforge.curseforgeInspecting}
          error={curseforge.curseforgeError}
          onRefresh={() => { void curseforge.refreshCurseforgeZips(); }}
          onBrowse={() => {
            if (isDesktop()) void curseforge.browseCurseforgeZip();
            else props.curseforgeZipInputRef.current?.click();
          }}
          onSelect={curseforge.selectCurseforgeZip}
          onInspect={() => { void curseforge.inspectCurseforgeZip(); }}
          onContinue={() => {
            if (curseforge.curseforgeInspection?.name === curseforge.curseforgeSelectedName && cfInstallable(curseforge.curseforgeInspection)) setStep(3);
          }}
          onBack={() => setStep(1)}
        />
          )}
        </>
      )}
      {props.hasBackend && props.kind === 'modrinth' && (
        <BrowseModrinth
          q={modrinth.q}
          onQueryChange={modrinth.setQ}
          mc={modrinth.mc}
          onMcChange={modrinth.setMc}
          loader={modrinth.loader}
          onLoaderChange={modrinth.setLoader}
          sort={modrinth.sort}
          onSortChange={modrinth.setSort}
          vanillaVersions={catalogue.vanillaVersions}
          packs={modrinth.modrinthPacks}
          displayedPacks={modrinth.displayedModrinthPacks}
          totalHits={modrinth.modrinthTotalHits}
          loading={modrinth.modrinthLoading}
          loadingMore={modrinth.modrinthLoadingMore}
          error={modrinth.modrinthError}
          offset={modrinth.modrinthOffset}
          hasMore={modrinth.modrinthOffset < modrinth.modrinthTotalHits}
          localMrpack={props.localMrpack}
          installing={props.installing}
          onRetry={() => { if (modrinth.modrinthPacks.length > 0) void modrinth.loadMoreModrinth(); else modrinth.modrinthRetry(); }}
          onLoadMore={() => { void modrinth.loadMoreModrinth(); }}
          onImportLocalMrpack={() => {
            if (isDesktop()) props.onPickLocalMrpack();
            else props.localMrpackInputRef.current?.click();
          }}
          onPickPack={props.onPickModrinthPack}
          onBack={() => setStep(1)}
        />
      )}
      {!props.hasBackend && (
        <BrowseMock
          q={modrinth.q}
          onQueryChange={modrinth.setQ}
          sourceTab={modrinth.sourceTab}
          onSourceTabChange={modrinth.setSourceTab}
          mc={modrinth.mc}
          onMcChange={modrinth.setMc}
          loader={modrinth.loader}
          onLoaderChange={modrinth.setLoader}
          sort={modrinth.sort}
          onSortChange={modrinth.setSort}
          results={props.results}
          onPickPack={props.onPickPack}
          onBack={() => setStep(1)}
          kind={props.kind}
        />
      )}
    </>
  );
}
