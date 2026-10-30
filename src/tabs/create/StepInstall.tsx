// Create step 4 — backend install progress, report and done state (extracted from Create.tsx, WP-6.5).
import { Button, Card, CardTitle, ProgressBar } from '../../components/ui';
import type {
  CurseForgeArchiveInspection,
  LoaderChoiceDto,
  ModrinthInstallLoader,
  ModrinthModpackDto,
  ModrinthProjectVersionDto,
  PipelineInstallReport,
} from '../../tauri';
import { ReportCard } from './ReportCard';
import { MODRINTH_LOADER_NAMES, cfInstallable, formatBytes, type Kind } from './helpers';

interface StepInstallProps {
  doneId: string | null;
  installing: boolean;
  progress: number;
  installStage: string;
  installBytes: { downloaded: number | null; total: number | null };
  installError: string;
  installLogs: string[];
  report: PipelineInstallReport | null;
  cancelRequested: boolean;
  kind: Kind;
  port: number;
  eula: boolean;
  cfInspection: CurseForgeArchiveInspection | null;
  selectedModrinthPack: ModrinthModpackDto | null;
  selectedModrinthVersion: ModrinthProjectVersionDto | null;
  modrinthInstallMc: string;
  modrinthInstallLoader: ModrinthInstallLoader | '';
  vanillaMc: string;
  selectedLoaderChoice: LoaderChoiceDto | null;
  serverLoader: string;
  autoDeleteCurseForgeZip: boolean;
  onCancel: () => void;
  onBackToConfigure: () => void;
  onRetry: () => void;
  retryDisabled: boolean;
  onExitConsole: () => void;
}

export function StepInstall(props: StepInstallProps) {
  const mcloader = props.modrinthInstallLoader ? MODRINTH_LOADER_NAMES[props.modrinthInstallLoader] : 'the selected loader';
  return (
    <Card>
      <CardTitle>Install — {props.doneId ? 'done' : props.installing ? 'in progress' : 'needs attention'}</CardTitle>
      <ProgressBar value={props.progress} />
      <p className="mt-1 text-xs text-zinc-400">
        {props.progress}% · {props.installStage || 'Waiting to start'}
        {props.installBytes.total !== null && props.installBytes.downloaded !== null
          ? ' · ' + formatBytes(props.installBytes.downloaded) + ' / ' + formatBytes(props.installBytes.total)
          : ''}
      </p>
      {props.installError && <p role="alert" className="mt-2 text-sm text-red-300">{props.installError}</p>}
      <pre className="mc-console log-scroll mt-2 max-h-48 overflow-y-auto p-2">
        {/* The placeholder must reflect the actual state. Previously it said "Waiting for installer output…" even on the
            Done screen, which reads as though the install were still pending while the card above says Complete — a real
            source of "why does it look stuck?" confusion. */}
        {props.installLogs.length
          ? props.installLogs.join('\n')
          : props.doneId
            ? 'Install finished. Open the console to watch the server output.'
            : props.installing
              ? 'Waiting for installer output…'
              : 'No installer output was captured.'}
      </pre>
      {props.report && <ReportCard report={props.report} />}
      <div className="mt-3 flex flex-wrap gap-2">
        {props.doneId ? (
          <Button onClick={props.onExitConsole} pulse>Done — Go to Console</Button>
        ) : props.installing ? (
          <Button variant="destructive" disabled={props.cancelRequested} onClick={props.onCancel}>
            {props.cancelRequested ? 'Canceling…' : 'Cancel'}
          </Button>
        ) : (
          <>
            <Button variant="secondary" disabled={props.installing} onClick={props.onBackToConfigure}>← Back to Configure</Button>
            <Button disabled={props.installing || props.retryDisabled} onClick={props.onRetry}>Retry</Button>
          </>
        )}
      </div>
      {props.doneId && (
        <div className="mt-3 rounded border border-emerald-800 bg-emerald-950/40 p-3 text-sm">
          <p>
            ✅ {props.kind === 'curseforge'
              ? props.cfInspection?.classification === 'clientExport'
                ? 'CurseForge client pack installed and saved (manifest mods resolved keylessly).'
                : 'CurseForge server pack installed and saved.'
              : props.kind === 'modrinth' && props.selectedModrinthPack
                ? `${props.selectedModrinthPack.name} installed and saved.`
                : 'Server installed and saved'}
            {!props.eula ? ' Start stays blocked until you accept the EULA in Settings.' : ''}
          </p>
          {props.kind === 'curseforge' && cfInstallable(props.cfInspection) && props.cfInspection ? (
            <p className="mt-1 text-xs text-zinc-400">
              Join with Minecraft {props.cfInspection.minecraftVersion} and {props.cfInspection.loader} {props.cfInspection.loaderVersion}.
              {' '}{props.autoDeleteCurseForgeZip ? 'The staged ZIP copy was set to delete after successful installation.' : 'The staged ZIP was retained.'}
              {' '}LAN hint: share 127.0.0.1:{props.port} on your network.
            </p>
          ) : props.kind === 'modrinth' && props.selectedModrinthPack && props.selectedModrinthVersion ? (
            <p className="mt-1 text-xs text-zinc-400">
              Client parity notice: players should use Modrinth pack version {props.selectedModrinthVersion.versionNumber} ({props.selectedModrinthVersion.id}) for Minecraft {props.modrinthInstallMc} with {mcloader}. The server install includes every file listed in the selected pack.
              {' '}LAN hint: share 127.0.0.1:{props.port} on your network.
            </p>
          ) : (
            <p className="mt-1 text-xs text-zinc-400">
              Client parity notice: players must join with Minecraft {props.vanillaMc} and loader {props.selectedLoaderChoice?.loader ?? props.serverLoader}.
              {' '}LAN hint: share 127.0.0.1:{props.port} on your network.
            </p>
          )}
          <div className="mt-2">
            <Button size="sm" pulse onClick={props.onExitConsole}>Go to Console — Start is pulsing</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

export type { StepInstallProps };
