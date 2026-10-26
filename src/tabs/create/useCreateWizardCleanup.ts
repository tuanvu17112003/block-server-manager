// Wizard unmount cleanup (WP-6.3/6.5): release the local source, discard a held review, cancel a
// running job best-effort and clear the mock timer. Extracted from Create.tsx.
import { useEffect } from 'react';
import { hasBackend, tauriInstall, tauriModpackPipeline } from '../../tauri';
import type { LocalMrpackSelection, PipelinePreviewDto } from '../../tauri';
import type { Kind } from './helpers';

interface CleanupRefs {
  localMrpackRef: { current: LocalMrpackSelection | null };
  pipelinePreviewRef: { current: PipelinePreviewDto | null };
  installCleanupRef: { current: { jobId: string | null; installing: boolean; kind: Kind } };
  installTimerRef: { current: number | null };
}

export function useCreateWizardCleanup(refs: CleanupRefs): void {
  useEffect(() => () => {
    if (refs.installTimerRef.current !== null) window.clearInterval(refs.installTimerRef.current);
    refs.installTimerRef.current = null;
    const selection = refs.localMrpackRef.current;
    if (selection && hasBackend()) {
      void tauriModpackPipeline.releaseLocalMrpack(selection.sourceId).catch(() => undefined);
    }
    const preview = refs.pipelinePreviewRef.current;
    if (preview && hasBackend()) {
      void tauriModpackPipeline.discardPreview(preview.previewId).catch(() => undefined);
    }
    const job = refs.installCleanupRef.current;
    if (job.jobId && job.installing && hasBackend()) {
      void (job.kind === 'modrinth' || job.kind === 'curseforge'
        ? tauriModpackPipeline.cancel(job.jobId)
        : tauriInstall.cancel(job.jobId)).catch(() => undefined);
    }
  }, []);
}

export type { CleanupRefs };
