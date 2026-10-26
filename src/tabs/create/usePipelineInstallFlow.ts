// Modpack pipeline preview/install flow for the Create wizard (extracted from Create.tsx, WP-6.5).
import { onJobProgress, tauriModpackPipeline } from '../../tauri';
import type {
  JavaCandidate,
  LocalMrpackSelection,
  ModrinthInstallLoader,
  PipelineCreateInput,
  PipelineSourceRequest,
  ServerDto,
} from '../../tauri';
import type { Server } from '../../types';
import { errorText, initialPipelineChoices, serverFromInstall, type Kind } from './helpers';
import type { InstallState } from './useInstallState';
import type { PipelineReviewState } from './usePipelineReview';

export interface PipelineInstallFlowDeps {
  step: number;
  setStep: (step: number) => void;
  kind: Kind;
  name: string;
  ram: number;
  port: number;
  eula: boolean;
  autoDeleteCurseForgeZip: boolean;
  localMrpack: LocalMrpackSelection | null;
  modpackName: string | null;
  curseforgeSelectedName: string;
  activeSource: () => { request: PipelineSourceRequest; key: string } | null;
  java: { selected: JavaCandidate | null; loading: boolean; installing: boolean; override: boolean; path: string };
  /** Server shape carried into store.addServer after a successful publish. */
  toServer: (dto: ServerDto, modpackLabel: string) => Server;
  recommended: number;
  addServer: (server: Server) => void;
  pushToast: (message: string, tone: 'ok' | 'err' | 'info') => void;
  state: InstallState;
  pipeline: PipelineReviewState;
  setModrinthInstallMc: (value: string) => void;
  setModrinthInstallLoader: (value: ModrinthInstallLoader | '') => void;
  setVanillaMc: (value: string) => void;
}

export function usePipelineInstallFlow(deps: PipelineInstallFlowDeps) {
  const {
    state, pipeline, java, pushToast,
    setStep, kind, name, ram, port, eula, autoDeleteCurseForgeZip,
    localMrpack, modpackName, curseforgeSelectedName, activeSource, recommended, addServer,
    setModrinthInstallMc, setModrinthInstallLoader, setVanillaMc,
  } = deps;

  const runPipelinePreview = async (sourceOverride?: { request: PipelineSourceRequest; key: string }): Promise<void> => {
    const source = sourceOverride ?? activeSource();
    if (!source) {
      pushToast('Choose a supported pack source and exact server loader first.', 'err');
      return;
    }
    if (state.installingRef.current) return;
    if (source.request.kind === 'modrinthRemote' && (!java.selected || java.loading || java.installing)) {
      pushToast('Select a compatible Java runtime before reviewing this remote pack.', 'err');
      return;
    }
    if (pipeline.pipelinePreview) {
      void tauriModpackPipeline.discardPreview(pipeline.pipelinePreview.previewId).catch(() => undefined);
    }
    state.installingRef.current = true;
    state.cancelRequestedRef.current = false;
    state.installRequestStartedRef.current = false;
    state.setCancelRequested(false);
    state.setInstalling(true);
    state.setInstallError('');
    state.setDoneId(null);
    pipeline.setPipelineReport(null);
    state.setProgress(0);
    state.setInstallStage('Reviewing modpack files');
    state.setInstallLogs([]);
    state.setInstallBytes({ downloaded: null, total: null });
    const previousStep = deps.step;
    setStep(4);
    const jobId = 'modpack-preview-' + window.crypto.randomUUID();
    state.setInstallJobId(jobId);
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await onJobProgress(jobId, (payload) => {
        const stage = payload.stage ?? 'Reviewing modpack files';
        state.setProgress((previous) => Math.max(previous, Math.max(0, Math.min(100, payload.progress))));
        state.setInstallStage(stage);
        state.setInstallBytes({
          downloaded: payload.bytesDownloaded ?? null,
          total: payload.bytesTotal ?? null,
        });
        if (payload.log) state.setInstallLogs((previous) => [...previous, `[${stage}] ${payload.log}`].slice(-200));
      });
      if (state.cancelRequestedRef.current) return;
      state.installRequestStartedRef.current = true;
      const preview = await tauriModpackPipeline.preview(source.request, jobId);
      pipeline.setPipelinePreview(preview);
      pipeline.setPipelinePreviewKey(source.key);
      pipeline.setPipelineFileChoices(initialPipelineChoices(preview.plan.fileDecisions));
      pipeline.setPipelineChoicePage(0);
      state.setInstallStage('Review ready');
      state.setProgress(100);
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
      if (state.cancelRequestedRef.current || message.toLowerCase().includes('cancelled')) {
        state.setInstallError('');
        state.setProgress(0);
        setStep(previousStep);
        pushToast('Pack review cancelled. No server files were changed.', 'info');
      } else {
        state.setInstallError(message);
        setStep(previousStep);
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
  };

  const installPipelinePreview = async (): Promise<void> => {
    const source = activeSource();
    if (!source || !pipeline.pipelinePreview || pipeline.pipelinePreviewKey !== source.key) {
      pushToast('The selected pack changed; review its files again.', 'err');
      return;
    }
    if (!name.trim()) {
      pushToast('Give the server a name first.', 'err');
      return;
    }
    const hasUnresolved = pipeline.pipelinePreview.plan.fileDecisions.some(
      (decision) => decision.action === 'awaitingUserChoice'
        && pipeline.pipelineFileChoices[decision.path] === undefined,
    );
    if (hasUnresolved) {
      pushToast('Choose Include or Exclude for every conflicting file.', 'err');
      return;
    }
    if (!java.selected || java.loading || java.installing
      || (java.override && java.selected.path !== java.path.trim())) {
      pushToast('Select a compatible Java runtime first.', 'err');
      return;
    }
    if (state.installingRef.current) return;
    state.installingRef.current = true;
    state.cancelRequestedRef.current = false;
    state.installRequestStartedRef.current = false;
    state.setCancelRequested(false);
    state.setInstalling(true);
    state.setInstallError('');
    state.setDoneId(null);
    pipeline.setPipelineReport(null);
    state.setProgress(0);
    state.setInstallStage('Preparing exact server runtime');
    state.setInstallLogs([]);
    state.setInstallBytes({ downloaded: null, total: null });
    setStep(4);
    const jobId = 'modpack-install-' + window.crypto.randomUUID();
    state.setInstallJobId(jobId);
    const input: PipelineCreateInput = {
      name: name.trim(),
      port,
      ramMb: ram,
      javaPath: java.selected.path,
      eulaAccepted: eula,
    };
    const choices = {
      files: pipeline.pipelineFileChoices,
      approvedReplacements: [],
      autoDeleteCurseForgeZip: kind === 'curseforge' && autoDeleteCurseForgeZip,
    };
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await onJobProgress(jobId, (payload) => {
        const stage = payload.stage ?? 'Installing modpack server';
        state.setProgress((previous) => Math.max(previous, Math.max(0, Math.min(100, payload.progress))));
        state.setInstallStage(stage);
        state.setInstallBytes({
          downloaded: payload.bytesDownloaded ?? null,
          total: payload.bytesTotal ?? null,
        });
        if (payload.log) state.setInstallLogs((previous) => [...previous, `[${stage}] ${payload.log}`].slice(-200));
      });
      if (state.cancelRequestedRef.current) return;
      state.installRequestStartedRef.current = true;
      const result = await tauriModpackPipeline.install(
        pipeline.pipelinePreview.previewId,
        input,
        choices,
        jobId,
      );
      pipeline.setPipelineReport(result.report);
      if (result.status === 'complete' && result.server) {
        const modpackLabel = kind === 'curseforge'
          ? `CurseForge server pack · ${curseforgeSelectedName}`
          : localMrpack?.fileName ?? modpackName ?? 'Modrinth modpack';
        addServer(deps.toServer(result.server, modpackLabel));
        state.setDoneId(result.server.id);
        state.setProgress(100);
        state.setInstallStage('Complete');
        state.setInstallError('');
        pipeline.setPipelinePreview(null);
        pipeline.setPipelinePreviewKey('');
        pipeline.setPipelineFileChoices({});
        pipeline.setPipelineChoicePage(0);
        pushToast('Modpack server installed and saved.', 'ok');
      } else {
        void tauriModpackPipeline.discardPreview(pipeline.pipelinePreview.previewId).catch(() => undefined);
        pipeline.setPipelinePreview(null);
        pipeline.setPipelinePreviewKey('');
        pipeline.setPipelineFileChoices({});
        pipeline.setPipelineChoicePage(0);
        state.setInstallError(result.error ?? result.report.errors.join('\n') ?? 'Modpack installation failed.');
        state.setProgress(0);
        if (result.status === 'cancelled') setStep(3);
      }
    } catch (error) {
      const message = errorText(error, 'Modpack server installation failed.');
      void tauriModpackPipeline.discardPreview(pipeline.pipelinePreview.previewId).catch(() => undefined);
      pipeline.setPipelinePreview(null);
      pipeline.setPipelinePreviewKey('');
      pipeline.setPipelineFileChoices({});
      pipeline.setPipelineChoicePage(0);
      state.setInstallError(message);
      pipeline.setPipelineReport(null);
      state.setProgress(0);
      if (state.cancelRequestedRef.current || message.toLowerCase().includes('cancelled')) {
        setStep(3);
        pushToast('Installation cancelled. No unverified files were published.', 'info');
      } else {
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
  };

  return { runPipelinePreview, installPipelinePreview };
}
