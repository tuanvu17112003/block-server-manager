// Pipeline file review (optional defaults + conflicting signals) — extracted from Create.tsx (WP-6.5).
import { Badge, Button } from '../../components/ui';
import type { PipelineFileChoice, PipelineFileDecision, PipelinePreviewDto } from '../../tauri';
import { MAX_REPORT_DETAIL_ROWS, decisionReasonLabel, describeEvidence, isReviewableDecision, type PipelineFileReason } from './helpers';

interface PipelineReviewProps {
  preview: PipelinePreviewDto;
  decisions: PipelineFileDecision[];
  fileChoices: Record<string, PipelineFileChoice>;
  choicePage: number;
  onChoice: (path: string, choice: PipelineFileChoice) => void;
  onPageChange: (page: number) => void;
}

export function PipelineReview(props: PipelineReviewProps) {
  const reviewChoices = props.decisions.filter(isReviewableDecision);
  const skipped = props.decisions.filter((decision) => decision.action === 'exclude');
  const pageCount = Math.max(1, Math.ceil(reviewChoices.length / MAX_REPORT_DETAIL_ROWS));
  const visible = reviewChoices.slice(
    props.choicePage * MAX_REPORT_DETAIL_ROWS,
    (props.choicePage + 1) * MAX_REPORT_DETAIL_ROWS,
  );
  const includedCount = props.decisions.filter((decision) => decision.action === 'include').length;

  return (
    <section
      aria-labelledby="pipeline-review-heading"
      aria-live="polite"
      className="mb-3 space-y-3 rounded border border-emerald-900 bg-emerald-950/20 p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 id="pipeline-review-heading" className="text-sm font-semibold text-emerald-200">Review server files</h4>
          <p className="mt-1 break-all text-xs text-zinc-300">{props.preview.sourceName}</p>
        </div>
        <Badge tone="green">Minecraft {props.preview.plan.loader.minecraftVersion} · {props.preview.plan.loader.kind}</Badge>
      </div>
      {props.preview.evidence && (() => {
        const evidence = describeEvidence(props.preview.evidence);
        return (
          <div className="rounded border border-zinc-800 bg-zinc-950 p-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={evidence.tone}>{evidence.label}</Badge>
              <span className="text-xs text-zinc-500">{props.preview.evidence.formatId}</span>
            </div>
            {!evidence.supported && (
              <p role="alert" className="mt-1 text-xs text-amber-100">
                This format works from its specification, but has not been installed and started end-to-end
                with a real pack yet. Review the files carefully.
              </p>
            )}
            <p className="mt-1 text-xs text-zinc-400">{props.preview.evidence.note}</p>
          </div>
        );
      })()}
      <p role="status" className="text-xs text-zinc-300">
        {includedCount} files included · {skipped.length} skipped · {reviewChoices.length} choices to review.
      </p>
      {props.preview.plan.loader.kind === 'quilt' && (
        <p role="alert" className="rounded border border-amber-900 bg-amber-950/30 p-2 text-xs text-amber-100">
          Quilt server installation is not available yet. This pack can be reviewed, but it cannot be installed.
        </p>
      )}
      {props.preview.warnings.length > 0 && (
        <div className="rounded border border-amber-900 bg-amber-950/30 p-2">
          <p className="text-xs font-medium text-amber-200">Pack warnings</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-amber-100">
            {props.preview.warnings.slice(0, 20).map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}
          </ul>
          {props.preview.warnings.length > 20 && (
            <p className="mt-1 text-xs text-amber-300">Showing 20 of {props.preview.warnings.length} warnings.</p>
          )}
        </div>
      )}
      {reviewChoices.length > 0 ? (
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-zinc-200">Optional files and conflicting server flags</legend>
          {visible.map((decision, index) => {
            const selectedChoice = props.fileChoices[decision.path];
            const isConflict = decision.action === 'awaitingUserChoice';
            const controlName = `pipeline-choice-${props.preview.previewId}-${props.choicePage}-${index}`;
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
                          onChange={() => props.onChoice(decision.path, choice)}
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
                      onChange={(event) => props.onChoice(decision.path, event.target.checked ? 'include' : 'exclude')}
                      className="h-3.5 w-3.5"
                    />
                    Include this optional file on the server
                  </label>
                )}
              </div>
            );
          })}
          {pageCount > 1 && (
            <nav aria-label="Optional and conflict file choice pages" className="flex flex-wrap items-center justify-between gap-2">
              <p role="status" className="text-xs text-zinc-400">
                Choices {props.choicePage * MAX_REPORT_DETAIL_ROWS + 1}–{Math.min((props.choicePage + 1) * MAX_REPORT_DETAIL_ROWS, reviewChoices.length)} of {reviewChoices.length}
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={props.choicePage === 0} onClick={() => props.onPageChange(Math.max(0, props.choicePage - 1))}>Previous</Button>
                <Button size="sm" variant="secondary" disabled={props.choicePage + 1 >= pageCount} onClick={() => props.onPageChange(Math.min(pageCount - 1, props.choicePage + 1))}>Next</Button>
              </div>
            </nav>
          )}
        </fieldset>
      ) : (
        <p role="status" className="text-xs text-zinc-400">No optional or conflicting file choices are required.</p>
      )}
      {skipped.length > 0 && (
        <details className="rounded border border-zinc-800 bg-zinc-950 p-2">
          <summary className="cursor-pointer text-xs font-medium text-zinc-300">Skipped files ({skipped.length})</summary>
          <ul className="mt-2 max-h-36 space-y-1 overflow-y-auto text-xs text-zinc-400">
            {skipped.slice(0, MAX_REPORT_DETAIL_ROWS).map((decision) => (
              <li key={decision.path} className="break-all">
                {decision.path} <span className="text-zinc-600">· {decisionReasonLabel(decision.reason as PipelineFileReason)}</span>
              </li>
            ))}
          </ul>
          {skipped.length > MAX_REPORT_DETAIL_ROWS && (
            <p className="mt-1 text-xs text-zinc-500">Showing the first {MAX_REPORT_DETAIL_ROWS} skipped paths.</p>
          )}
        </details>
      )}
    </section>
  );
}

export type { PipelineReviewProps };

