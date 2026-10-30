// CurseForge import state/effects for the Create wizard (extracted from Create.tsx, WP-6.5).
import { useEffect, useRef, useState } from 'react';
import type {
  CurseForgeArchiveInspection,
  CurseForgeDownloadUpdate,
  CurseForgeModpackSearchResult,
  CurseForgeModpackSort,
  CurseForgeProjectMetaDto,
  CurseForgeProjectVersionDto,
  CurseForgeStagedZip,
} from '../../tauri';
import { hasBackend, isDesktop, onCurseForgeDownload, tauriCurseForge, tauriCurseForgeKey } from '../../tauri';
import { cfInstallable, curseforgeProjectInputError, errorText } from './helpers';

interface Options {
  kind: 'vanilla' | 'curseforge' | 'modrinth';
  clearPipelineReview: () => void;
  pushToast: (message: string, tone: 'ok' | 'err' | 'info') => void;
}

export function useCurseForgeImport({ kind, clearPipelineReview, pushToast }: Options) {
  const [curseforgeZips, setCurseforgeZips] = useState<CurseForgeStagedZip[]>([]);
  const [curseforgeSelectedName, setCurseforgeSelectedName] = useState('');
  const [curseforgeInspection, setCurseforgeInspection] = useState<CurseForgeArchiveInspection | null>(null);
  const curseforgeInspectionRequestId = useRef(0);
  const curseforgeSelectedNameRef = useRef('');
  const [curseforgeLoading, setCurseforgeLoading] = useState(false);
  const [curseforgeInspecting, setCurseforgeInspecting] = useState(false);
  const [curseforgeError, setCurseforgeError] = useState('');
  const [curseforgeBrowserMessage, setCurseforgeBrowserMessage] = useState('');
  const [curseforgeDownloads, setCurseforgeDownloads] = useState<CurseForgeDownloadUpdate[]>([]);
  const [cfProjectInput, setCfProjectInput] = useState('');
  const [cfProjectId, setCfProjectId] = useState<number | null>(null);
  const [cfProjectMeta, setCfProjectMeta] = useState<CurseForgeProjectMetaDto | null>(null);
  const [cfProjectBusy, setCfProjectBusy] = useState(false);
  const [cfProjectError, setCfProjectError] = useState('');
  /**
   * The version chosen for a one-click install.
   *
   * CurseForge authors publish an OPTIONAL server pack beside the client pack, and a project's newest file frequently has
   * none. Installing then resolved the client manifest instead, which pulls client-only mods onto a server. Keeping the
   * choice explicit — rather than defaulting to "newest" — is what lets a server install pick the version that actually
   * has a server pack.
   */
  const [cfSelectedVersion, setCfSelectedVersion] = useState<CurseForgeProjectVersionDto | null>(null);
  const [cfKeyStatus, setCfKeyStatus] = useState<{ configured: boolean; source: 'safeStorage' | 'file' | null; encrypted: boolean; hint: string } | null>(null);
  const [cfSearchQuery, setCfSearchQuery] = useState('');
  const [cfSearchSort, setCfSearchSort] = useState<CurseForgeModpackSort>('popularity');
  const [cfSearchBusy, setCfSearchBusy] = useState(false);
  const [cfSearchError, setCfSearchError] = useState('');
  const [cfSearchResult, setCfSearchResult] = useState<CurseForgeModpackSearchResult | null>(null);
  const [cfResolvingId, setCfResolvingId] = useState<number | null>(null);

  const refreshCurseforgeKeyStatus = async (): Promise<void> => {
    if (!hasBackend()) return;
    try {
      setCfKeyStatus(await tauriCurseForgeKey.status());
    } catch {
      setCfKeyStatus(null);
    }
  };

  useEffect(() => {
    void refreshCurseforgeKeyStatus();
  }, []);

  const searchCurseforgeModpacks = async (loadMore = false): Promise<void> => {
    if (!hasBackend()) return;
    setCfSearchBusy(true);
    setCfSearchError('');
    try {
      const offset = loadMore ? (cfSearchResult?.hits.length ?? 0) : 0;
      const result = await tauriCurseForge.searchModpacks(cfSearchQuery, {
        offset,
        limit: 20,
        sort: cfSearchSort,
      });
      setCfSearchResult((previous) => (
        loadMore && previous
          ? { ...result, hits: [...previous.hits, ...result.hits] }
          : result
      ));
    } catch (error) {
      setCfSearchError(errorText(error, 'Could not search CurseForge modpacks.'));
    } finally {
      setCfSearchBusy(false);
    }
  };

  const selectCurseforgeZip = (name: string): void => {
    if (cfProjectId !== null) {
      setCfProjectId(null);
      setCfProjectMeta(null);
      setCfProjectError('');
    }
    if (curseforgeSelectedNameRef.current !== name) {
      clearPipelineReview();
      curseforgeInspectionRequestId.current += 1;
      curseforgeSelectedNameRef.current = name;
      setCurseforgeInspection(null);
      setCurseforgeInspecting(false);
    }
    setCurseforgeSelectedName(name);
    setCurseforgeError('');
  };

  const refreshCurseforgeZips = async (preferredName?: string): Promise<void> => {
    if (!hasBackend()) return;
    setCurseforgeLoading(true);
    setCurseforgeError('');
    try {
      const files = await tauriCurseForge.listZips();
      setCurseforgeZips(files);
      const currentSelectedName = curseforgeSelectedNameRef.current;
      const nextName = preferredName && files.some((file) => file.name === preferredName)
        ? preferredName
        : files.some((file) => file.name === currentSelectedName)
          ? currentSelectedName
          : files[0]?.name ?? '';
      selectCurseforgeZip(nextName);
    } catch (error) {
      setCurseforgeError(errorText(error, 'Could not scan CurseForge ZIP staging.'));
    } finally {
      setCurseforgeLoading(false);
    }
  };

  const openCurseforgeBrowser = async (): Promise<void> => {
    setCurseforgeBrowserMessage('');
    try {
      const embedded = await tauriCurseForge.openBrowser();
      setCurseforgeBrowserMessage(embedded
        ? 'CurseForge is open in the embedded browser. Managed ZIP downloads appear here with progress and cancel controls.'
        : 'This platform uses the external browser. After downloading a SERVER ZIP, return here and choose Browse for ZIP.');
    } catch (error) {
      const message = errorText(error, 'Could not open the CurseForge browser.');
      setCurseforgeBrowserMessage(message);
      pushToast(message, 'err');
    }
  };

  const openCurseforgeExternal = async (): Promise<void> => {
    try {
      await tauriCurseForge.openExternalBrowser();
      setCurseforgeBrowserMessage('CurseForge opened in your external browser. Use Browse for ZIP after downloading the SERVER pack.');
    } catch (error) {
      const message = errorText(error, 'Could not open CurseForge in the external browser.');
      setCurseforgeBrowserMessage(message);
      pushToast(message, 'err');
    }
  };

  /** Official API key mode: project URL/slug/id → latest file → serverPackFileId. */
  const resolveCurseforgeProject = async (rawOverride?: string): Promise<boolean> => {
    const candidate = (rawOverride ?? cfProjectInput).trim();
    const invalid = curseforgeProjectInputError(candidate);
    if (invalid) {
      setCfProjectError(invalid);
      return false;
    }
    const raw = candidate;
    setCfProjectBusy(true);
    setCfProjectError('');
    try {
      const meta = await tauriCurseForge.inspectProject(raw);
      clearPipelineReview();
      setCfProjectId(meta.projectId);
      setCfProjectMeta(meta);
      // A version chosen for the PREVIOUS project must not survive a switch to a different project: its fileId belongs to
      // the old project and would be sent as a pin for the new one.
      setCfSelectedVersion(null);
      setCurseforgeBrowserMessage(
        `${meta.name}: Minecraft ${meta.minecraftVersion ?? '?'} · ${meta.loader ?? '?'} · ${meta.hasServerPack ? 'server pack available (one-click)' : 'no server pack; client manifest install'}`,
      );
      return true;
    } catch (error) {
      setCfProjectId(null);
      setCfProjectMeta(null);
      setCfProjectError(errorText(error, 'Could not resolve the CurseForge project.'));
      return false;
    } finally {
      setCfProjectBusy(false);
    }
  };

  /** Select a result from the in-app modpack browser: resolve it through the same one-click flow. */
  const pickSearchedCurseforgeModpack = async (projectId: number): Promise<boolean> => {
    setCfProjectInput(String(projectId));
    setCfResolvingId(projectId);
    try {
      return await resolveCurseforgeProject(String(projectId));
    } finally {
      setCfResolvingId(null);
    }
  };

  const browseCurseforgeZip = async (file?: File): Promise<void> => {
    setCurseforgeError('');
    try {
      const copied = isDesktop()
        ? await tauriCurseForge.pickZip()
        : file
          ? await tauriCurseForge.uploadZip(file)
          : null;
      if (copied) await refreshCurseforgeZips(copied.name);
    } catch (error) {
      setCurseforgeError(errorText(error, 'Could not copy the selected ZIP into managed staging.'));
    }
  };

  const inspectCurseforgeZip = async (): Promise<void> => {
    const selectedName = curseforgeSelectedNameRef.current;
    if (!selectedName || selectedName !== curseforgeSelectedName) return;
    const requestId = ++curseforgeInspectionRequestId.current;
    const isCurrentRequest = (): boolean => requestId === curseforgeInspectionRequestId.current
      && selectedName === curseforgeSelectedNameRef.current;
    setCurseforgeInspecting(true);
    setCurseforgeError('');
    setCurseforgeInspection(null);
    try {
      const inspection = await tauriCurseForge.inspectZip(selectedName);
      if (!isCurrentRequest()) return;
      setCurseforgeInspection(inspection);
    } catch (error) {
      if (!isCurrentRequest()) return;
      setCurseforgeError(errorText(error, 'Could not inspect the selected ZIP.'));
    } finally {
      if (isCurrentRequest()) setCurseforgeInspecting(false);
    }
  };

  const continueToCurseforgeZipSelection = async (): Promise<void> => {
    await refreshCurseforgeZips();
  };

  useEffect(() => {
    if (!hasBackend()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onCurseForgeDownload((update) => {
      setCurseforgeDownloads((previous) => [
        update,
        ...previous.filter((item) => item.id !== update.id),
      ].slice(0, 5));
      if (update.status === 'completed') {
        void tauriCurseForge.listZips().then(setCurseforgeZips).catch(() => {});
      }
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /**
   * A local-import-shaped description synthesised from the API project, so the configure panel can share one code path.
   *
   * It must describe what will actually be installed. Two things vary with the version choice and were previously hardcoded
   * to "latest": the name and the reason text. A user who picked an older version saw "the latest server pack will be
   * installed" next to a title naming their version — the panel contradicted itself.
   */
  const cfProjectInspection: CurseForgeArchiveInspection | null = cfProjectId !== null && cfProjectMeta
    ? {
        // The chosen version's own display name when one is picked; the project name only as a fallback.
        name: cfSelectedVersion?.displayName ?? cfProjectMeta.name,
        classification: cfSelectedVersion !== null && !cfSelectedVersion.hasServerPack ? 'clientExport' : 'supportedServerPack',
        reason: cfSelectedVersion !== null
          ? (cfSelectedVersion.hasServerPack
            ? `Official API key mode: the server pack for the selected version "${cfSelectedVersion.displayName}" will be installed.`
            : `The selected version "${cfSelectedVersion.displayName}" has no server pack; its client manifest is resolved and client-only mods are skipped.`)
          : (cfProjectMeta.hasServerPack
            ? 'Official API key mode: the latest server pack (serverPackFileId) will be installed.'
            : 'Official API key mode: no server pack on the latest file; the client pack is resolved from manifest.json.'),
        minecraftVersion: cfSelectedVersion?.minecraftVersion ?? cfProjectMeta.minecraftVersion,
        loader: cfSelectedVersion?.loader ?? cfProjectMeta.loader,
        loaderVersion: cfProjectMeta.loaderVersion,
      }
    : null;
  const curseforgeInspectionMatchesSelection = Boolean(
    cfProjectId !== null ? cfProjectMeta !== null : curseforgeInspection && curseforgeInspection.name === curseforgeSelectedName,
  );
  const selectedCurseforgeInspection = cfProjectId !== null
    ? cfProjectInspection
    : (curseforgeInspectionMatchesSelection ? curseforgeInspection : null);

  const cancelDownload = (downloadId: string): void => {
    void tauriCurseForge.cancelDownload(downloadId).then((accepted) => {
      if (!accepted) pushToast('This download is no longer active.', 'info');
    }).catch((error: unknown) => pushToast(errorText(error, 'Could not cancel the download.'), 'err'));
  };

  return {
    kind,
    curseforgeZips,
    curseforgeSelectedName,
    curseforgeInspection,
    curseforgeLoading,
    curseforgeInspecting,
    curseforgeError,
    curseforgeBrowserMessage,
    curseforgeDownloads,
    cfProjectInput,
    setCfProjectInput,
    cfProjectId,
    cfProjectMeta,
    cfProjectBusy,
    cfProjectError,
    cfSelectedVersion,
    setCfSelectedVersion,
    cfKeyStatus,
    refreshCurseforgeKeyStatus,
    cfSearchQuery,
    setCfSearchQuery,
    cfSearchSort,
    setCfSearchSort,
    cfSearchBusy,
    cfSearchError,
    cfSearchResult,
    cfResolvingId,
    searchCurseforgeModpacks,
    pickSearchedCurseforgeModpack,
    cfProjectInspection,
    curseforgeInspectionMatchesSelection,
    selectedCurseforgeInspection,
    selectCurseforgeZip,
    refreshCurseforgeZips,
    continueToCurseforgeZipSelection,
    openCurseforgeBrowser,
    openCurseforgeExternal,
    resolveCurseforgeProject,
    browseCurseforgeZip,
    inspectCurseforgeZip,
    cancelDownload,
    clearCfProjectError: () => setCfProjectError(''),
    // Clearing the chosen version matters as much as clearing the project: leaving it behind lets a previous project's
    // version leak into a new create session, where it would be sent as a fileId belonging to a different project.
    resetForSourceChange: () => { setCfProjectId(null); setCfProjectMeta(null); setCfProjectError(''); setCfSelectedVersion(null); },
    cfInstallable,
  };
}

export type CurseForgeImportState = ReturnType<typeof useCurseForgeImport>;
