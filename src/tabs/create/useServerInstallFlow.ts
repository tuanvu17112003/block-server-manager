// Non-modpack server install + mock install flow for the Create wizard (extracted from Create.tsx).
import { hasBackend, onJobProgress, tauriInstall, tauriModpackPipeline } from '../../tauri';
import type { CreateServerInput, JavaCandidate, LoaderChoiceDto } from '../../tauri';
import type { Modpack, Server } from '../../types';
import { errorText, serverFromInstall, type Kind } from './helpers';
import type { InstallState } from './useInstallState';
import type { PipelineReviewState } from './usePipelineReview';

export interface ServerInstallFlowDeps {
  kind: Kind;
  name: string;
  ram: number;
  port: number;
  eula: boolean;
  pack: Modpack | null;
  packVer: number;
  recommended: number;
  catalogue: {
    vanillaMc: string;
    serverLoader: string;
    selectedLoaderChoice: LoaderChoiceDto | null;
    loaderLoading: boolean;
    versionsLoading: boolean;
    snapshotStale: boolean;
    loaderError: string;
    loaderToggleStale: boolean;
  };
  java: { selected: JavaCandidate | null; loading: boolean; installing: boolean; override: boolean; path: string };
  state: InstallState;
  addServer: (server: Server) => void;
  pushToast: (message: string, tone: 'ok' | 'err' | 'info') => void;
  setStep: (step: number) => void;
  portBlocked: boolean;
  portOutOfRange: boolean;
  portConflict: boolean;
  /** Route through the modpack pipeline (backend CurseForge/Modrinth editions). */
  activeSource: () => { request: unknown; key: string } | null;
  pipeline: PipelineReviewState;
  runPipelinePreview: () => Promise<void>;
  installPipelinePreview: () => Promise<void>;
}

export function useServerInstallFlow(deps: ServerInstallFlowDeps) {
  const { state, catalogue, java, pushToast, setStep, addServer } = deps;

  const beginInstall = async (): Promise<void> => {
    if (!deps.name.trim()) {
      pushToast('Give the server a name first.', 'err');
      return;
    }
    if (deps.portBlocked) {
      pushToast(deps.portOutOfRange
        ? 'Port must be a number between 1 and 65535.'
        : deps.portConflict
          ? 'Another saved server already uses this port. Choose a free port.'
          : 'The backend reports this port is not available. Choose the suggested port or another free one.', 'err');
      return;
    }
    if (hasBackend() && (deps.kind === 'curseforge' || deps.kind === 'modrinth')) {
      const source = deps.activeSource();
      if (!source || !deps.pipeline.pipelinePreview || deps.pipeline.pipelinePreviewKey !== source.key) {
        await deps.runPipelinePreview();
      } else {
        await deps.installPipelinePreview();
      }
      return;
    }
    if (hasBackend()) {
      if (state.installingRef.current) return;
      if (!catalogue.selectedLoaderChoice || catalogue.loaderLoading || catalogue.versionsLoading) {
        pushToast('Wait for supported versions and loader choices to finish loading.', 'err');
        return;
      }
      if (catalogue.snapshotStale) {
        pushToast('The selected Minecraft version is a snapshot. Enable "Show snapshots" or choose a release before installing.', 'err');
        return;
      }
      if (catalogue.loaderError || catalogue.loaderToggleStale || catalogue.selectedLoaderChoice.loader !== catalogue.serverLoader) {
        pushToast('Choose an available version of the selected server loader before installing.', 'err');
        return;
      }
      if (!java.selected || java.loading || java.installing
        || (java.override && java.selected.path !== java.path.trim())) {
        pushToast('Select or install a compatible Java runtime first.', 'err');
        return;
      }
      state.installingRef.current = true;
      state.cancelRequestedRef.current = false;
      state.installRequestStartedRef.current = false;
      state.setCancelRequested(false);
      state.setInstalling(true);
      state.setInstallError('');
      state.setDoneId(null);
      state.setProgress(0);
      state.setInstallStage('Preparing');
      state.setInstallLogs([]);
      state.setInstallBytes({ downloaded: null, total: null });
      setStep(4);
      const jobId = 'install-' + window.crypto.randomUUID();
      state.setInstallJobId(jobId);
      const input: CreateServerInput = {
        name: deps.name.trim(),
        loader: catalogue.selectedLoaderChoice.loader,
        mcVersion: catalogue.vanillaMc,
        loaderVersion: catalogue.selectedLoaderChoice.version ?? undefined,
        port: deps.port,
        ramMb: deps.ram,
        javaPath: java.selected.path,
        eulaAccepted: deps.eula,
      };
      let unlisten: (() => void) | undefined;
      try {
        unlisten = await onJobProgress(jobId, (payload) => {
          const stage = payload.stage ?? 'Installing';
          state.setProgress(payload.progress);
          state.setInstallStage(stage);
          state.setInstallBytes({
            downloaded: payload.bytesDownloaded ?? null,
            total: payload.bytesTotal ?? null,
          });
          if (payload.log) {
            state.setInstallLogs((previous) => [...previous, '[' + stage + '] ' + payload.log].slice(-200));
          }
        });
        if (state.cancelRequestedRef.current) {
          setStep(3);
          state.setProgress(0);
          pushToast('Installation cancelled before it started.', 'info');
          return;
        }
        state.installRequestStartedRef.current = true;
        const dto = await tauriInstall.install(input, jobId);
        addServer(serverFromInstall(dto, deps.recommended));
        state.setDoneId(dto.id);
        state.setInstalling(false);
        state.setProgress(100);
        state.setInstallStage('Complete');
        state.setInstallError('');
        pushToast('Server installed and saved.', 'ok');
      } catch (error) {
        const message = errorText(error, 'Server installation failed.');
        if (state.cancelRequestedRef.current || message.toLowerCase().includes('cancelled')) {
          setStep(3);
          state.setInstallError('');
          state.setProgress(0);
          pushToast('Installation cancelled and staging files removed.', 'info');
        } else {
          state.setInstallError(message);
          pushToast(message, 'err');
        }
      } finally {
        unlisten?.();
        state.installingRef.current = false;
        state.setInstalling(false);
        state.setInstallJobId(null);
        state.setCancelRequested(false);
        state.cancelRequestedRef.current = false;
        state.installRequestStartedRef.current = false;
      }
      return;
    }
    if (state.installingRef.current) return;
    state.installingRef.current = true;
    setStep(4);
    state.setInstalling(true);
    state.setProgress(0);
    state.setInstallError('');
    state.setDoneId(null);
    state.installTimerRef.current = window.setInterval(() => {
      state.setProgress((p) => {
        if (p >= 100) {
          if (state.installTimerRef.current !== null) window.clearInterval(state.installTimerRef.current);
          state.installTimerRef.current = null;
          state.installingRef.current = false;
          return 100;
        }
        return p + Math.round(4 + Math.random() * 9);
      });
    }, 220);
  };

  const cancelInstall = async (): Promise<void> => {
    if (hasBackend()) {
      if (!state.installJobId || state.cancelRequestedRef.current) return;
      state.cancelRequestedRef.current = true;
      state.setCancelRequested(true);
      if (!state.installRequestStartedRef.current) return;
      try {
        const accepted = deps.kind === 'modrinth' || deps.kind === 'curseforge'
          ? await tauriModpackPipeline.cancel(state.installJobId)
          : await tauriInstall.cancel(state.installJobId);
        if (!accepted) {
          state.cancelRequestedRef.current = false;
          state.setCancelRequested(false);
          pushToast('The install is already being published. Wait for it to finish.', 'info');
        }
      } catch (error) {
        state.cancelRequestedRef.current = false;
        state.setCancelRequested(false);
        pushToast(errorText(error, 'Could not cancel the installation.'), 'err');
      }
      return;
    }
    if (state.installTimerRef.current !== null) window.clearInterval(state.installTimerRef.current);
    state.installTimerRef.current = null;
    state.installingRef.current = false;
    state.setInstalling(false);
    state.setProgress(0);
    pushToast('Install cancelled (mock).', 'info');
  };

  const finishInstall = (): void => {
    if (hasBackend()) return;
    const isMod = deps.kind !== 'vanilla';
    const mcVersion = isMod && deps.pack ? deps.pack.packVersions[deps.packVer].mc : catalogue.vanillaMc;
    const resolvedLoader = isMod && deps.pack ? deps.pack.packVersions[deps.packVer].loader.split(' ')[0] : 'Vanilla';
    const id = `srv-${Date.now()}`;
    addServer({
      id,
      name: deps.name.trim(),
      status: 'stopped',
      mcVersion,
      loader: resolvedLoader,
      loaderVersion: isMod && deps.pack ? deps.pack.packVersions[deps.packVer].loader : undefined,
      modpack: isMod && deps.pack ? deps.pack.name : undefined,
      playersOnline: 0,
      maxPlayers: 20,
      port: deps.port,
      ramMb: deps.ram,
      ramRecommendedMb: deps.recommended,
      uptimeSec: 0,
      cpuPct: 0,
      ramPct: 0,
      tps: null,
      mspt: null,
      address: '127.0.0.1',
      eulaAccepted: deps.eula,
      motd: 'A fresh server!',
      difficulty: 'Normal',
      gamemode: 'Survival',
      onlineMode: true,
      seed: String(Math.floor(Math.random() * 1e9)),
      worldName: 'world',
      worldSizeMb: 0,
      worldLastPlayed: '—',
      version: `${isMod && deps.pack ? deps.pack.packVersions[deps.packVer].mc : catalogue.vanillaMc} ${isMod && deps.pack ? deps.pack.packVersions[deps.packVer].loader.split(' ')[0] : 'Vanilla'}`,
    });
    pushToast('Pre-first-run backup snapshot created (mock).', 'ok');
    state.setDoneId(id);
    state.setInstalling(false);
    state.installingRef.current = false;
  };

  return { beginInstall, cancelInstall, finishInstall };
}
