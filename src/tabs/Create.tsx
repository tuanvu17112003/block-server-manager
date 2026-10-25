import { useEffect, useMemo, useRef, useState } from 'react';
import type { Modpack, Server, TabId } from '../types';
import { FREE_RAM_MB, LOADERS, MC_VERSIONS, modpacks } from '../mocks/data';
import { useStore } from '../store';
import { Badge, Button, Card, CardTitle, Field, ProgressBar, inputCls } from '../components/ui';
import { hasBackend, isDesktop, onCurseForgeDownload, onJobProgress, tauriCurseForge, tauriInstall, tauriJava, tauriModpackPipeline, tauriModrinth, tauriVersions } from '../tauri';
import type { CreateServerInput, CurseForgeArchiveInspection, CurseForgeDownloadUpdate, CurseForgeStagedZip, JavaCandidate, JavaDetection, LoaderChoiceDto, MinecraftVersionDto, ModrinthInstallLoader, ModrinthModpackDto, ModrinthProjectVersionDto, ModrinthSearchIndex, PipelineCreateInput, PipelineFileChoice, PipelineInstallReport, PipelineLoaderPin, PipelinePreviewDto, PipelineSourceRequest, LocalMrpackSelection, ServerDto } from '../tauri';

type Kind = 'vanilla' | 'curseforge' | 'modrinth';

const fmtDl = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}K`);
const MODRINTH_PAGE_SIZE = 20;
const MAX_REPORT_DETAIL_ROWS = 100;
const CURSEFORGE_AUTO_DELETE_KEY = 'cf-auto-delete-zip';
const MODRINTH_LOADER_NAMES: Record<ModrinthInstallLoader, string> = {
  minecraft: 'Vanilla',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
};
const MODRINTH_INSTALLER_LOADER_NAMES: Record<ModrinthInstallLoader, LoaderChoiceDto['loader']> = {
  minecraft: 'Vanilla',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
};

type ModrinthLoaderOption = {
  id: string;
  loader: ModrinthInstallLoader | null;
  label: string;
  reason?: string;
};

function modrinthLoaderOptions(version: ModrinthProjectVersionDto | null): ModrinthLoaderOption[] {
  if (!version) return [];
  const declared = Array.from(new Set(version.loaders.map((value) => value.trim().toLowerCase()).filter(Boolean)));
  if (declared.length === 0) {
    return [{ id: 'minecraft', loader: 'minecraft', label: 'Vanilla (no loader dependency)' }];
  }
  return declared.map((id) => {
    if (id === 'minecraft' || id === 'fabric' || id === 'forge' || id === 'neoforge') {
      return {
        id,
        loader: id,
        label: id === 'minecraft' ? 'Vanilla' : MODRINTH_LOADER_NAMES[id],
      };
    }
    const name = id === 'quilt' ? 'Quilt' : id.charAt(0).toUpperCase() + id.slice(1);
    return {
      id,
      loader: null,
      label: `${name} — unsupported for new server installs`,
      reason: id === 'quilt' ? 'Quilt pack installs are not supported.' : `The ${name} loader is not supported for new server installs.`,
    };
  });
}

function errorText(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error;
  return error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : fallback;
}

function serverFromInstall(dto: ServerDto, recommended: number, modpack?: string): Server {
  return {
    id: dto.id,
    name: dto.name,
    status: 'stopped',
    mcVersion: dto.mcVersion,
    javaPath: dto.javaPath ?? undefined,
    loader: dto.loader,
    loaderVersion: dto.loaderVersion ?? undefined,
    modpack,
    playersOnline: 0,
    maxPlayers: 20,
    port: dto.port,
    ramMb: dto.ramMb,
    ramRecommendedMb: recommended,
    uptimeSec: 0,
    cpuPct: 0,
    ramPct: 0,
    tps: null,
    mspt: null,
    address: '127.0.0.1',
    eulaAccepted: dto.eulaAccepted,
    motd: 'A fresh server!',
    difficulty: 'Normal',
    gamemode: 'Survival',
    onlineMode: true,
    seed: '',
    worldName: 'world',
    worldSizeMb: 0,
    worldLastPlayed: '—',
    version: dto.mcVersion + ' ' + dto.loader,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

export default function Create({ onExit }: { onExit: (next: TabId) => void }) {
  const { addServer, usedPorts, pushToast } = useStore();
  const [step, setStep] = useState(1);
  const [kind, setKind] = useState<Kind>('vanilla');
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
  const localMrpackInputRef = useRef<HTMLInputElement>(null);
  const curseforgeZipInputRef = useRef<HTMLInputElement>(null);
  const [localMrpack, setLocalMrpack] = useState<LocalMrpackSelection | null>(null);
  const localMrpackRef = useRef<LocalMrpackSelection | null>(null);
  const [pipelinePreview, setPipelinePreview] = useState<PipelinePreviewDto | null>(null);
  const [pipelinePreviewKey, setPipelinePreviewKey] = useState('');
  const [pipelineFileChoices, setPipelineFileChoices] = useState<Record<string, PipelineFileChoice>>({});
  const [pipelineChoicePage, setPipelineChoicePage] = useState(0);
  const [pipelineReport, setPipelineReport] = useState<PipelineInstallReport | null>(null);
  const [autoDeleteCurseForgeZip] = useState(() => {
    try {
      return window.localStorage.getItem(CURSEFORGE_AUTO_DELETE_KEY) === '1';
    } catch {
      return false;
    }
  });
  // search/filter
  const [q, setQ] = useState('');
  const [appliedModrinthQuery, setAppliedModrinthQuery] = useState('');
  const [sourceTab, setSourceTab] = useState<'all' | 'curseforge' | 'modrinth'>('all');
  const [mc, setMc] = useState('Any');
  const [loader, setLoader] = useState('Any');
  const [sort, setSort] = useState<'popular' | 'name'>('popular');
  const [pack, setPack] = useState<Modpack | null>(null);
  const [packVer, setPackVer] = useState(0);
  const [modrinthPacks, setModrinthPacks] = useState<ModrinthModpackDto[]>([]);
  const [modrinthTotalHits, setModrinthTotalHits] = useState(0);
  const [modrinthOffset, setModrinthOffset] = useState(0);
  const [modrinthLoading, setModrinthLoading] = useState(false);
  const [modrinthLoadingMore, setModrinthLoadingMore] = useState(false);
  const [modrinthError, setModrinthError] = useState('');
  const [modrinthRetry, setModrinthRetry] = useState(0);
  const modrinthRequestId = useRef(0);
  const [selectedModrinthPack, setSelectedModrinthPack] = useState<ModrinthModpackDto | null>(null);
  const [modrinthVersions, setModrinthVersions] = useState<ModrinthProjectVersionDto[]>([]);
  const [selectedModrinthVersionId, setSelectedModrinthVersionId] = useState('');
  const [modrinthVersionsLoading, setModrinthVersionsLoading] = useState(false);
  const [modrinthVersionsError, setModrinthVersionsError] = useState('');
  const [modrinthVersionsRetry, setModrinthVersionsRetry] = useState(0);
  const [modrinthInstallMc, setModrinthInstallMc] = useState('');
  const [modrinthInstallLoader, setModrinthInstallLoader] = useState<ModrinthInstallLoader | ''>('');
  const [modrinthBuildChoices, setModrinthBuildChoices] = useState<LoaderChoiceDto[]>([]);
  const [modrinthBuildLoading, setModrinthBuildLoading] = useState(false);
  const [modrinthBuildError, setModrinthBuildError] = useState('');
  const [modrinthBuildMc, setModrinthBuildMc] = useState('');
  const [modrinthBuildVersionId, setModrinthBuildVersionId] = useState('');
  const [modrinthBuildRetry, setModrinthBuildRetry] = useState(0);
  const modrinthBuildCacheRef = useRef(new Map<string, LoaderChoiceDto[]>());
  const modrinthBuildRequestsRef = useRef(new Map<string, Promise<LoaderChoiceDto[]>>());
  // configure
  const [name, setName] = useState('My Server');
  const [vanillaMc, setVanillaMc] = useState('1.20.4');
  const [serverLoader, setServerLoader] = useState('Vanilla');
  const [vanillaVersions, setVanillaVersions] = useState<MinecraftVersionDto[]>([]);
  const [paperVersions, setPaperVersions] = useState<MinecraftVersionDto[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState('');
  const [showSnapshots, setShowSnapshots] = useState<boolean>(() => {
    try {
      return localStorage.getItem('mc-showSnapshots') === '1';
    } catch {
      return false;
    }
  });
  const [showAllBuilds, setShowAllBuilds] = useState<boolean>(() => {
    try {
      return localStorage.getItem('mc-showAllBuilds') === '1';
    } catch {
      return false;
    }
  });
  const [loaderChoices, setLoaderChoices] = useState<LoaderChoiceDto[]>([]);
  const [selectedLoaderChoice, setSelectedLoaderChoice] = useState<LoaderChoiceDto | null>(null);
  const [loaderLoading, setLoaderLoading] = useState(false);
  const [loaderError, setLoaderError] = useState('');
  const [ram, setRam] = useState(4096);
  const [port, setPort] = useState(25568);
  const [eula, setEula] = useState(false);
  const [javaDetection, setJavaDetection] = useState<JavaDetection | null>(null);
  const [javaSelected, setJavaSelected] = useState<JavaCandidate | null>(null);
  const [javaPath, setJavaPath] = useState('');
  const [javaOverride, setJavaOverride] = useState(false);
  const [javaLoading, setJavaLoading] = useState(false);
  const [javaInstalling, setJavaInstalling] = useState(false);
  const [javaProgress, setJavaProgress] = useState(0);
  const [javaProgressLog, setJavaProgressLog] = useState('');
  const [javaError, setJavaError] = useState('');
  // install
  const [progress, setProgress] = useState(0);
  const [installing, setInstalling] = useState(false);
  const [installStage, setInstallStage] = useState('');
  const [installLogs, setInstallLogs] = useState<string[]>([]);
  const [installBytes, setInstallBytes] = useState<{ downloaded: number | null; total: number | null }>({
    downloaded: null,
    total: null,
  });
  const [installError, setInstallError] = useState('');
  const [installJobId, setInstallJobId] = useState<string | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const cancelRequestedRef = useRef(false);
  const installingRef = useRef(false);
  const installRequestStartedRef = useRef(false);
  const installTimerRef = useRef<number | null>(null);
  const [doneId, setDoneId] = useState<string | null>(null);

  const updateLocalMrpackSelection = (selection: LocalMrpackSelection | null) => {
    localMrpackRef.current = selection;
    setLocalMrpack(selection);
  };

  const releaseLocalMrpackSelection = (selection = localMrpackRef.current) => {
    if (!selection) return;
    if (hasBackend()) {
      void tauriModpackPipeline.releaseLocalMrpack(selection.sourceId).catch(() => undefined);
    }
    if (localMrpackRef.current?.sourceId === selection.sourceId) {
      localMrpackRef.current = null;
      setLocalMrpack(null);
    }
  };

  const results = useMemo(() => {
    if (hasBackend()) return [];
    let r = modpacks.filter((m) => (sourceTab === 'all' ? true : m.source === sourceTab));
    if (kind === 'curseforge') r = r.filter((m) => m.source === 'curseforge');
    if (kind === 'modrinth') r = r.filter((m) => m.source === 'modrinth');
    if (q) r = r.filter((m) => (m.name + m.author + m.summary).toLowerCase().includes(q.toLowerCase()));
    if (mc !== 'Any') r = r.filter((m) => m.mcVersions.includes(mc));
    if (loader !== 'Any') r = r.filter((m) => m.loaders.includes(loader));
    // Sort control is live: Popular = downloads desc; Name = A-Z.
    // (No updatedAt in mocks/data.ts, so Recent sort is not offered.)
    if (sort === 'name') return [...r].sort((a, b) => a.name.localeCompare(b.name));
    return [...r].sort((a, b) => b.downloads - a.downloads);
  }, [q, sourceTab, mc, loader, kind, sort]);

  const selectedModrinthVersion = modrinthVersions.find((version) => version.id === selectedModrinthVersionId) ?? null;
  const modrinthLoaderOptionList = useMemo(
    () => modrinthLoaderOptions(selectedModrinthVersion),
    [selectedModrinthVersion],
  );
  const modrinthSupportedGameVersions = useMemo(
    () => selectedModrinthVersion?.gameVersions.filter((version) =>
      vanillaVersions.some((candidate) => candidate.id === version && candidate.versionType === 'release'),
    ) ?? [],
    [selectedModrinthVersion, vanillaVersions],
  );
  const selectedModrinthLoaderOption = modrinthLoaderOptionList.find((option) => option.loader === modrinthInstallLoader) ?? null;
  const selectedModrinthLoaderChoice = modrinthInstallLoader
    ? modrinthBuildChoices.find((choice) => choice.loader === MODRINTH_INSTALLER_LOADER_NAMES[modrinthInstallLoader]) ?? null
    : null;
  const modrinthBuildUnavailable = Boolean(
    modrinthInstallLoader && !modrinthBuildLoading && !modrinthBuildError
    && modrinthBuildMc === modrinthInstallMc && modrinthBuildVersionId === selectedModrinthVersionId
    && !selectedModrinthLoaderChoice,
  );
  const modrinthRemoteInstallReady = Boolean(
    selectedModrinthPack && selectedModrinthVersion
    && modrinthSupportedGameVersions.includes(modrinthInstallMc)
    && selectedModrinthLoaderOption?.loader === modrinthInstallLoader
    && selectedModrinthLoaderChoice && modrinthBuildMc === modrinthInstallMc
    && modrinthBuildVersionId === selectedModrinthVersionId
    && !modrinthBuildLoading && !modrinthBuildError && !modrinthBuildUnavailable
    && !modrinthVersionsLoading && !modrinthVersionsError
    && !versionsLoading && javaSelected && !javaLoading && !javaInstalling
    && (!javaOverride || javaSelected.path === javaPath.trim())
  );
  const localModrinthInstallReady = Boolean(
    localMrpack && pipelinePreview && pipelinePreviewKey === `local:${localMrpack.sourceId}`
    && pipelinePreview.plan.loader.kind !== 'quilt'
    && javaSelected && !javaLoading && !javaInstalling
    && (!javaOverride || javaSelected.path === javaPath.trim())
  );
  const modrinthInstallReady = localMrpack ? localModrinthInstallReady : modrinthRemoteInstallReady;
  const curseforgeInspectionMatchesSelection = Boolean(
    curseforgeInspection && curseforgeInspection.name === curseforgeSelectedName,
  );
  const selectedCurseforgeInspection = curseforgeInspectionMatchesSelection ? curseforgeInspection : null;
  const hasPackSelected = Boolean(pack || localMrpack)
    || (hasBackend() && Boolean(selectedModrinthPack))
    || (hasBackend() && selectedCurseforgeInspection?.classification === 'supportedServerPack');

  const portConflict = usedPorts.includes(port);
  const recommended = hasPackSelected ? 8192 : 4096;
  const ramBelow = ram < recommended;
  const freeWarn = ram > FREE_RAM_MB;
  const configuredMcVersion = hasBackend() && kind === 'modrinth'
    ? modrinthInstallMc || vanillaMc
    : hasBackend() && kind === 'curseforge'
      ? selectedCurseforgeInspection?.minecraftVersion ?? ''
      : kind !== 'vanilla' && pack ? pack.packVersions[packVer].mc : vanillaMc;

  const clearPipelineReview = () => {
    if (pipelinePreview) {
      void tauriModpackPipeline.discardPreview(pipelinePreview.previewId).catch(() => undefined);
    }
    releaseLocalMrpackSelection();
    setPipelinePreview(null);
    setPipelinePreviewKey('');
    setPipelineFileChoices({});
    setPipelineChoicePage(0);
    setPipelineReport(null);
  };

  const selectCurseforgeZip = (name: string) => {
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

  const refreshCurseforgeZips = async (preferredName?: string) => {
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

  const openCurseforgeBrowser = async () => {
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

  const openCurseforgeExternal = async () => {
    try {
      await tauriCurseForge.openExternalBrowser();
      setCurseforgeBrowserMessage('CurseForge opened in your external browser. Use Browse for ZIP after downloading the SERVER pack.');
    } catch (error) {
      const message = errorText(error, 'Could not open CurseForge in the external browser.');
      setCurseforgeBrowserMessage(message);
      pushToast(message, 'err');
    }
  };

  const browseCurseforgeZip = async (file?: File) => {
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

  const inspectCurseforgeZip = async () => {
    const selectedName = curseforgeSelectedNameRef.current;
    if (!selectedName || selectedName !== curseforgeSelectedName) return;
    const requestId = ++curseforgeInspectionRequestId.current;
    const isCurrentRequest = () => requestId === curseforgeInspectionRequestId.current
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

  const continueToCurseforgeZipSelection = async () => {
    await refreshCurseforgeZips();
    setStep(2);
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

  useEffect(() => () => {
    const selection = localMrpackRef.current;
    if (selection && hasBackend()) {
      void tauriModpackPipeline.releaseLocalMrpack(selection.sourceId).catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => setAppliedModrinthQuery(q.trim()), 300);
    return () => window.clearTimeout(timeout);
  }, [q]);

  const modrinthQueryIndex: ModrinthSearchIndex = sort === 'popular' ? 'downloads' : 'relevance';
  const modrinthQueryKey = `${step}|${kind}|${appliedModrinthQuery}|${mc}|${loader}|${sort}`;
  const modrinthQueryKeyRef = useRef(modrinthQueryKey);
  modrinthQueryKeyRef.current = modrinthQueryKey;
  useEffect(() => {
    if (!hasBackend() || step !== 2 || kind !== 'modrinth') return;
    const requestId = ++modrinthRequestId.current;
    const queryKey = modrinthQueryKey;
    let cancelled = false;
    setModrinthLoading(true);
    setModrinthLoadingMore(false);
    setModrinthError('');
    setModrinthPacks([]);
    setModrinthTotalHits(0);
    setModrinthOffset(0);
    void tauriModrinth.searchModpacks(
      appliedModrinthQuery,
      mc === 'Any' ? null : mc,
      loader === 'Any' ? null : loader.toLowerCase(),
      modrinthQueryIndex,
      0,
      MODRINTH_PAGE_SIZE,
    ).then((response) => {
      if (cancelled || modrinthRequestId.current !== requestId || modrinthQueryKeyRef.current !== queryKey) return;
      setModrinthPacks(response.results);
      setModrinthTotalHits(response.totalHits);
      setModrinthOffset(response.offset + response.results.length);
    }).catch((error: unknown) => {
      if (cancelled || modrinthRequestId.current !== requestId || modrinthQueryKeyRef.current !== queryKey) return;
      setModrinthError(errorText(error, 'Could not load Modrinth modpacks.'));
    }).finally(() => {
      if (!cancelled && modrinthRequestId.current === requestId && modrinthQueryKeyRef.current === queryKey) setModrinthLoading(false);
    });
    return () => {
      cancelled = true;
      if (modrinthRequestId.current === requestId) modrinthRequestId.current += 1;
    };
  }, [step, kind, appliedModrinthQuery, mc, loader, modrinthQueryIndex, modrinthRetry]);

  const selectedModrinthProjectId = selectedModrinthPack?.id;
  useEffect(() => {
    if (!hasBackend() || !selectedModrinthProjectId) return;
    let cancelled = false;
    setModrinthVersionsLoading(true);
    setModrinthVersionsError('');
    setModrinthVersions([]);
    setSelectedModrinthVersionId('');
    void tauriModrinth.projectVersions(
      selectedModrinthProjectId,
      mc === 'Any' ? null : mc,
      loader === 'Any' ? null : loader.toLowerCase(),
    ).then((versions) => {
      if (cancelled) return;
      setModrinthVersions(versions);
      setSelectedModrinthVersionId(versions[0]?.id ?? '');
    }).catch((error: unknown) => {
      if (cancelled) return;
      setModrinthVersionsError(errorText(error, 'Could not load Modrinth project versions.'));
    }).finally(() => {
      if (!cancelled) setModrinthVersionsLoading(false);
    });
    return () => { cancelled = true; };
  }, [selectedModrinthProjectId, mc, loader, modrinthVersionsRetry]);

  useEffect(() => {
    if (!selectedModrinthVersion) {
      setModrinthInstallMc('');
      setModrinthInstallLoader('');
      return;
    }
    if (!modrinthSupportedGameVersions.includes(modrinthInstallMc) && !versionsLoading) {
      setModrinthInstallMc(modrinthSupportedGameVersions[0] ?? '');
    }
    const supportedLoaderIds = modrinthLoaderOptionList
      .filter((option): option is ModrinthLoaderOption & { loader: ModrinthInstallLoader } => option.loader !== null)
      .map((option) => option.loader);
    if (!supportedLoaderIds.includes(modrinthInstallLoader as ModrinthInstallLoader)) {
      setModrinthInstallLoader(supportedLoaderIds[0] ?? '');
    }
  }, [
    selectedModrinthVersion,
    modrinthInstallMc,
    modrinthInstallLoader,
    modrinthSupportedGameVersions,
    modrinthLoaderOptionList,
    versionsLoading,
  ]);

  useEffect(() => {
    if (!hasBackend() || kind !== 'modrinth' || !modrinthInstallMc || !selectedModrinthVersion) {
      setModrinthBuildChoices([]);
      setModrinthBuildError('');
      setModrinthBuildMc('');
      setModrinthBuildVersionId('');
      setModrinthBuildLoading(false);
      return;
    }
    const cachedBuilds = modrinthBuildCacheRef.current.get(modrinthInstallMc);
    if (cachedBuilds?.length) {
      setModrinthBuildChoices(cachedBuilds);
      setModrinthBuildMc(modrinthInstallMc);
      setModrinthBuildVersionId(selectedModrinthVersionId);
      setModrinthBuildError('');
      setModrinthBuildLoading(false);
      return;
    }
    let cancelled = false;
    setModrinthBuildLoading(true);
    setModrinthBuildError('');
    setModrinthBuildChoices([]);
    setModrinthBuildMc('');
    setModrinthBuildVersionId('');
    const subscribeToBuildRequest = (request: Promise<LoaderChoiceDto[]>) => {
      void request.then((choices) => {
        if (modrinthBuildRequestsRef.current.get(modrinthInstallMc) === request) {
          modrinthBuildRequestsRef.current.delete(modrinthInstallMc);
        }
        if (choices.length > 0) {
          modrinthBuildCacheRef.current.set(modrinthInstallMc, choices);
        }
        if (cancelled) return;
        setModrinthBuildChoices(choices);
        setModrinthBuildMc(modrinthInstallMc);
        setModrinthBuildVersionId(selectedModrinthVersionId);
      }).catch((error: unknown) => {
        if (modrinthBuildRequestsRef.current.get(modrinthInstallMc) === request) {
          modrinthBuildRequestsRef.current.delete(modrinthInstallMc);
        }
        if (cancelled) return;
        setModrinthBuildChoices([]);
        setModrinthBuildMc(modrinthInstallMc);
        setModrinthBuildVersionId(selectedModrinthVersionId);
        setModrinthBuildError(errorText(error, `Could not verify server loaders for Minecraft ${modrinthInstallMc}.`));
      }).finally(() => {
        if (!cancelled) setModrinthBuildLoading(false);
      });
    };
    const pendingRequest = modrinthBuildRequestsRef.current.get(modrinthInstallMc);
    if (pendingRequest) {
      subscribeToBuildRequest(pendingRequest);
      return () => { cancelled = true; };
    }
    const timeout = window.setTimeout(() => {
      const existingRequest = modrinthBuildRequestsRef.current.get(modrinthInstallMc);
      const request = existingRequest ?? tauriVersions.loaders(modrinthInstallMc);
      if (!existingRequest) modrinthBuildRequestsRef.current.set(modrinthInstallMc, request);
      subscribeToBuildRequest(request);
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [kind, modrinthInstallMc, selectedModrinthVersionId, modrinthBuildRetry]);

  const loadMoreModrinth = async () => {
    if (!hasBackend() || modrinthLoading || modrinthLoadingMore || modrinthOffset >= modrinthTotalHits) return;
    const requestId = modrinthRequestId.current;
    const queryKey = modrinthQueryKey;
    setModrinthLoadingMore(true);
    setModrinthError('');
    try {
      const response = await tauriModrinth.searchModpacks(
        appliedModrinthQuery,
        mc === 'Any' ? null : mc,
        loader === 'Any' ? null : loader.toLowerCase(),
        modrinthQueryIndex,
        modrinthOffset,
        MODRINTH_PAGE_SIZE,
      );
      if (modrinthRequestId.current !== requestId || modrinthQueryKeyRef.current !== queryKey) return;
      setModrinthPacks((previous) => [...previous, ...response.results]);
      setModrinthTotalHits(response.totalHits);
      setModrinthOffset(response.offset + response.results.length);
    } catch (error) {
      if (modrinthRequestId.current !== requestId || modrinthQueryKeyRef.current !== queryKey) return;
      setModrinthError(errorText(error, 'Could not load more Modrinth modpacks.'));
    } finally {
      if (modrinthRequestId.current === requestId && modrinthQueryKeyRef.current === queryKey) setModrinthLoadingMore(false);
    }
  };

  const displayedModrinthPacks = useMemo(() => {
    if (sort !== 'name') return modrinthPacks;
    const sortedPages: ModrinthModpackDto[] = [];
    for (let offset = 0; offset < modrinthPacks.length; offset += MODRINTH_PAGE_SIZE) {
      sortedPages.push(...modrinthPacks.slice(offset, offset + MODRINTH_PAGE_SIZE)
        .sort((a, b) => a.name.localeCompare(b.name)));
    }
    return sortedPages;
  }, [modrinthPacks, sort]);

  useEffect(() => {
    if (!hasBackend()) return;
    let cancelled = false;
    setVersionsLoading(true);
    setVersionsError('');
    void Promise.allSettled([tauriVersions.vanilla(), tauriVersions.paper()]).then(([vanilla, paper]) => {
      if (cancelled) return;
      const errors: string[] = [];
      if (vanilla.status === 'fulfilled') {
        setVanillaVersions(vanilla.value);
        setVanillaMc((current) =>
          vanilla.value.some((version) => version.id === current) ? current : vanilla.value[0]?.id ?? '',
        );
      } else {
        setVanillaVersions([]);
        errors.push('Mojang version metadata is unavailable.');
      }
      if (paper.status === 'fulfilled') {
        setPaperVersions(paper.value);
      } else {
        setPaperVersions([]);
        errors.push('Paper version metadata is unavailable.');
      }
      setVersionsError(errors.join(' '));
    }).finally(() => {
      if (!cancelled) setVersionsLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const configureVersions = serverLoader === 'Paper' ? paperVersions : vanillaVersions;
  const filteredConfigureVersions = useMemo(
    () => configureVersions.filter((version) => showSnapshots || version.versionType === 'release'),
    [configureVersions, showSnapshots],
  );
  const selectedVersionDto = configureVersions.find((version) => version.id === vanillaMc) ?? null;
  const snapshotStale = Boolean(
    hasBackend() && kind === 'vanilla' && selectedVersionDto
    && selectedVersionDto.versionType !== 'release' && !showSnapshots,
  );
  const displayedLoaderChoices = useMemo(
    () => (showAllBuilds ? loaderChoices : loaderChoices.filter((choice) => choice.stable !== false)),
    [loaderChoices, showAllBuilds],
  );
  const loaderToggleStale = Boolean(
    !showAllBuilds && selectedLoaderChoice && selectedLoaderChoice.stable === false,
  );
  useEffect(() => {
    try {
      localStorage.setItem('mc-showSnapshots', showSnapshots ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  }, [showSnapshots]);
  useEffect(() => {
    try {
      localStorage.setItem('mc-showAllBuilds', showAllBuilds ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  }, [showAllBuilds]);
  useEffect(() => {
    if (!hasBackend() || versionsLoading || configureVersions.length === 0) return;
    if (!configureVersions.some((version) => version.id === vanillaMc)) {
      const fallback = filteredConfigureVersions[0] ?? configureVersions[0];
      if (fallback) setVanillaMc(fallback.id);
    }
  }, [configureVersions, filteredConfigureVersions, serverLoader, vanillaMc, versionsLoading]);

  useEffect(() => {
    if (!hasBackend() || kind !== 'vanilla' || !vanillaMc) return;
    let cancelled = false;
    setLoaderLoading(true);
    setLoaderError('');
    void tauriVersions.loaders(vanillaMc).then((choices) => {
      if (cancelled) return;
      setLoaderChoices(choices);
      const preferred = choices.find((choice) => choice.loader === serverLoader);
      if (preferred) {
        setSelectedLoaderChoice(preferred);
      } else {
        setSelectedLoaderChoice(null);
        setLoaderError(serverLoader + ' has no provider-verified build for Minecraft ' + vanillaMc + '.');
      }
    }).catch((err: unknown) => {
      if (cancelled) return;
      const message = err && typeof err === 'object' && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'Could not resolve compatible server loaders.';
      setLoaderChoices([]);
      setSelectedLoaderChoice(null);
      setLoaderError(message);
    }).finally(() => {
      if (!cancelled) setLoaderLoading(false);
    });
    return () => { cancelled = true; };
  }, [vanillaMc, serverLoader, kind]);

  useEffect(() => {
    if (!hasBackend() || !configuredMcVersion) {
      setJavaLoading(false);
      if (hasBackend()) {
        setJavaDetection(null);
        setJavaSelected(null);
        setJavaPath('');
        setJavaOverride(false);
      }
      return;
    }
    let cancelled = false;
    setJavaLoading(true);
    setJavaError('');
    void tauriJava.detect(configuredMcVersion).then((detection) => {
      if (cancelled) return;
      const candidate = detection.candidates.find((runtime) => runtime.major === detection.installMajor) ?? null;
      setJavaDetection(detection);
      setJavaSelected(candidate);
      setJavaPath(candidate?.path ?? '');
      setJavaOverride(false);
    }).catch((err: unknown) => {
      if (cancelled) return;
      const message = err && typeof err === 'object' && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'Could not inspect Java for this Minecraft version.';
      setJavaDetection(null);
      setJavaSelected(null);
      setJavaPath('');
      setJavaError(message);
      pushToast(message, 'err');
    }).finally(() => {
      if (!cancelled) setJavaLoading(false);
    });
    return () => { cancelled = true; };
  }, [configuredMcVersion, pushToast]);

  const installJava = async () => {
    if (!hasBackend() || !javaDetection || javaInstalling) return;
    setJavaInstalling(true);
    setJavaProgress(0);
    setJavaProgressLog('Starting Temurin download…');
    setJavaError('');
    const jobId = `java-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await onJobProgress(jobId, (payload) => {
        setJavaProgress(payload.progress);
        setJavaProgressLog(payload.log ?? 'Installing Java…');
      });
      const candidate = await tauriJava.ensure(javaDetection.installMajor, jobId);
      setJavaSelected(candidate);
      setJavaPath(candidate.path);
      setJavaOverride(false);
      setJavaProgress(100);
      setJavaProgressLog(`Temurin Java ${candidate.major} is ready.`);
      pushToast(`Temurin Java ${candidate.major} is ready.`, 'ok');
    } catch (err) {
      const message = err && typeof err === 'object' && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'Java installation failed.';
      setJavaError(message);
      pushToast(message, 'err');
    } finally {
      unlisten?.();
      setJavaInstalling(false);
    }
  };

  const activePipelineSource = (): { request: PipelineSourceRequest; key: string } | null => {
    if (kind === 'curseforge') {
      if (!curseforgeSelectedName || !selectedCurseforgeInspection
        || selectedCurseforgeInspection.classification !== 'supportedServerPack') return null;
      return {
        request: { kind: 'curseForgeServerZip', zipName: curseforgeSelectedName },
        key: `curseforge:${curseforgeSelectedName}`,
      };
    }
    if (kind !== 'modrinth') return null;
    if (localMrpack) {
      return {
        request: { kind: 'localMrpack', sourceId: localMrpack.sourceId },
        key: `local:${localMrpack.sourceId}`,
      };
    }
    if (!selectedModrinthPack || !selectedModrinthVersion || !modrinthInstallLoader
      || !selectedModrinthLoaderChoice || !javaSelected) return null;
    const loaderKind: PipelineLoaderPin['kind'] = modrinthInstallLoader === 'minecraft'
      ? 'vanilla'
      : modrinthInstallLoader === 'neoforge'
        ? 'neoForge'
        : modrinthInstallLoader;
    const loaderPin: PipelineLoaderPin = {
      kind: loaderKind,
      minecraftVersion: modrinthInstallMc,
      loaderVersion: loaderKind === 'vanilla' ? null : selectedModrinthLoaderChoice.version ?? null,
    };
    return {
      request: {
        kind: 'modrinthRemote',
        projectId: selectedModrinthPack.id,
        versionId: selectedModrinthVersion.id,
        loader: loaderPin,
        javaPath: javaSelected.path,
      },
      key: `remote:${selectedModrinthPack.id}:${selectedModrinthVersion.id}:${modrinthInstallMc}:${loaderKind}:${loaderPin.loaderVersion}:${javaSelected.path}`,
    };
  };

  const initialPipelineChoices = (preview: PipelinePreviewDto): Record<string, PipelineFileChoice> => {
    const choices: Record<string, PipelineFileChoice> = {};
    for (const decision of preview.plan.fileDecisions) {
      if (decision.reason === 'optionalDefaultKeep') choices[decision.path] = 'include';
    }
    return choices;
  };

  const runPipelinePreview = async (sourceOverride?: { request: PipelineSourceRequest; key: string }) => {
    const source = sourceOverride ?? activePipelineSource();
    if (!source) {
      pushToast('Choose a supported pack source and exact server loader first.', 'err');
      return;
    }
    if (installingRef.current) return;
    if (source.request.kind === 'modrinthRemote' && (!javaSelected || javaLoading || javaInstalling)) {
      pushToast('Select a compatible Java runtime before reviewing this remote pack.', 'err');
      return;
    }
    if (pipelinePreview) {
      void tauriModpackPipeline.discardPreview(pipelinePreview.previewId).catch(() => undefined);
    }
    installingRef.current = true;
    cancelRequestedRef.current = false;
    installRequestStartedRef.current = false;
    setCancelRequested(false);
    setInstalling(true);
    setInstallError('');
    setDoneId(null);
    setPipelineReport(null);
    setProgress(0);
    setInstallStage('Reviewing modpack files');
    setInstallLogs([]);
    setInstallBytes({ downloaded: null, total: null });
    const previousStep = step;
    setStep(4);
    const jobId = 'modpack-preview-' + window.crypto.randomUUID();
    setInstallJobId(jobId);
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await onJobProgress(jobId, (payload) => {
        const stage = payload.stage ?? 'Reviewing modpack files';
        setProgress((previous) => Math.max(previous, Math.max(0, Math.min(100, payload.progress))));
        setInstallStage(stage);
        setInstallBytes({
          downloaded: payload.bytesDownloaded ?? null,
          total: payload.bytesTotal ?? null,
        });
        if (payload.log) setInstallLogs((previous) => [...previous, `[${stage}] ${payload.log}`].slice(-200));
      });
      if (cancelRequestedRef.current) return;
      installRequestStartedRef.current = true;
      const preview = await tauriModpackPipeline.preview(source.request, jobId);
      setPipelinePreview(preview);
      setPipelinePreviewKey(source.key);
      setPipelineFileChoices(initialPipelineChoices(preview));
      setPipelineChoicePage(0);
      setInstallStage('Review ready');
      setProgress(100);
      if (source.request.kind === 'localMrpack') {
        const pin = preview.plan.loader;
        setModrinthInstallMc(pin.minecraftVersion);
        const selectedLoader: ModrinthInstallLoader | '' = pin.kind === 'vanilla'
          ? 'minecraft'
          : pin.kind === 'neoForge'
            ? 'neoforge'
            : pin.kind === 'quilt' ? '' : pin.kind;
        setModrinthInstallLoader(selectedLoader);
        setVanillaMc(pin.minecraftVersion);
      }
      setStep(3);
    } catch (error) {
      const message = errorText(error, 'Could not review the selected modpack.');
      if (cancelRequestedRef.current || message.toLowerCase().includes('cancelled')) {
        setInstallError('');
        setProgress(0);
        setStep(previousStep);
        pushToast('Pack review cancelled. No server files were changed.', 'info');
      } else {
        setInstallError(message);
        setStep(previousStep);
        pushToast(message, 'err');
      }
    } finally {
      unlisten?.();
      installingRef.current = false;
      setInstalling(false);
      setInstallJobId(null);
      setCancelRequested(false);
      cancelRequestedRef.current = false;
      installRequestStartedRef.current = false;
    }
  };

  const installPipelinePreview = async () => {
    const source = activePipelineSource();
    if (!source || !pipelinePreview || pipelinePreviewKey !== source.key) {
      pushToast('The selected pack changed; review its files again.', 'err');
      return;
    }
    if (!name.trim()) {
      pushToast('Give the server a name first.', 'err');
      return;
    }
    const hasUnresolved = pipelinePreview.plan.fileDecisions.some(
      (decision) => decision.action === 'awaitingUserChoice'
        && pipelineFileChoices[decision.path] === undefined,
    );
    if (hasUnresolved) {
      pushToast('Choose Include or Exclude for every conflicting file.', 'err');
      return;
    }
    if (!javaSelected || javaLoading || javaInstalling
      || (javaOverride && javaSelected.path !== javaPath.trim())) {
      pushToast('Select a compatible Java runtime first.', 'err');
      return;
    }
    if (installingRef.current) return;
    installingRef.current = true;
    cancelRequestedRef.current = false;
    installRequestStartedRef.current = false;
    setCancelRequested(false);
    setInstalling(true);
    setInstallError('');
    setDoneId(null);
    setPipelineReport(null);
    setProgress(0);
    setInstallStage('Preparing exact server runtime');
    setInstallLogs([]);
    setInstallBytes({ downloaded: null, total: null });
    setStep(4);
    const jobId = 'modpack-install-' + window.crypto.randomUUID();
    setInstallJobId(jobId);
    const input: PipelineCreateInput = {
      name: name.trim(),
      port,
      ramMb: ram,
      javaPath: javaSelected.path,
      eulaAccepted: eula,
    };
    const choices = {
      files: pipelineFileChoices,
      approvedReplacements: [],
      autoDeleteCurseForgeZip: kind === 'curseforge' && autoDeleteCurseForgeZip,
    };
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await onJobProgress(jobId, (payload) => {
        const stage = payload.stage ?? 'Installing modpack server';
        setProgress((previous) => Math.max(previous, Math.max(0, Math.min(100, payload.progress))));
        setInstallStage(stage);
        setInstallBytes({
          downloaded: payload.bytesDownloaded ?? null,
          total: payload.bytesTotal ?? null,
        });
        if (payload.log) setInstallLogs((previous) => [...previous, `[${stage}] ${payload.log}`].slice(-200));
      });
      if (cancelRequestedRef.current) return;
      installRequestStartedRef.current = true;
      const result = await tauriModpackPipeline.install(
        pipelinePreview.previewId,
        input,
        choices,
        jobId,
      );
      setPipelineReport(result.report);
      if (result.status === 'complete' && result.server) {
        const modpackLabel = kind === 'curseforge'
          ? `CurseForge server pack · ${curseforgeSelectedName}`
          : localMrpack?.fileName ?? selectedModrinthPack?.name ?? 'Modrinth modpack';
        addServer(serverFromInstall(result.server, recommended, modpackLabel));
        setDoneId(result.server.id);
        setProgress(100);
        setInstallStage('Complete');
        setInstallError('');
        setPipelinePreview(null);
        setPipelinePreviewKey('');
        setPipelineFileChoices({});
        setPipelineChoicePage(0);
        pushToast('Modpack server installed and saved.', 'ok');
      } else {
        void tauriModpackPipeline.discardPreview(pipelinePreview.previewId).catch(() => undefined);
        setPipelinePreview(null);
        setPipelinePreviewKey('');
        setPipelineFileChoices({});
        setPipelineChoicePage(0);
        setInstallError(result.error ?? result.report.errors.join('\n') ?? 'Modpack installation failed.');
        setProgress(0);
        if (result.status === 'cancelled') setStep(3);
      }
    } catch (error) {
      const message = errorText(error, 'Modpack server installation failed.');
      void tauriModpackPipeline.discardPreview(pipelinePreview.previewId).catch(() => undefined);
      setPipelinePreview(null);
      setPipelinePreviewKey('');
      setPipelineFileChoices({});
      setPipelineChoicePage(0);
      setInstallError(message);
      setPipelineReport(null);
      setProgress(0);
      if (cancelRequestedRef.current || message.toLowerCase().includes('cancelled')) {
        setStep(3);
        pushToast('Installation cancelled. No unverified files were published.', 'info');
      } else {
        pushToast(message, 'err');
      }
    } finally {
      unlisten?.();
      installingRef.current = false;
      setInstalling(false);
      setInstallJobId(null);
      setCancelRequested(false);
      cancelRequestedRef.current = false;
      installRequestStartedRef.current = false;
    }
  };

  const pickLocalMrpack = async (file?: File) => {
    try {
      const selection = isDesktop()
        ? await tauriModpackPipeline.pickLocalMrpack()
        : file
          ? await tauriModpackPipeline.uploadLocalMrpack(file)
          : null;
      if (!selection) return;
      clearPipelineReview();
      updateLocalMrpackSelection(selection);
      setSelectedModrinthPack(null);
      setModrinthVersions([]);
      setSelectedModrinthVersionId('');
      setPipelinePreview(null);
      setPipelinePreviewKey('');
      setKind('modrinth');
      setStep(2);
      await runPipelinePreview({
        request: { kind: 'localMrpack', sourceId: selection.sourceId },
        key: `local:${selection.sourceId}`,
      });
    } catch (error) {
      pushToast(errorText(error, 'Could not select a local .mrpack file.'), 'err');
    }
  };

  const validateJavaOverride = async () => {
    if (!javaPath.trim()) {
      setJavaError('Enter a JDK home folder or java.exe path.');
      return;
    }
    try {
      const candidate = await tauriJava.validate(configuredMcVersion, javaPath);
      setJavaSelected(candidate);
      setJavaPath(candidate.path);
      setJavaOverride(true);
      setJavaError('');
      pushToast(`Java ${candidate.major} is compatible with Minecraft ${configuredMcVersion}.`, 'ok');
    } catch (err) {
      const message = err && typeof err === 'object' && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'Java path could not be validated.';
      setJavaError(message);
      pushToast(message, 'err');
    }
  };

  const beginInstall = async () => {
    if (!name.trim()) {
      pushToast('Give the server a name first.', 'err');
      return;
    }
    if (hasBackend() && (kind === 'curseforge' || kind === 'modrinth')) {
      const source = activePipelineSource();
      if (!source || !pipelinePreview || pipelinePreviewKey !== source.key) {
        await runPipelinePreview();
      } else {
        await installPipelinePreview();
      }
      return;
    }
    if (hasBackend()) {
      if (installingRef.current) return;
      if (!selectedLoaderChoice || loaderLoading || versionsLoading) {
        pushToast('Wait for supported versions and loader choices to finish loading.', 'err');
        return;
      }
      if (snapshotStale) {
        pushToast('The selected Minecraft version is a snapshot. Enable "Show snapshots" or choose a release before installing.', 'err');
        return;
      }
      if (loaderError || loaderToggleStale || selectedLoaderChoice.loader !== serverLoader) {
        pushToast('Choose an available version of the selected server loader before installing.', 'err');
        return;
      }
      if (!javaSelected || javaLoading || javaInstalling
        || (javaOverride && javaSelected.path !== javaPath.trim())) {
        pushToast('Select or install a compatible Java runtime first.', 'err');
        return;
      }
      installingRef.current = true;
      cancelRequestedRef.current = false;
      installRequestStartedRef.current = false;
      setCancelRequested(false);
      setInstalling(true);
      setInstallError('');
      setDoneId(null);
      setProgress(0);
      setInstallStage('Preparing');
      setInstallLogs([]);
      setInstallBytes({ downloaded: null, total: null });
      setStep(4);
      const jobId = 'install-' + window.crypto.randomUUID();
      setInstallJobId(jobId);
      const input: CreateServerInput = {
        name: name.trim(),
        loader: selectedLoaderChoice.loader,
        mcVersion: vanillaMc,
        loaderVersion: selectedLoaderChoice.version ?? undefined,
        port,
        ramMb: ram,
        javaPath: javaSelected.path,
        eulaAccepted: eula,
      };
      let unlisten: (() => void) | undefined;
      try {
        unlisten = await onJobProgress(jobId, (payload) => {
          const stage = payload.stage ?? 'Installing';
          setProgress(payload.progress);
          setInstallStage(stage);
          setInstallBytes({
            downloaded: payload.bytesDownloaded ?? null,
            total: payload.bytesTotal ?? null,
          });
          if (payload.log) {
            setInstallLogs((previous) =>
              [...previous, '[' + stage + '] ' + payload.log].slice(-200),
            );
          }
        });
        if (cancelRequestedRef.current) {
          setStep(3);
          setProgress(0);
          pushToast('Installation cancelled before it started.', 'info');
          return;
        }
        installRequestStartedRef.current = true;
        const dto = await tauriInstall.install(input, jobId);
        addServer(serverFromInstall(dto, recommended));
        setDoneId(dto.id);
        setInstalling(false);
        setProgress(100);
        setInstallStage('Complete');
        setInstallError('');
        pushToast('Server installed and saved.', 'ok');
      } catch (err) {
        const message = err && typeof err === 'object' && 'message' in err
          ? String((err as { message: unknown }).message)
          : 'Server installation failed.';
        if (cancelRequestedRef.current || message.toLowerCase().includes('cancelled')) {
          setStep(3);
          setInstallError('');
          setProgress(0);
          pushToast('Installation cancelled and staging files removed.', 'info');
        } else {
          setInstallError(message);
          pushToast(message, 'err');
        }
      } finally {
        unlisten?.();
        installingRef.current = false;
        setInstalling(false);
        setInstallJobId(null);
        setCancelRequested(false);
        cancelRequestedRef.current = false;
        installRequestStartedRef.current = false;
      }
      return;
    }
    if (installingRef.current) return;
    installingRef.current = true;
    setStep(4);
    setInstalling(true);
    setProgress(0);
    setInstallError('');
    setDoneId(null);
    installTimerRef.current = window.setInterval(() => {
      setProgress((p) => {
        if (p >= 100) {
          if (installTimerRef.current !== null) window.clearInterval(installTimerRef.current);
          installTimerRef.current = null;
          installingRef.current = false;
          return 100;
        }
        return p + Math.round(4 + Math.random() * 9);
      });
    }, 220);
  };

  const cancelInstall = async () => {
    if (hasBackend()) {
      if (!installJobId || cancelRequestedRef.current) return;
      cancelRequestedRef.current = true;
      setCancelRequested(true);
      if (!installRequestStartedRef.current) return;
      try {
        const accepted = kind === 'modrinth' || kind === 'curseforge'
          ? await tauriModpackPipeline.cancel(installJobId)
          : await tauriInstall.cancel(installJobId);
        if (!accepted) {
          cancelRequestedRef.current = false;
          setCancelRequested(false);
          pushToast('The install is already being published. Wait for it to finish.', 'info');
        }
      } catch (err) {
          cancelRequestedRef.current = false;
          setCancelRequested(false);
          const message = err && typeof err === 'object' && 'message' in err
            ? String((err as { message: unknown }).message)
            : 'Could not cancel the installation.';
        pushToast(message, 'err');
      }
      return;
    }
    if (installTimerRef.current !== null) window.clearInterval(installTimerRef.current);
    installTimerRef.current = null;
    installingRef.current = false;
    setInstalling(false);
    setProgress(0);
    pushToast('Install cancelled (mock).', 'info');
  };

  const finishInstall = () => {
    if (hasBackend()) return;
    const isMod = kind !== 'vanilla';
    const mcVersion = isMod && pack ? pack.packVersions[packVer].mc : vanillaMc;
    const resolvedLoader = isMod && pack ? pack.packVersions[packVer].loader.split(' ')[0] : 'Vanilla';
    const id = `srv-${Date.now()}`;
    addServer({
      id,
      name: name.trim(),
      status: 'stopped',
      mcVersion,
      loader: resolvedLoader,
      loaderVersion: isMod && pack ? pack.packVersions[packVer].loader : undefined,
      modpack: isMod && pack ? pack.name : undefined,
      playersOnline: 0,
      maxPlayers: 20,
      port,
      ramMb: ram,
      ramRecommendedMb: recommended,
      uptimeSec: 0,
      cpuPct: 0,
      ramPct: 0,
      tps: null,
      mspt: null,
      address: '127.0.0.1',
      eulaAccepted: eula,
      motd: 'A fresh server!',
      difficulty: 'Normal',
      gamemode: 'Survival',
      onlineMode: true,
      seed: String(Math.floor(Math.random() * 1e9)),
      worldName: 'world',
      worldSizeMb: 0,
      worldLastPlayed: '—',
      version: `${isMod && pack ? pack.packVersions[packVer].mc : vanillaMc} ${isMod && pack ? pack.packVersions[packVer].loader.split(' ')[0] : 'Vanilla'}`,
    });
    // Auto pre-first-run backup note (spec) — logged as toast in MVP.
    pushToast('Pre-first-run backup snapshot created (mock).', 'ok');
    setDoneId(id);
    setInstalling(false);
    installingRef.current = false;
  };

  const pickPack = (m: Modpack) => {
    setPack(m);
    setPackVer(0);
    setSelectedModrinthPack(null);
    setKind(m.source);
    setRam(8192);
    setStep(3);
  };

  const pickModrinthPack = (m: ModrinthModpackDto) => {
    clearPipelineReview();
    setPack(null);
    setSelectedModrinthPack(m);
    setSelectedModrinthVersionId('');
    setKind('modrinth');
    setRam(8192);
    setStep(3);
  };

  const currentPipelineSource = activePipelineSource();
  const pipelinePreviewMatchesSource = Boolean(
    pipelinePreview && currentPipelineSource && pipelinePreviewKey === currentPipelineSource.key,
  );
  const currentPipelineDecisions = pipelinePreviewMatchesSource
    ? pipelinePreview?.plan.fileDecisions ?? []
    : [];
  const unresolvedPipelineChoiceCount = currentPipelineDecisions.filter(
    (decision) => decision.action === 'awaitingUserChoice'
      && pipelineFileChoices[decision.path] === undefined,
  ).length;
  const reviewChoices = currentPipelineDecisions.filter(
    (decision) => decision.reason === 'optionalDefaultKeep' || decision.action === 'awaitingUserChoice',
  );
  const skippedPipelineFiles = currentPipelineDecisions.filter((decision) => decision.action === 'exclude');
  const reportOutcomeCounts = (pipelineReport?.files ?? []).reduce<Record<string, number>>((counts, file) => {
    counts[file.outcome] = (counts[file.outcome] ?? 0) + 1;
    return counts;
  }, {});
  const pipelineChoicePageCount = Math.max(1, Math.ceil(reviewChoices.length / MAX_REPORT_DETAIL_ROWS));
  const visibleReviewChoices = reviewChoices.slice(
    pipelineChoicePage * MAX_REPORT_DETAIL_ROWS,
    (pipelineChoicePage + 1) * MAX_REPORT_DETAIL_ROWS,
  );

  return (
    <div className="mc-create-container mx-auto w-full min-w-0 max-w-4xl space-y-4">
      <input
        ref={localMrpackInputRef}
        type="file"
        accept=".mrpack,application/zip"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void pickLocalMrpack(file);
        }}
      />
      <input
        ref={curseforgeZipInputRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void browseCurseforgeZip(file);
        }}
      />
      <ol className="flex flex-wrap gap-2 text-xs">
        {['1 Type', '2 Browse', '3 Configure', '4 Install'].map((s, i) => (
          <li key={s} className={`rounded px-2 py-1 ${step === i + 1 ? 'bg-emerald-900 text-emerald-200' : 'bg-zinc-900 text-zinc-500'}`}>{s}</li>
        ))}
      </ol>

      {step === 1 && (
        hasBackend() ? (
          <>
            <div className="mc-create-type-grid grid gap-3">
              {([
                { loader: 'Vanilla', title: 'Vanilla', detail: 'Official Mojang server JAR.' },
                { loader: 'Paper', title: 'Paper', detail: 'Full Paper build catalogue, stable first.' },
                { loader: 'Fabric', title: 'Fabric', detail: 'Provider-verified Fabric server builds.' },
                { loader: 'Forge', title: 'Forge', detail: 'Full Forge catalogue including specific versions.' },
                { loader: 'NeoForge', title: 'NeoForge', detail: 'Versions mapped to supported Minecraft releases.' },
              ] as { loader: string; title: string; detail: string }[]).map((choice) => (
                <button
                  key={choice.loader}
                  onClick={() => {
                    clearPipelineReview();
                    setKind('vanilla');
                    if (serverLoader !== choice.loader) {
                      setSelectedLoaderChoice(null);
                      setLoaderChoices([]);
                      setLoaderError('');
                    }
                    setServerLoader(choice.loader);
                    setPack(null);
                    setSelectedModrinthPack(null);
                    setStep(3);
                  }}
                  className={'mc-edition ' + (serverLoader === choice.loader ? 'mc-edition-active' : '')}
                >
                  <div className="mc-pixel text-[10px]">{choice.title}</div>
                  <div className="mc-edition-sub mt-1 text-xs">{choice.detail}</div>
                </button>
              ))}
            </div>
          <button
            onClick={() => {
                clearPipelineReview();
                setKind('modrinth');
                setPack(null);
                setSelectedModrinthPack(null);
                setSourceTab('modrinth');
                setStep(2);
              }}
              className="mc-edition"
            >
              <div className="text-3xl">💠</div>
              <div className="mc-pixel mt-2 text-[10px]">Modrinth modpacks</div>
              <div className="mc-edition-sub mt-1 text-xs">Browse the live Modrinth catalog and inspect exact versions.</div>
            </button>
            <button
              type="button"
              onClick={() => {
                clearPipelineReview();
                setKind('curseforge');
                setPack(null);
                setSelectedModrinthPack(null);
                selectCurseforgeZip('');
              }}
              className={'mc-edition ' + (kind === 'curseforge' ? 'mc-edition-active' : '')}
            >
              <div className="text-3xl">🔥</div>
              <div className="mc-pixel mt-2 text-[10px]">CurseForge server pack</div>
              <div className="mc-edition-sub mt-1 text-xs">Open CurseForge and import an author-provided SERVER ZIP.</div>
            </button>
          {kind === 'curseforge' && (
            <Card>
              <CardTitle>Find the server pack</CardTitle>
              <p className="text-sm text-zinc-300">
                On a modpack page, open <strong>Files</strong>, choose a version, then open <strong>Additional Files</strong> and download the <strong>SERVER</strong> pack. The regular client modpack ZIP is not a server installation archive; some projects do not offer a server pack.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button onClick={() => { void openCurseforgeBrowser(); }}>Open CurseForge</Button>
                <Button variant="secondary" onClick={() => { void openCurseforgeExternal(); }}>Open in External Browser</Button>
              </div>
              {curseforgeBrowserMessage && <p role="status" className="mt-2 text-xs text-zinc-300">{curseforgeBrowserMessage}</p>}
              {curseforgeDownloads.length > 0 && (
                <div className="mt-3 space-y-2" aria-label="CurseForge downloads">
                  {curseforgeDownloads.map((download) => {
                    const activeDownload = ['starting', 'downloading', 'canceling'].includes(download.status);
                    const percent = download.totalBytes && download.totalBytes > 0
                      ? Math.min(100, Math.round(download.bytesReceived / download.totalBytes * 100))
                      : null;
                    return (
                      <div key={download.id} className="rounded border border-zinc-800 bg-zinc-950 p-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="min-w-0 break-all text-sm">{download.name}</span>
                          <span className="text-xs text-zinc-300">{download.status}</span>
                        </div>
                        {activeDownload && (
                          <div
                            role="progressbar"
                            aria-label={`Downloading ${download.name}`}
                            aria-valuemin={0}
                            aria-valuemax={download.totalBytes ?? undefined}
                            aria-valuenow={percent === null ? undefined : download.bytesReceived}
                            className="mt-2 h-1.5 overflow-hidden rounded bg-zinc-800"
                          >
                            <div
                              className={`h-full bg-emerald-500 ${percent === null ? 'w-1/3 animate-pulse' : ''}`}
                              style={percent === null ? undefined : { width: `${percent}%` }}
                            />
                          </div>
                        )}
                        <p role={download.status === 'failed' ? 'alert' : 'status'} className="mt-1 text-xs text-zinc-400">
                          {download.totalBytes
                            ? `${formatBytes(download.bytesReceived)} / ${formatBytes(download.totalBytes)} · `
                            : download.bytesReceived > 0 ? `${formatBytes(download.bytesReceived)} · ` : ''}
                          {download.message}
                        </p>
                        {activeDownload && download.status !== 'canceling' && (
                          <Button size="sm" variant="destructive" className="mt-2" onClick={() => {
                            void tauriCurseForge.cancelDownload(download.id).then((accepted) => {
                              if (!accepted) pushToast('This download is no longer active.', 'info');
                            }).catch((error: unknown) => pushToast(errorText(error, 'Could not cancel the download.'), 'err'));
                          }}>Cancel download</Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-zinc-500">Downloads are staged under app data. They are not written into an existing server.</p>
                <Button disabled={curseforgeLoading} onClick={() => { void continueToCurseforgeZipSelection(); }}>
                  {curseforgeLoading ? 'Scanning ZIPs…' : 'Next — Choose a downloaded ZIP →'}
                </Button>
              </div>
            </Card>
          )}
          </>
        ) : (
        <div className="mc-create-type-grid grid gap-3">
          {(
            [
              { k: 'vanilla', t: 'Vanilla', d: 'Official server, 2-click setup. Pick MC version → name/RAM/port/EULA → done.', e: '🧱' },
              { k: 'curseforge', t: 'CurseForge Modpack', d: 'Browse local mock entries; live access is currently unavailable.', e: '🔥' },
              { k: 'modrinth', t: 'Modrinth Modpack', d: 'Browse Modrinth packs. Open API, default source.', e: '💠' },
            ] as { k: Kind; t: string; d: string; e: string }[]
          ).map((c) => (
            <button key={c.k} onClick={() => { clearPipelineReview(); setKind(c.k); setStep(c.k === 'vanilla' ? 3 : 2); }}
              className={`mc-edition ${kind === c.k ? 'mc-edition-active' : ''}`}>
              {c.k === 'vanilla' && <span className="mc-splash">NEW!</span>}
              <div className="text-3xl">{c.e}</div>
              <div className="mc-pixel mt-2 text-[10px]">{c.t}</div>
              <div className="mc-edition-sub mt-1 text-xs">{c.d}</div>
            </button>
          ))}
        </div>
        )
      )}

      {step === 2 && (
        hasBackend() ? kind === 'curseforge' ? (
          <div className="space-y-3">
            <Card>
              <CardTitle>Choose a downloaded SERVER ZIP</CardTitle>
              <p className="text-xs text-zinc-400">
                The list contains completed ZIPs in app-managed CurseForge staging. Browse copies an external ZIP here without changing the original file.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={curseforgeLoading || curseforgeInspecting} onClick={() => { void refreshCurseforgeZips(); }}>
                  {curseforgeLoading ? 'Refreshing…' : 'Refresh'}
                </Button>
                <Button size="sm" variant="secondary" disabled={curseforgeLoading || curseforgeInspecting} onClick={() => {
                  if (isDesktop()) void browseCurseforgeZip();
                  else curseforgeZipInputRef.current?.click();
                }}>
                  Browse for ZIP
                </Button>
              </div>
              {curseforgeError && <p role="alert" className="mt-2 text-xs text-red-300">{curseforgeError}</p>}
            </Card>
            {curseforgeZips.length > 0 ? (
              <fieldset className="space-y-2">
                <legend className="sr-only">Available CurseForge ZIP files</legend>
                {curseforgeZips.map((file) => (
                  <label key={file.name} className={`flex cursor-pointer items-start gap-3 rounded border p-3 ${curseforgeSelectedName === file.name ? 'border-emerald-700 bg-emerald-950/20' : 'border-zinc-800 bg-zinc-950'}`}>
                    <input
                      type="radio"
                      name="curseforge-zip"
                      value={file.name}
                      checked={curseforgeSelectedName === file.name}
                      disabled={curseforgeLoading || curseforgeInspecting}
                      onChange={() => selectCurseforgeZip(file.name)}
                      className="mt-1"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block break-all text-sm font-medium">{file.name}</span>
                      <span className="block text-xs text-zinc-500">
                        {formatBytes(file.size)} · {file.modifiedAt === null ? 'Modified time unavailable' : new Date(file.modifiedAt * 1000).toLocaleString()}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : (
              <p role="status" className="text-sm text-zinc-500">
                {curseforgeLoading ? 'Scanning staged ZIPs…' : 'No completed ZIPs found. Open CurseForge or use Browse for ZIP.'}
              </p>
            )}
            {curseforgeSelectedName && (
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle>Inspect selected archive</CardTitle>
                    <p className="break-all text-xs text-zinc-400">{curseforgeSelectedName}</p>
                  </div>
                  <Button size="sm" disabled={curseforgeInspecting} onClick={() => { void inspectCurseforgeZip(); }}>
                    {curseforgeInspecting ? 'Inspecting…' : 'Inspect ZIP'}
                  </Button>
                </div>
                {selectedCurseforgeInspection && (
                  <div className="mt-3 rounded border border-zinc-800 bg-zinc-950 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={selectedCurseforgeInspection.classification === 'supportedServerPack' ? 'green' : selectedCurseforgeInspection.classification === 'clientExport' ? 'amber' : 'red'}>
                        {selectedCurseforgeInspection.classification === 'supportedServerPack'
                          ? 'Supported server pack'
                          : selectedCurseforgeInspection.classification === 'clientExport'
                            ? 'Client modpack export'
                            : 'Invalid or unsupported archive'}
                      </Badge>
                      {selectedCurseforgeInspection.minecraftVersion && <span className="text-xs text-zinc-300">Minecraft {selectedCurseforgeInspection.minecraftVersion}</span>}
                      {selectedCurseforgeInspection.loader && <span className="text-xs text-zinc-300">{selectedCurseforgeInspection.loader} {selectedCurseforgeInspection.loaderVersion}</span>}
                    </div>
                    <p role="status" className="mt-2 text-sm text-zinc-300">{selectedCurseforgeInspection.reason}</p>
                    {selectedCurseforgeInspection.classification === 'supportedServerPack' && (
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs text-zinc-500">This ZIP is preserved after installation unless automatic deletion is enabled in Settings.</p>
                        <Button onClick={() => {
                          if (curseforgeInspection?.name === curseforgeSelectedName
                            && curseforgeInspection.classification === 'supportedServerPack') setStep(3);
                        }}>Continue to Configure →</Button>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            )}
            <Button variant="ghost" onClick={() => setStep(1)}>← Back</Button>
          </div>
        ) : kind === 'modrinth' ? (
          <div className="space-y-3">
            <Card>
              <div className="flex flex-wrap gap-2">
                <input aria-label="Search Modrinth modpacks" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Modrinth modpacks…" className={`${inputCls} max-w-xs`} />
                <Badge tone="green">Modrinth</Badge>
                <select aria-label="Filter Modrinth modpacks by Minecraft version" value={mc} onChange={(e) => setMc(e.target.value)} className={`${inputCls} w-auto`}>
                  <option value="Any">Any game version</option>
                  {Array.from(new Set([
                    ...vanillaVersions.map((version) => version.id),
                    ...modrinthPacks.flatMap((result) => result.gameVersions),
                    ...(mc === 'Any' ? [] : [mc]),
                  ])).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((version) => (
                    <option key={version} value={version}>{version}</option>
                  ))}
                </select>
                <select aria-label="Filter Modrinth modpacks by loader" value={loader} onChange={(e) => setLoader(e.target.value)} className={`${inputCls} w-auto`}>
                  <option value="Any">Any loader</option>
                  {Array.from(new Set([
                    'fabric', 'forge', 'neoforge', 'quilt', 'vanilla', 'paper',
                    ...modrinthPacks.flatMap((result) => result.loaders),
                    ...(loader === 'Any' ? [] : [loader]),
                  ])).sort().map((value) => (
                    <option key={value} value={value}>{value.charAt(0).toUpperCase() + value.slice(1)}</option>
                  ))}
                </select>
                <select aria-label="Sort Modrinth modpacks" value={sort} onChange={(e) => setSort(e.target.value as 'popular' | 'name')} className={`${inputCls} w-auto`}>
                  <option value="popular">Sort: Most downloads</option>
                  <option value="name">Sort: Name A-Z</option>
                </select>
              </div>
              <p className="mt-2 text-xs text-zinc-500">
                {modrinthTotalHits} Modrinth modpack(s) · Popularity uses Modrinth download ordering.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" disabled={installing} onClick={() => {
                  if (isDesktop()) void pickLocalMrpack();
                  else localMrpackInputRef.current?.click();
                }}>
                  {localMrpack ? 'Choose another local .mrpack' : 'Import local .mrpack'}
                </Button>
                {localMrpack && (
                  <span role="status" className="break-all text-xs text-zinc-400">
                    Selected local pack: {localMrpack.fileName}
                  </span>
                )}
              </div>
            </Card>
            {modrinthLoading && <p role="status" className="text-sm text-zinc-400">Loading Modrinth modpacks…</p>}
            {modrinthError && (
              <div role="alert" className="flex flex-wrap items-center gap-2 rounded border border-red-900 bg-red-950/40 p-3 text-sm text-red-200">
                <span>Modrinth catalog error: {modrinthError}</span>
                <Button size="sm" variant="secondary" onClick={() => {
                  if (modrinthPacks.length > 0) void loadMoreModrinth();
                  else setModrinthRetry((retry) => retry + 1);
                }}>Retry</Button>
              </div>
            )}
            <div className="mc-create-pack-grid grid gap-3">
              {displayedModrinthPacks.map((result) => (
                <Card key={result.id}>
                  <div className="flex gap-3">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded bg-zinc-900 text-2xl">
                      {result.iconUrl
                        ? <img src={result.iconUrl} alt="" className="h-full w-full object-cover" />
                        : '💠'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-semibold">{result.name}</span>
                        <Badge tone="green">MR</Badge>
                      </div>
                      <div className="text-xs text-zinc-500">
                        by {result.author} · {fmtDl(result.downloads)} downloads · MC {result.gameVersions.join(', ') || '—'} · {result.loaders.join(', ') || 'loader unspecified'}
                      </div>
                      <p className="mt-1 text-xs text-zinc-400">{result.summary}</p>
                      <div className="mt-2"><Button size="sm" onClick={() => pickModrinthPack(result)}>Select →</Button></div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
            {!modrinthLoading && !modrinthError && modrinthPacks.length === 0 && (
              <p className="text-sm text-zinc-500">No Modrinth modpacks match these filters.</p>
            )}
            {modrinthOffset < modrinthTotalHits && (
              <Button variant="secondary" disabled={modrinthLoading || modrinthLoadingMore} onClick={() => { void loadMoreModrinth(); }}>
                {modrinthLoadingMore ? 'Loading more…' : 'Load more'}
              </Button>
            )}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setStep(1)}>← Back</Button>
            </div>
          </div>
        ) : null : (
          <div className="space-y-3">
            <Card>
              <div className="flex flex-wrap gap-2">
                <input aria-label="Search modpacks" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search modpacks…" className={`${inputCls} max-w-xs`} />
                <div className="flex gap-1">
                  {(['all', 'curseforge', 'modrinth'] as const).map((s) => (
                    <button key={s} onClick={() => setSourceTab(s)} className={`rounded px-2 py-1 text-xs ${sourceTab === s ? 'bg-emerald-700 text-white' : 'bg-zinc-800 text-zinc-300'}`}>{s}</button>
                  ))}
                </div>
                <select aria-label="Filter modpacks by Minecraft version" value={mc} onChange={(e) => setMc(e.target.value)} className={`${inputCls} w-auto`}>
                  <option>Any</option>{MC_VERSIONS.map((v) => <option key={v}>{v}</option>)}
                </select>
                <select aria-label="Filter modpacks by loader" value={loader} onChange={(e) => setLoader(e.target.value)} className={`${inputCls} w-auto`}>
                  {LOADERS.map((v) => <option key={v}>{v}</option>)}
                </select>
                <select aria-label="Sort modpacks" value={sort} onChange={(e) => setSort(e.target.value as 'popular' | 'name')} className={`${inputCls} w-auto`}>
                  <option value="popular">Sort: Popular</option>
                  <option value="name">Sort: Name A-Z</option>
                </select>
              </div>
              <p className="mt-2 text-xs text-zinc-500">{results.length} pack(s) · Modrinth is the default open source catalog.</p>
            </Card>
            <div className="mc-create-pack-grid grid gap-3">
              {results.map((m) => (
                <Card key={m.id}>
                  <div className="flex gap-3">
                    <div className="text-3xl">{m.icon}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-semibold">{m.name}</span>
                        <Badge tone={m.source === 'modrinth' ? 'green' : 'amber'}>{m.source === 'modrinth' ? 'MR' : 'CF'}</Badge>
                      </div>
                      <div className="text-xs text-zinc-500">by {m.author} · {fmtDl(m.downloads)} downloads · MC {m.mcVersions.join(', ')}</div>
                      <p className="mt-1 text-xs text-zinc-400">{m.summary}</p>
                      <div className="mt-2"><Button size="sm" onClick={() => pickPack(m)}>Select →</Button></div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
            {results.length === 0 && <p className="text-sm text-zinc-500">No packs match these filters.</p>}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setStep(1)}>← Back</Button>
            </div>
          </div>
        )
      )}

      {step === 3 && (
        <Card>
          {hasBackend() && kind === 'curseforge' && selectedCurseforgeInspection
            ? <CardTitle>Configure — {selectedCurseforgeInspection.name}</CardTitle>
            : hasBackend() && kind === 'modrinth'
              ? <CardTitle>Configure — {selectedModrinthPack?.name ?? 'Modrinth modpack'}</CardTitle>
              : hasBackend()
                ? <CardTitle>Configure — {selectedLoaderChoice?.loader === serverLoader ? selectedLoaderChoice.label : serverLoader}</CardTitle>
                : <CardTitle>Configure {kind === 'vanilla' ? '— Vanilla (2-click)' : `— ${pack?.name ?? 'modpack'}`}</CardTitle>}
          {hasBackend() && kind === 'curseforge' && selectedCurseforgeInspection?.classification === 'supportedServerPack' && (
            <div className="mb-3 rounded border border-zinc-800 bg-zinc-950 p-3">
              <p className="text-sm font-medium">Detected server pack</p>
              <p className="mt-1 text-xs text-zinc-300">
                Minecraft {selectedCurseforgeInspection.minecraftVersion} · {selectedCurseforgeInspection.loader} {selectedCurseforgeInspection.loaderVersion}
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                A new server folder will be created. The importer will not run scripts from the archive.
              </p>
            </div>
          )}
          {hasBackend() && kind === 'modrinth' && selectedModrinthPack && (
            <div className="mb-3 rounded border border-zinc-800 bg-zinc-950 p-3">
              <div className="flex flex-wrap items-center gap-2">
                {selectedModrinthPack.iconUrl
                  ? <img src={selectedModrinthPack.iconUrl} alt="" className="h-8 w-8 rounded object-cover" />
                  : <span className="text-xl">💠</span>}
                <strong className="text-sm">{selectedModrinthPack.name}</strong>
                {modrinthVersions.length > 0 && (
                  <select
                    aria-label={`Select ${selectedModrinthPack.name} version`}
                    value={selectedModrinthVersionId}
                    onChange={(e) => setSelectedModrinthVersionId(e.target.value)}
                    className={`${inputCls} w-auto`}
                    disabled={modrinthVersionsLoading}
                  >
                    {modrinthVersions.map((version) => (
                      <option key={version.id} value={version.id}>
                        {version.name} · {version.versionNumber} · MC {version.gameVersions.join(', ')} · {version.loaders.join(', ')}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {modrinthVersionsLoading && <p role="status" className="mt-2 text-xs text-zinc-400">Loading exact Modrinth versions…</p>}
              {modrinthVersionsError && (
                <p role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-red-300">
                  <span>Modrinth version error: {modrinthVersionsError}</span>
                  <Button size="sm" variant="secondary" onClick={() => setModrinthVersionsRetry((retry) => retry + 1)}>Retry</Button>
                </p>
              )}
              {!modrinthVersionsLoading && !modrinthVersionsError && modrinthVersions.length === 0 && (
                <p role="status" className="mt-2 text-xs text-zinc-400">No Modrinth versions match the selected game version and loader filters.</p>
              )}
              {selectedModrinthVersion && (
                <>
                  <p className="mt-1 text-xs text-zinc-500">
                    Exact version ID: {selectedModrinthVersion.id} · MC {selectedModrinthVersion.gameVersions.join(', ')} · {selectedModrinthVersion.loaders.join(', ')}
                  </p>
                  <p className="mt-1 text-xs text-zinc-300">
                    Server target: Minecraft {modrinthInstallMc || 'choose a supported game version'} · {modrinthInstallLoader ? MODRINTH_LOADER_NAMES[modrinthInstallLoader] : 'choose a supported loader'}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-400">
                    Changelog ({selectedModrinthVersion.versionNumber}): {selectedModrinthVersion.changelog || 'No changelog provided.'}
                  </p>
                  {selectedModrinthVersion.files[0] && (
                    <p className="mt-1 text-xs text-zinc-500">Primary file: {selectedModrinthVersion.files.find((file) => file.primary)?.filename ?? selectedModrinthVersion.files[0].filename}</p>
                  )}
                </>
              )}
              <button className="mt-1 text-xs text-emerald-400 underline" onClick={() => {
                setSelectedModrinthPack(null);
                setModrinthVersions([]);
                setSelectedModrinthVersionId('');
                setModrinthVersionsError('');
                setStep(2);
              }}>Change pack</button>
            </div>
          )}
          {pack && (
            <div className="mb-3 rounded border border-zinc-800 bg-zinc-950 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xl">{pack.icon}</span>
                <strong className="text-sm">{pack.name}</strong>
                <select value={packVer} onChange={(e) => setPackVer(Number(e.target.value))} className={`${inputCls} w-auto`}>
                  {pack.packVersions.map((v, i) => <option key={v.v} value={i}>{v.v} · MC {v.mc} · {v.loader}</option>)}
                </select>
              </div>
              <p className="mt-1 text-xs text-zinc-500">Changelog ({pack.packVersions[packVer].v}): {pack.packVersions[packVer].changelog}</p>
              <p className="mt-1 text-xs text-zinc-500">MC + loader resolved read-only: {pack.packVersions[packVer].mc} / {pack.packVersions[packVer].loader}</p>
              <button className="mt-1 text-xs text-emerald-400 underline" onClick={() => setStep(2)}>Change pack</button>
            </div>
          )}
          {hasBackend() && (kind === 'modrinth' || kind === 'curseforge')
            && pipelinePreviewMatchesSource && pipelinePreview && (
              <section
                aria-labelledby="pipeline-review-heading"
                aria-live="polite"
                className="mb-3 space-y-3 rounded border border-emerald-900 bg-emerald-950/20 p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h4 id="pipeline-review-heading" className="text-sm font-semibold text-emerald-200">Review server files</h4>
                    <p className="mt-1 break-all text-xs text-zinc-300">{pipelinePreview.sourceName}</p>
                  </div>
                  <Badge tone="green">Minecraft {pipelinePreview.plan.loader.minecraftVersion} · {pipelinePreview.plan.loader.kind}</Badge>
                </div>
                <p role="status" className="text-xs text-zinc-300">
                  {pipelinePreview.plan.fileDecisions.filter((decision) => decision.action === 'include').length} files included · {skippedPipelineFiles.length} skipped · {reviewChoices.length} choices to review.
                </p>
                {pipelinePreview.plan.loader.kind === 'quilt' && (
                  <p role="alert" className="rounded border border-amber-900 bg-amber-950/30 p-2 text-xs text-amber-100">
                    Quilt server installation is not available yet. This pack can be reviewed, but it cannot be installed.
                  </p>
                )}
                {pipelinePreview.warnings.length > 0 && (
                  <div className="rounded border border-amber-900 bg-amber-950/30 p-2">
                    <p className="text-xs font-medium text-amber-200">Pack warnings</p>
                    <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-amber-100">
                      {pipelinePreview.warnings.slice(0, 20).map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}
                    </ul>
                    {pipelinePreview.warnings.length > 20 && (
                      <p className="mt-1 text-xs text-amber-300">Showing 20 of {pipelinePreview.warnings.length} warnings.</p>
                    )}
                  </div>
                )}
                {reviewChoices.length > 0 ? (
                  <fieldset className="space-y-2">
                    <legend className="text-xs font-medium text-zinc-200">Optional files and conflicting server flags</legend>
                    {visibleReviewChoices.map((decision, index) => {
                      const selectedChoice = pipelineFileChoices[decision.path];
                      const isConflict = decision.action === 'awaitingUserChoice';
                      const controlName = `pipeline-choice-${pipelinePreview.previewId}-${pipelineChoicePage}-${index}`;
                      return (
                        <div key={decision.path} className="rounded border border-zinc-800 bg-zinc-950 p-2">
                          <p className="break-all text-xs font-medium text-zinc-200">{decision.path}</p>
                          <p className="mt-0.5 text-xs text-zinc-500">
                            {isConflict ? 'The pack has conflicting client/server declarations. Choose the server action.' : 'Optional server file · included by default.'}
                          </p>
                          {isConflict ? (
                            <fieldset className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                              <legend className="sr-only">Choose whether to include {decision.path}</legend>
                              {(['include', 'exclude'] as const).map((choice) => (
                                <label key={choice} className="flex cursor-pointer items-center gap-2 text-xs text-zinc-200">
                                  <input
                                    type="radio"
                                    name={controlName}
                                    value={choice}
                                    checked={selectedChoice === choice}
                                    onChange={() => setPipelineFileChoices((previous) => ({ ...previous, [decision.path]: choice }))}
                                    className="h-3.5 w-3.5"
                                  />
                                  {choice === 'include' ? 'Include on server' : 'Exclude from server'}
                                </label>
                              ))}
                            </fieldset>
                          ) : (
                            <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-zinc-200">
                              <input
                                type="checkbox"
                                checked={selectedChoice !== 'exclude'}
                                onChange={(event) => setPipelineFileChoices((previous) => ({
                                  ...previous,
                                  [decision.path]: event.target.checked ? 'include' : 'exclude',
                                }))}
                                className="h-3.5 w-3.5"
                              />
                              Include this optional file on the server
                            </label>
                          )}
                        </div>
                      );
                    })}
                    {pipelineChoicePageCount > 1 && (
                      <nav aria-label="Optional and conflict file choice pages" className="flex flex-wrap items-center justify-between gap-2">
                        <p role="status" className="text-xs text-zinc-400">
                          Choices {pipelineChoicePage * MAX_REPORT_DETAIL_ROWS + 1}–{Math.min((pipelineChoicePage + 1) * MAX_REPORT_DETAIL_ROWS, reviewChoices.length)} of {reviewChoices.length}
                        </p>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={pipelineChoicePage === 0}
                            onClick={() => setPipelineChoicePage((page) => Math.max(0, page - 1))}
                          >Previous</Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={pipelineChoicePage + 1 >= pipelineChoicePageCount}
                            onClick={() => setPipelineChoicePage((page) => Math.min(pipelineChoicePageCount - 1, page + 1))}
                          >Next</Button>
                        </div>
                      </nav>
                    )}
                  </fieldset>
                ) : (
                  <p role="status" className="text-xs text-zinc-400">No optional or conflicting file choices are required.</p>
                )}
                {skippedPipelineFiles.length > 0 && (
                  <details className="rounded border border-zinc-800 bg-zinc-950 p-2">
                    <summary className="cursor-pointer text-xs font-medium text-zinc-300">
                      Skipped files ({skippedPipelineFiles.length})
                    </summary>
                    <ul className="mt-2 max-h-36 space-y-1 overflow-y-auto text-xs text-zinc-400">
                      {skippedPipelineFiles.slice(0, MAX_REPORT_DETAIL_ROWS).map((decision) => (
                        <li key={decision.path} className="break-all">
                          {decision.path} <span className="text-zinc-600">· {decision.reason === 'serverUnsupported' ? 'unsupported on servers' : decision.reason}</span>
                        </li>
                      ))}
                    </ul>
                    {skippedPipelineFiles.length > MAX_REPORT_DETAIL_ROWS && (
                      <p className="mt-1 text-xs text-zinc-500">Showing the first {MAX_REPORT_DETAIL_ROWS} skipped paths.</p>
                    )}
                  </details>
                )}
              </section>
            )}
          <div className="mc-create-form-grid grid gap-3">
            <Field label="Server name (unique)">
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
            </Field>
            {hasBackend() && kind === 'curseforge' && selectedCurseforgeInspection?.classification === 'supportedServerPack' && (
              <Field label="Imported Minecraft version and loader">
                <input
                  readOnly
                  value={`Minecraft ${selectedCurseforgeInspection.minecraftVersion} · ${selectedCurseforgeInspection.loader} ${selectedCurseforgeInspection.loaderVersion}`}
                  className={`${inputCls} opacity-80`}
                />
              </Field>
            )}
            {hasBackend() && kind === 'modrinth' && selectedModrinthVersion && (
              <>
                <Field
                  label="Minecraft game version"
                  hint={`Choose a release declared by exact pack version ${selectedModrinthVersion.versionNumber}.`}
                >
                  <select
                    aria-label="Modrinth pack Minecraft game version"
                    value={modrinthInstallMc}
                    onChange={(e) => setModrinthInstallMc(e.target.value)}
                    className={inputCls}
                    disabled={versionsLoading || vanillaVersions.length === 0}
                  >
                    <option value="" disabled>Choose a supported game version</option>
                    {selectedModrinthVersion.gameVersions.map((version) => {
                      const supported = vanillaVersions.some((candidate) => candidate.id === version && candidate.versionType === 'release');
                      return (
                        <option key={version} value={version} disabled={!supported}>
                          {version}{supported ? '' : ' — unsupported by the server installer'}
                        </option>
                      );
                    })}
                  </select>
                  {versionsLoading && <p role="status" className="mt-1 text-xs text-zinc-500">Checking supported Minecraft releases…</p>}
                  {!versionsLoading && vanillaVersions.length === 0 && (
                    <p role="alert" className="mt-1 text-xs text-red-300">
                      {versionsError || 'Minecraft release metadata is unavailable; this pack cannot be installed right now.'}
                    </p>
                  )}
                  {!versionsLoading && vanillaVersions.length > 0 && modrinthSupportedGameVersions.length === 0 && (
                    <p role="status" className="mt-1 text-xs text-amber-300">
                      This exact Modrinth version has no Minecraft release supported by the server installer.
                    </p>
                  )}
                </Field>
                <Field
                  label="Dedicated server loader"
                  hint="Only Vanilla, Fabric, Forge, and NeoForge can be installed for a new Modrinth server."
                >
                  <select
                    aria-label="Modrinth pack dedicated server loader"
                    value={modrinthInstallLoader}
                    onChange={(e) => {
                      const option = modrinthLoaderOptionList.find((candidate) => candidate.id === e.target.value);
                      if (option?.loader) setModrinthInstallLoader(option.loader);
                    }}
                    className={inputCls}
                    disabled={modrinthBuildLoading || modrinthLoaderOptionList.length === 0}
                  >
                    <option value="" disabled>Choose a supported server loader</option>
                    {modrinthLoaderOptionList.map((option) => {
                      const installerLoader = option.loader
                        ? MODRINTH_INSTALLER_LOADER_NAMES[option.loader]
                        : null;
                      const providerBuildAvailable = installerLoader !== null
                        && modrinthBuildChoices.some((choice) => choice.loader === installerLoader);
                      const noProviderBuild = Boolean(
                        option.loader && modrinthBuildMc === modrinthInstallMc
                        && modrinthBuildVersionId === selectedModrinthVersionId
                        && !modrinthBuildLoading && !modrinthBuildError && !providerBuildAvailable,
                      );
                      const value = option.loader ?? `unsupported:${option.id}`;
                      return (
                        <option key={option.id} value={value} disabled={!option.loader || noProviderBuild}>
                          {option.label}{noProviderBuild ? ` — no verified server build for ${modrinthInstallMc}` : ''}
                        </option>
                      );
                    })}
                  </select>
                  {modrinthBuildLoading && <p role="status" className="mt-1 text-xs text-zinc-500">Verifying server loader builds for Minecraft {modrinthInstallMc}…</p>}
                  {modrinthBuildError && (
                    <p role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-xs text-red-300">
                      <span>Could not verify loader support: {modrinthBuildError}</span>
                      <Button size="sm" variant="secondary" onClick={() => setModrinthBuildRetry((retry) => retry + 1)}>Retry</Button>
                    </p>
                  )}
                  {modrinthBuildUnavailable && selectedModrinthLoaderOption && (
                    <p role="status" className="mt-1 text-xs text-amber-300">
                      {selectedModrinthLoaderOption.label} has no provider-verified server build for Minecraft {modrinthInstallMc}.
                    </p>
                  )}
                  {!modrinthBuildLoading && modrinthLoaderOptionList.length > 0
                    && modrinthLoaderOptionList.every((option) => option.loader === null) && (
                      <p role="status" className="mt-1 text-xs text-amber-300">
                        This exact version declares only unsupported loaders: {modrinthLoaderOptionList.map((option) => option.label).join(', ')}.
                      </p>
                    )}
                </Field>
              </>
            )}
            {kind === 'vanilla' && (
              <Field label="Minecraft version" hint={hasBackend() ? (showSnapshots ? 'Releases and snapshots. Snapshots install through the same verified Mojang artifact path.' : 'Releases by default. Enable snapshots to install pre-releases and weeklies.') : undefined}>
                {hasBackend() ? (
                  <>
                    <select
                      value={vanillaMc}
                      onChange={(e) => setVanillaMc(e.target.value)}
                      className={inputCls}
                      disabled={versionsLoading || configureVersions.length === 0}
                    >
                      {filteredConfigureVersions.map((version) => (
                        <option key={version.id} value={version.id}>
                          {version.id}{version.versionType !== 'release' ? ' — Snapshot' : ''}
                        </option>
                      ))}
                    </select>
                    <label className="mt-2 flex items-center gap-2 text-xs text-zinc-300">
                      <input
                        type="checkbox"
                        checked={showSnapshots}
                        onChange={(e) => setShowSnapshots(e.target.checked)}
                        className="h-3.5 w-3.5"
                      />
                      Show snapshots
                    </label>
                    {versionsLoading && <p className="mt-1 text-xs text-zinc-500">Loading provider-supported releases…</p>}
                    {versionsError && <p role="status" className="mt-1 text-xs text-amber-300">{versionsError}</p>}
                    {snapshotStale && selectedVersionDto && (
                      <p role="status" className="mt-1 text-xs text-amber-300">
                        {selectedVersionDto.id} is a snapshot and is hidden while snapshots are off. Enable snapshots or choose a release before installing.
                      </p>
                    )}
                  </>
                ) : (
                  <select value={vanillaMc} onChange={(e) => setVanillaMc(e.target.value)} className={inputCls}>
                    {MC_VERSIONS.map((v) => <option key={v}>{v}</option>)}
                  </select>
                )}
              </Field>
            )}
            {hasBackend() && kind === 'vanilla' && (
              <Field label="Server loader and version" hint="Stable builds first. Enable all builds to install provider-verified non-stable versions.">
                <select
                  value={selectedLoaderChoice?.loader === serverLoader ? String(displayedLoaderChoices.indexOf(selectedLoaderChoice)) : ''}
                  onChange={(e) => {
                    const choice = displayedLoaderChoices[Number(e.target.value)];
                    if (choice) {
                      setSelectedLoaderChoice(choice);
                      setServerLoader(choice.loader);
                      setLoaderError('');
                    }
                  }}
                  className={inputCls}
                  disabled={loaderLoading || displayedLoaderChoices.length === 0}
                >
                  {displayedLoaderChoices.map((choice, index) => (
                    <option key={choice.loader + ':' + (choice.version ?? '')} value={index}>{choice.label}</option>
                  ))}
                </select>
                <label className="mt-2 flex items-center gap-2 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={showAllBuilds}
                    onChange={(e) => setShowAllBuilds(e.target.checked)}
                    className="h-3.5 w-3.5"
                  />
                  Show all builds
                </label>
                {loaderLoading && <p className="mt-1 text-xs text-zinc-500">Resolving compatible loader versions…</p>}
                {loaderError && <p role="status" className="mt-1 text-xs text-amber-300">{loaderError}</p>}
                {loaderToggleStale && selectedLoaderChoice && (
                  <p role="status" className="mt-1 text-xs text-amber-300">
                    {selectedLoaderChoice.label} is hidden while all builds are off. Enable all builds or choose a stable version before installing.
                  </p>
                )}
              </Field>
            )}
            <Field label={`RAM: ${ram} MB (recommended ${recommended} MB)`} hint={freeWarn ? `Warning: exceeds free RAM estimate (${FREE_RAM_MB} MB).` : ramBelow ? 'Below recommended — large packs may crash.' : 'Looks good.'}>
              <input type="range" min={1024} max={16384} step={256} value={ram} onChange={(e) => setRam(Number(e.target.value))} className="ram-slider" />
              {ramBelow && <span className="mt-1 inline-block"><Badge tone="amber">below recommended</Badge></span>}
            </Field>
            <Field label="Port" hint={hasBackend()
              ? portConflict ? 'Another saved server uses this port.' : 'The backend checks the port again during publication.'
              : portConflict ? 'Conflict: another server already uses this port (mock check).' : 'Port looks free (mock check).'}>
              <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} className={inputCls} />
            </Field>
            <div className="space-y-2">
              <Field
                label={javaDetection ? `Java required: ${javaDetection.requiredMajor}` : 'Java runtime'}
                hint={hasBackend() ? 'Java is checked against Mojang version metadata. You can install Temurin or choose a JDK path.' : 'Detected automatically at launch (mock).'}
              >
                {!hasBackend() ? (
                  <input value="Auto — Temurin 17/21 (mock)" readOnly disabled className={`${inputCls} opacity-60`} />
                ) : (
                  <div className="space-y-2 rounded border border-zinc-800 bg-zinc-950 p-2.5">
                    <p className="text-sm text-zinc-200">
                      {javaLoading ? 'Checking installed Java…' : javaSelected
                        ? `Java ${javaSelected.major} · ${javaSelected.source}${javaOverride ? ' · override' : ' · auto'}`
                        : javaDetection ? `No Java ${javaDetection.installMajor} runtime found. Install the recommended runtime before starting this pack.` : 'Java requirement unavailable.'}
                    </p>
                    {javaSelected && <p className="break-all text-xs text-zinc-500">{javaSelected.path}</p>}
                    {javaOverride && (
                      <div className="space-y-2">
                        <input
                          value={javaPath}
                          onChange={(e) => { setJavaPath(e.target.value); setJavaError(''); }}
                          placeholder="JDK home folder or bin\\java.exe"
                          className={inputCls}
                        />
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="secondary" onClick={validateJavaOverride}>Validate path</Button>
                          <Button size="sm" variant="ghost" onClick={() => {
                            setJavaOverride(false);
                            const recommendedJava = javaDetection?.candidates.find(
                              (runtime) => runtime.major === javaDetection.installMajor,
                            ) ?? null;
                            setJavaPath(recommendedJava?.path ?? '');
                            setJavaSelected(recommendedJava);
                            setJavaError('');
                          }}>Use detected Java</Button>
                        </div>
                      </div>
                    )}
                    {javaError && <p role="alert" className="text-xs text-red-300">{javaError}</p>}
                    {javaInstalling && (
                      <div className="space-y-1">
                        <ProgressBar value={javaProgress} />
                        <p className="text-xs text-zinc-400">{javaProgress}% · {javaProgressLog}</p>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {!javaOverride && <Button size="sm" variant="secondary" disabled={!javaDetection || javaLoading || javaInstalling} onClick={() => {
                        setJavaOverride(true);
                        setJavaPath(javaSelected?.path ?? '');
                      }}>Change…</Button>}
                      <Button size="sm" disabled={!javaDetection || javaLoading || javaInstalling} onClick={installJava}>
                        Install Temurin Java {javaDetection?.installMajor ?? '…'}
                      </Button>
                    </div>
                  </div>
                )}
              </Field>
            </div>
          </div>
          <label className="mt-3 flex items-start gap-2 rounded border border-zinc-800 bg-zinc-950 p-3 text-sm">
            <input type="checkbox" checked={eula} onChange={(e) => setEula(e.target.checked)} className="mt-1" />
            <span>
              I accept the <a className="underline" href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">Minecraft EULA</a>.
              <span className="block text-xs text-zinc-500">Required. The app never accepts it for you, and Start stays blocked until checked.</span>
            </span>
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => setStep(kind === 'vanilla' ? 1 : 2)}>← Back</Button>
            <Button
              disabled={hasBackend() && (kind === 'curseforge'
                ? installing || !name.trim() || !curseforgeInspectionMatchesSelection || curseforgeInspection?.classification !== 'supportedServerPack' || javaLoading || javaInstalling || !javaSelected || (javaOverride && javaSelected.path !== javaPath.trim()) || (pipelinePreviewMatchesSource && unresolvedPipelineChoiceCount > 0)
                : kind === 'modrinth'
                  ? installing || !name.trim() || !modrinthInstallReady || (pipelinePreviewMatchesSource && unresolvedPipelineChoiceCount > 0)
                  : installing || !name.trim() || versionsLoading || loaderLoading || !selectedLoaderChoice || Boolean(loaderError) || Boolean(loaderToggleStale) || Boolean(snapshotStale) || selectedLoaderChoice?.loader !== serverLoader || javaLoading || javaInstalling || !javaSelected || (javaOverride && javaSelected.path !== javaPath.trim()))}
              onClick={() => { void beginInstall(); }}
            >{hasBackend() && (kind === 'modrinth' || kind === 'curseforge')
                ? pipelinePreviewMatchesSource ? 'Install reviewed pack →' : 'Review pack files →'
                : 'Install →'}</Button>
          </div>
        </Card>
      )}

      {step === 4 && hasBackend() && (
        <Card>
          <CardTitle>Install — {doneId ? 'done' : installing ? 'in progress' : 'needs attention'}</CardTitle>
          <ProgressBar value={progress} />
          <p className="mt-1 text-xs text-zinc-400">
            {progress}% · {installStage || 'Waiting to start'}
            {installBytes.total !== null && installBytes.downloaded !== null
              ? ' · ' + formatBytes(installBytes.downloaded) + ' / ' + formatBytes(installBytes.total)
              : ''}
          </p>
          {installError && <p role="alert" className="mt-2 text-sm text-red-300">{installError}</p>}
          <pre className="mc-console log-scroll mt-2 max-h-48 overflow-y-auto p-2">
            {installLogs.length ? installLogs.join('\n') : 'Waiting for installer output…'}
          </pre>
          {pipelineReport && (
            <section
              aria-labelledby="pipeline-install-report-heading"
              aria-live="polite"
              className="mt-3 space-y-2 rounded border border-zinc-700 bg-zinc-950 p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 id="pipeline-install-report-heading" className="text-sm font-semibold text-zinc-100">Installation report</h4>
                <Badge tone={pipelineReport.status === 'complete' ? 'green' : pipelineReport.status === 'cancelled' ? 'amber' : 'red'}>
                  {pipelineReport.status}
                </Badge>
              </div>
              <p className="text-xs text-zinc-400">
                Minecraft {pipelineReport.loader.minecraftVersion} · {pipelineReport.loader.kind}
                {pipelineReport.loader.loaderVersion ? ` ${pipelineReport.loader.loaderVersion}` : ''}
                {' '}· {pipelineReport.files.length} file result(s) · report {pipelineReport.planId}
              </p>
              {Object.keys(reportOutcomeCounts).length > 0 && (
                <ul aria-label="File result counts" className="flex flex-wrap gap-2 text-xs text-zinc-300">
                  {Object.entries(reportOutcomeCounts).map(([outcome, count]) => (
                    <li key={outcome} className="rounded border border-zinc-800 px-2 py-1">{outcome}: {count}</li>
                  ))}
                </ul>
              )}
              {pipelineReport.warnings.length > 0 && (
                <div role="status" className="rounded border border-amber-900 bg-amber-950/30 p-2 text-xs text-amber-100">
                  <p className="font-medium">Warnings</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    {pipelineReport.warnings.slice(0, 20).map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}
                  </ul>
                  {pipelineReport.warnings.length > 20 && <p className="mt-1 text-amber-300">Showing 20 of {pipelineReport.warnings.length} warnings.</p>}
                </div>
              )}
              {pipelineReport.errors.length > 0 && (
                <div role="alert" className="rounded border border-red-900 bg-red-950/30 p-2 text-xs text-red-200">
                  <p className="font-medium">Errors</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    {pipelineReport.errors.slice(0, 20).map((error, index) => <li key={`${index}:${error}`}>{error}</li>)}
                  </ul>
                  {pipelineReport.errors.length > 20 && <p className="mt-1 text-red-300">Showing 20 of {pipelineReport.errors.length} errors.</p>}
                </div>
              )}
              <details className="rounded border border-zinc-800 p-2">
                <summary className="cursor-pointer text-xs font-medium text-zinc-300">File outcomes ({pipelineReport.files.length})</summary>
                <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto text-xs text-zinc-400">
                  {pipelineReport.files.slice(0, MAX_REPORT_DETAIL_ROWS).map((file, index) => (
                    <li key={`${file.path}:${index}`} className="border-b border-zinc-900 pb-2">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <span className="min-w-0 flex-1 break-all text-zinc-200">{file.path}</span>
                        <Badge tone={file.outcome === 'installed' || file.outcome === 'verified' ? 'green' : file.outcome.toLowerCase().includes('failed') ? 'red' : 'zinc'}>{file.outcome}</Badge>
                      </div>
                      {file.detail && <p className="mt-1 break-words">{file.detail}</p>}
                      {file.sizeBytes !== null && file.sizeBytes !== undefined && <p className="mt-1">{formatBytes(file.sizeBytes)}</p>}
                    </li>
                  ))}
                </ul>
                {pipelineReport.files.length > MAX_REPORT_DETAIL_ROWS && (
                  <p className="mt-2 text-xs text-zinc-500">
                    Showing the first {MAX_REPORT_DETAIL_ROWS} entries. {pipelineReport.status === 'complete' ? 'The complete report is saved in install-report.json in the new server folder.' : 'All stage outcomes and errors are listed above.'}
                  </p>
                )}
              </details>
              {pipelineReport.stages.length > 0 && (
                <details className="rounded border border-zinc-800 p-2">
                  <summary className="cursor-pointer text-xs font-medium text-zinc-300">Stage outcomes ({pipelineReport.stages.length})</summary>
                  <ul className="mt-2 space-y-1 text-xs text-zinc-400">
                    {pipelineReport.stages.slice(0, 50).map((stage, index) => (
                      <li key={`${stage.stage}:${index}`}><span className="text-zinc-200">{stage.stage}</span> · {stage.outcome}{stage.detail ? ` · ${stage.detail}` : ''}</li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {doneId ? (
              <Button onClick={() => onExit('console')} pulse>Done — Go to Console</Button>
            ) : installing ? (
              <Button variant="destructive" disabled={cancelRequested} onClick={() => { void cancelInstall(); }}>
                {cancelRequested ? 'Canceling…' : 'Cancel'}
              </Button>
            ) : (
              <>
                <Button variant="secondary" onClick={() => setStep(3)}>← Back to Configure</Button>
                <Button onClick={() => { void beginInstall(); }}>Retry</Button>
              </>
            )}
          </div>
          {doneId && (
            <div className="mt-3 rounded border border-emerald-800 bg-emerald-950/40 p-3 text-sm">
              <p>
                ✅ {kind === 'curseforge'
                  ? 'CurseForge server pack installed and saved.'
                  : kind === 'modrinth' && selectedModrinthPack
                    ? `${selectedModrinthPack.name} installed and saved.`
                    : 'Server installed and saved'}
                {!eula ? ' Start stays blocked until you accept the EULA in Settings.' : ''}
              </p>
              {kind === 'curseforge' && selectedCurseforgeInspection?.classification === 'supportedServerPack' ? (
                <p className="mt-1 text-xs text-zinc-400">
                  Join with Minecraft {selectedCurseforgeInspection.minecraftVersion} and {selectedCurseforgeInspection.loader} {selectedCurseforgeInspection.loaderVersion}.
                  {' '}{autoDeleteCurseForgeZip ? 'The staged ZIP copy was set to delete after successful installation.' : 'The staged ZIP was retained.'}
                  {' '}LAN hint: share 127.0.0.1:{port} on your network.
                </p>
              ) : kind === 'modrinth' && selectedModrinthPack && selectedModrinthVersion ? (
                <p className="mt-1 text-xs text-zinc-400">
                  Client parity notice: players should use Modrinth pack version {selectedModrinthVersion.versionNumber} ({selectedModrinthVersion.id}) for Minecraft {modrinthInstallMc} with {modrinthInstallLoader ? MODRINTH_LOADER_NAMES[modrinthInstallLoader] : 'the selected loader'}. The server install includes every file listed in the selected pack.
                  {' '}LAN hint: share 127.0.0.1:{port} on your network.
                </p>
              ) : (
                <p className="mt-1 text-xs text-zinc-400">
                  Client parity notice: players must join with Minecraft {vanillaMc} and loader {selectedLoaderChoice?.loader ?? serverLoader}.
                  {' '}LAN hint: share 127.0.0.1:{port} on your network.
                </p>
              )}
              <div className="mt-2">
                <Button size="sm" pulse onClick={() => onExit('console')}>Go to Console — Start is pulsing</Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {step === 4 && !hasBackend() && (
        <Card>
          <CardTitle>Install {progress >= 100 ? '— done' : '— in progress (mock)'}</CardTitle>
          <ProgressBar value={progress} />
          <p className="mt-1 text-xs text-zinc-500">{Math.min(100, progress)}% · downloading server jar + mods…</p>
          <pre className="mc-console log-scroll mt-2 max-h-40 overflow-y-auto p-2">
            {`[install] resolving ${pack?.name ?? 'vanilla ' + vanillaMc}\n[install] downloading… ${Math.min(100, progress)}%\n[install] auto pre-first-run backup armed`}
          </pre>
          <div className="mt-3 flex flex-wrap gap-2">
            {progress < 100 ? (
              <>
                <Button variant="secondary" onClick={() => setStep(3)}>← Back</Button>
                {installing ? <Button variant="destructive" onClick={cancelInstall}>Cancel</Button>
                  : <Button variant="secondary" onClick={beginInstall}>Retry</Button>}
                <Button disabled={progress < 100} onClick={finishInstall}>Simulate finish (mock)</Button>
              </>
            ) : (
              <>
                <Button variant="secondary" onClick={beginInstall}>Retry</Button>
                <Button onClick={finishInstall}>Done — create server</Button>
              </>
            )}
          </div>
          {doneId && (
            <div className="mt-3 rounded border border-emerald-800 bg-emerald-950/40 p-3 text-sm">
              <p>✅ {hasBackend() ? 'Server record created' : 'Server created'}{!eula ? ' — note: EULA not accepted, Start is blocked until you accept it in Settings' : ''}.</p>
              <p className="mt-1 text-xs text-zinc-400">Client parity notice: players must join with the same MC version{pack ? ` and modpack version (${pack.packVersions[packVer].v})` : ''}. LAN hint: share {`127.0.0.1:${port}`} on your network.</p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" pulse onClick={() => onExit('console')}>Go to Console — Start is pulsing</Button>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
