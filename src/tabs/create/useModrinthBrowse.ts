// Modrinth browse/search/version/build state for the Create wizard (extracted from Create.tsx, WP-6.5).
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  LoaderChoiceDto,
  MinecraftVersionDto,
  ModrinthInstallLoader,
  ModrinthModpackDto,
  ModrinthProjectVersionDto,
  ModrinthSearchIndex,
} from '../../tauri';
import { hasBackend, tauriModrinth, tauriVersions } from '../../tauri';
import { MODRINTH_INSTALLER_LOADER_NAMES, MODRINTH_PAGE_SIZE, errorText, modrinthLoaderOptions, type ModrinthLoaderOption } from './helpers';

interface Options {
  step: number;
  kind: 'vanilla' | 'curseforge' | 'modrinth';
  vanillaVersions: MinecraftVersionDto[];
  catalogueVersionsLoading: boolean;
}

export function useModrinthBrowse({ step, kind, vanillaVersions, catalogueVersionsLoading }: Options) {
  const [q, setQ] = useState('');
  const [appliedModrinthQuery, setAppliedModrinthQuery] = useState('');
  const [sourceTab, setSourceTab] = useState<'all' | 'curseforge' | 'modrinth'>('all');
  const [mc, setMc] = useState('Any');
  const [loader, setLoader] = useState('Any');
  const [sort, setSort] = useState<'popular' | 'name'>('popular');
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

  const selectedModrinthVersion = modrinthVersions.find((version) => version.id === selectedModrinthVersionId) ?? null;
  const modrinthLoaderOptionList = useMemo(() => modrinthLoaderOptions(selectedModrinthVersion), [selectedModrinthVersion]);
  const modrinthSupportedGameVersions = useMemo(
    () => selectedModrinthVersion?.gameVersions.filter((version) =>
      vanillaVersions.some((candidate) => candidate.id === version && candidate.versionType === 'release'),
    ) ?? [],
    [selectedModrinthVersion, vanillaVersions],
  );

  useEffect(() => {
    if (!selectedModrinthVersion) {
      setModrinthInstallMc('');
      setModrinthInstallLoader('');
      return;
    }
    if (!modrinthSupportedGameVersions.includes(modrinthInstallMc) && !catalogueVersionsLoading) {
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
    catalogueVersionsLoading,
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
    const subscribeToBuildRequest = (request: Promise<LoaderChoiceDto[]>): void => {
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

  const loadMoreModrinth = async (): Promise<void> => {
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

  const selectedModrinthLoaderOption = modrinthLoaderOptionList.find((option) => option.loader === modrinthInstallLoader) ?? null;
  const selectedModrinthLoaderChoice = modrinthInstallLoader
    ? modrinthBuildChoices.find((choice) => choice.loader === MODRINTH_INSTALLER_LOADER_NAMES[modrinthInstallLoader]) ?? null
    : null;
  const modrinthBuildUnavailable = Boolean(
    modrinthInstallLoader && !modrinthBuildLoading && !modrinthBuildError
    && modrinthBuildMc === modrinthInstallMc && modrinthBuildVersionId === selectedModrinthVersionId
    && !selectedModrinthLoaderChoice,
  );

  return {
    q,
    setQ,
    appliedModrinthQuery,
    sourceTab,
    setSourceTab,
    mc,
    setMc,
    loader,
    setLoader,
    sort,
    setSort,
    modrinthPacks,
    modrinthTotalHits,
    modrinthOffset,
    modrinthLoading,
    modrinthLoadingMore,
    modrinthError,
    modrinthRetry: () => setModrinthRetry((retry) => retry + 1),
    selectedModrinthPack,
    setSelectedModrinthPack,
    modrinthVersions,
    setModrinthVersions,
    selectedModrinthVersionId,
    setSelectedModrinthVersionId,
    modrinthVersionsLoading,
    modrinthVersionsError,
    setModrinthVersionsError,
    retryModrinthVersions: () => setModrinthVersionsRetry((retry) => retry + 1),
    modrinthInstallMc,
    setModrinthInstallMc,
    modrinthInstallLoader,
    setModrinthInstallLoader,
    modrinthBuildChoices,
    modrinthBuildLoading,
    modrinthBuildError,
    modrinthBuildMc,
    modrinthBuildVersionId,
    retryModrinthBuilds: () => setModrinthBuildRetry((retry) => retry + 1),
    loadMoreModrinth,
    displayedModrinthPacks,
    selectedModrinthVersion,
    modrinthLoaderOptionList,
    modrinthSupportedGameVersions,
    selectedModrinthLoaderOption,
    selectedModrinthLoaderChoice,
    modrinthBuildUnavailable,
  };
}

export type ModrinthBrowseState = ReturnType<typeof useModrinthBrowse>;
