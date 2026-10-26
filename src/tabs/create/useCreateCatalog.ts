// Server catalogue state (vanilla/paper versions + loader builds) for the Create wizard.
// Extracted from Create.tsx (WP-6.5) and extended with explicit retry counters (WP-6.3).
import { useEffect, useMemo, useState } from 'react';
import type { LoaderChoiceDto, MinecraftVersionDto } from '../../tauri';
import { hasBackend, tauriVersions } from '../../tauri';

export function useCreateCatalog({ kind }: { kind: 'vanilla' | 'curseforge' | 'modrinth' }) {
  const [vanillaMc, setVanillaMc] = useState('1.20.4');
  const [serverLoader, setServerLoader] = useState('Vanilla');
  const [vanillaVersions, setVanillaVersions] = useState<MinecraftVersionDto[]>([]);
  const [paperVersions, setPaperVersions] = useState<MinecraftVersionDto[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState('');
  const [versionsRetry, setVersionsRetry] = useState(0);
  const [showSnapshots, setShowSnapshots] = useState<boolean>(() => {
    try { return localStorage.getItem('mc-showSnapshots') === '1'; } catch { return false; }
  });
  const [showAllBuilds, setShowAllBuilds] = useState<boolean>(() => {
    try { return localStorage.getItem('mc-showAllBuilds') === '1'; } catch { return false; }
  });
  const [loaderChoices, setLoaderChoices] = useState<LoaderChoiceDto[]>([]);
  const [selectedLoaderChoice, setSelectedLoaderChoice] = useState<LoaderChoiceDto | null>(null);
  const [loaderLoading, setLoaderLoading] = useState(false);
  const [loaderError, setLoaderError] = useState('');
  const [loaderRetry, setLoaderRetry] = useState(0);

  // Catalogue (vanilla + paper) with a retry counter so a transient provider failure is recoverable.
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
  }, [versionsRetry]);

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
  const loaderToggleStale = Boolean(!showAllBuilds && selectedLoaderChoice && selectedLoaderChoice.stable === false);

  useEffect(() => {
    try { localStorage.setItem('mc-showSnapshots', showSnapshots ? '1' : '0'); } catch { /* storage unavailable */ }
  }, [showSnapshots]);
  useEffect(() => {
    try { localStorage.setItem('mc-showAllBuilds', showAllBuilds ? '1' : '0'); } catch { /* storage unavailable */ }
  }, [showAllBuilds]);

  useEffect(() => {
    if (!hasBackend() || versionsLoading || configureVersions.length === 0) return;
    if (!configureVersions.some((version) => version.id === vanillaMc)) {
      const fallback = filteredConfigureVersions[0] ?? configureVersions[0];
      if (fallback) setVanillaMc(fallback.id);
    }
  }, [configureVersions, filteredConfigureVersions, serverLoader, vanillaMc, versionsLoading]);

  // Loader builds for the selected Minecraft version/type; retry counter included (WP-6.3).
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
    }).catch((error: unknown) => {
      if (cancelled) return;
      const message = error && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : 'Could not resolve compatible server loaders.';
      setLoaderChoices([]);
      setSelectedLoaderChoice(null);
      setLoaderError(message);
    }).finally(() => {
      if (!cancelled) setLoaderLoading(false);
    });
    return () => { cancelled = true; };
  }, [vanillaMc, serverLoader, kind, loaderRetry]);

  const retryCatalogue = (): void => setVersionsRetry((retry) => retry + 1);
  const retryLoaders = (): void => setLoaderRetry((retry) => retry + 1);

  return {
    vanillaMc,
    setVanillaMc,
    serverLoader,
    setServerLoader,
    vanillaVersions,
    paperVersions,
    versionsLoading,
    versionsError,
    versionsRetry,
    retryCatalogue,
    showSnapshots,
    setShowSnapshots,
    showAllBuilds,
    setShowAllBuilds,
    loaderChoices,
    setLoaderChoices,
    selectedLoaderChoice,
    setSelectedLoaderChoice,
    loaderLoading,
    loaderError,
    setLoaderError,
    loaderRetry,
    retryLoaders,
    configureVersions,
    filteredConfigureVersions,
    selectedVersionDto,
    snapshotStale,
    displayedLoaderChoices,
    loaderToggleStale,
  };
}

export type CreateCatalogState = ReturnType<typeof useCreateCatalog>;
