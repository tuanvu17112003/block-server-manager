// Pipeline review/preview state for the Create wizard (extracted from Create.tsx, WP-6.5).
import { useState } from 'react';
import type { PipelineFileChoice, PipelineInstallReport, PipelinePreviewDto } from '../../tauri';
import { initialPipelineChoices } from './helpers';

interface Options {
  /** Best-effort discard of a server-side review session. */
  discardPreview: (previewId: string) => void;
  /** Release the held local .mrpack session (desktop). */
  onReleaseLocal: () => void;
}

export function usePipelineReview({ discardPreview, onReleaseLocal }: Options) {
  const [pipelinePreview, setPipelinePreview] = useState<PipelinePreviewDto | null>(null);
  const [pipelinePreviewKey, setPipelinePreviewKey] = useState('');
  const [pipelineFileChoices, setPipelineFileChoices] = useState<Record<string, PipelineFileChoice>>({});
  const [pipelineChoicePage, setPipelineChoicePage] = useState(0);
  const [pipelineReport, setPipelineReport] = useState<PipelineInstallReport | null>(null);

  /** Drop the held preview/report and release the local source (Back/type changes/unmount). */
  const clearPipelineReview = (): void => {
    if (pipelinePreview) discardPreview(pipelinePreview.previewId);
    onReleaseLocal();
    setPipelinePreview(null);
    setPipelinePreviewKey('');
    setPipelineFileChoices({});
    setPipelineChoicePage(0);
    setPipelineReport(null);
  };

  /** Seed choices: optional files default include; conflicts stay unanswered until the user picks. */
  const seedPipelineChoices = (preview: PipelinePreviewDto): void => {
    setPipelineFileChoices(initialPipelineChoices(preview.plan.fileDecisions));
  };

  const setPipelineChoice = (path: string, choice: PipelineFileChoice): void => {
    setPipelineFileChoices((previous) => ({ ...previous, [path]: choice }));
  };

  return {
    pipelinePreview,
    setPipelinePreview,
    pipelinePreviewKey,
    setPipelinePreviewKey,
    pipelineFileChoices,
    setPipelineFileChoices,
    pipelineChoicePage,
    setPipelineChoicePage,
    pipelineReport,
    setPipelineReport,
    pipelineChoice: setPipelineChoice,
    clearPipelineReview,
    seedPipelineChoices,
  };
}

export type PipelineReviewState = ReturnType<typeof usePipelineReview>;
