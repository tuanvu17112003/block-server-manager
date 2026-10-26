// Install report card (extracted from Create.tsx step 4, WP-6.5). Defensive across the IPC boundary:
// missing fields reduce detail instead of crashing. Renders planId/serverId, warnings/errors, file
// outcomes and stage evidence including the verified-install (`verify-boot`) stage.
import { Badge } from '../../components/ui';
import type { PipelineInstallReport } from '../../tauri';
import { MAX_REPORT_DETAIL_ROWS, formatBytes } from './helpers';

export function ReportCard({ report }: { report: PipelineInstallReport }) {
  const loader = report.loader;
  const files = report.files ?? [];
  const warnings = report.warnings ?? [];
  const errors = report.errors ?? [];
  const stages = report.stages ?? [];
  const facts = [
    loader
      ? `Minecraft ${loader.minecraftVersion || 'unknown version'} · ${loader.kind || 'unknown loader'}${loader.loaderVersion ? ` ${loader.loaderVersion}` : ''}`
      : '',
    report.serverId ? `server ${report.serverId}` : '',
    report.planId ? `plan ${report.planId}` : '',
  ].filter((fact) => fact.length > 0);
  const outcomeCounts = files.reduce<Record<string, number>>((counts, file) => {
    const outcome = file.outcome || 'unknown';
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    return counts;
  }, {});
  const verifiedBoot = stages.some((stage) => stage.stage === 'verify-boot' && stage.outcome === 'complete');

  return (
    <section
      aria-labelledby="pipeline-install-report-heading"
      aria-live="polite"
      className="mt-3 space-y-2 rounded border border-zinc-700 bg-zinc-950 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="pipeline-install-report-heading" className="text-sm font-semibold text-zinc-100">Installation report</h4>
        <Badge tone={report.status === 'complete' ? 'green' : report.status === 'cancelled' ? 'amber' : 'red'}>
          {report.status ?? 'unknown'}
        </Badge>
      </div>
      <p className="text-xs text-zinc-400">
        {facts.length > 0 ? `${facts.join(' · ')} · ` : ''}
        {files.length} file result(s)
      </p>
      {verifiedBoot && (
        <p role="status" className="rounded border border-emerald-900 bg-emerald-950/30 p-2 text-xs text-emerald-200">
          Verified install: the fresh server reached “Done (” once before it was published. First start is expected to succeed.
        </p>
      )}
      {Object.keys(outcomeCounts).length > 0 && (
        <ul aria-label="File result counts" className="flex flex-wrap gap-2 text-xs text-zinc-300">
          {Object.entries(outcomeCounts).map(([outcome, count]) => (
            <li key={outcome} className="rounded border border-zinc-800 px-2 py-1">{outcome}: {count}</li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <div role="status" className="rounded border border-amber-900 bg-amber-950/30 p-2 text-xs text-amber-100">
          <p className="font-medium">Warnings</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {warnings.slice(0, 20).map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}
          </ul>
          {warnings.length > 20 && <p className="mt-1 text-amber-300">Showing 20 of {warnings.length} warnings.</p>}
        </div>
      )}
      {errors.length > 0 && (
        <div role="alert" className="rounded border border-red-900 bg-red-950/30 p-2 text-xs text-red-200">
          <p className="font-medium">Errors</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {errors.slice(0, 20).map((error, index) => <li key={`${index}:${error}`}>{error}</li>)}
          </ul>
          {errors.length > 20 && <p className="mt-1 text-red-300">Showing 20 of {errors.length} errors.</p>}
        </div>
      )}
      <details className="rounded border border-zinc-800 p-2">
        <summary className="cursor-pointer text-xs font-medium text-zinc-300">File outcomes ({files.length})</summary>
        <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto text-xs text-zinc-400">
          {files.slice(0, MAX_REPORT_DETAIL_ROWS).map((file, index) => (
            <li key={`${file.path}:${index}`} className="border-b border-zinc-900 pb-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0 flex-1 break-all text-zinc-200">{file.path}</span>
                <Badge tone={file.outcome === 'installed' || file.outcome === 'verified' ? 'green' : (file.outcome ?? '').toLowerCase().includes('failed') ? 'red' : 'zinc'}>{file.outcome ?? 'unknown'}</Badge>
              </div>
              {file.detail && <p className="mt-1 break-words">{file.detail}</p>}
              {file.sizeBytes !== null && file.sizeBytes !== undefined && <p className="mt-1">{formatBytes(file.sizeBytes)}</p>}
            </li>
          ))}
        </ul>
        {files.length > MAX_REPORT_DETAIL_ROWS && (
          <p className="mt-2 text-xs text-zinc-500">
            Showing the first {MAX_REPORT_DETAIL_ROWS} entries. {report.status === 'complete' ? 'The complete report is saved in install-report.json in the new server folder.' : 'All stage outcomes and errors are listed above.'}
          </p>
        )}
      </details>
      {stages.length > 0 && (
        <details className="rounded border border-zinc-800 p-2">
          <summary className="cursor-pointer text-xs font-medium text-zinc-300">Stage outcomes ({stages.length})</summary>
          <ul className="mt-2 space-y-1 text-xs text-zinc-400">
            {stages.slice(0, 50).map((stage, index) => (
              <li key={`${stage.stage}:${index}`}><span className="text-zinc-200">{stage.stage ?? 'unknown'}</span> · {stage.outcome ?? 'unknown'}{stage.detail ? ` · ${stage.detail}` : ''}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
