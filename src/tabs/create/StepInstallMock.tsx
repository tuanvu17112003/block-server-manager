// Create step 4 — browser/mock install simulation (extracted from Create.tsx, WP-6.5).
import { Button, Card, CardTitle, ProgressBar } from '../../components/ui';
import type { Modpack } from '../../types';

interface StepInstallMockProps {
  progress: number;
  installing: boolean;
  doneId: string | null;
  hasBackend: boolean;
  eula: boolean;
  port: number;
  pack: Modpack | null;
  packVer: number;
  vanillaMc: string;
  onBack: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onFinish: () => void;
  onExitConsole: () => void;
}

export function StepInstallMock(props: StepInstallMockProps) {
  return (
    <Card>
      <CardTitle>Install {props.progress >= 100 ? '— done' : '— in progress (mock)'}</CardTitle>
      <ProgressBar value={props.progress} />
      <p className="mt-1 text-xs text-zinc-500">{Math.min(100, props.progress)}% · downloading server jar + mods…</p>
      <pre className="mc-console log-scroll mt-2 max-h-40 overflow-y-auto p-2">
        {`[install] resolving ${props.pack?.name ?? 'vanilla ' + props.vanillaMc}\n[install] downloading… ${Math.min(100, props.progress)}%\n[install] auto pre-first-run backup armed`}
      </pre>
      <div className="mt-3 flex flex-wrap gap-2">
        {props.progress < 100 ? (
          <>
            <Button variant="secondary" onClick={props.onBack}>← Back</Button>
            {props.installing ? <Button variant="destructive" onClick={props.onCancel}>Cancel</Button>
              : <Button variant="secondary" onClick={props.onRetry}>Retry</Button>}
            <Button disabled={props.progress < 100} onClick={props.onFinish}>Simulate finish (mock)</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={props.onRetry}>Retry</Button>
            <Button onClick={props.onFinish}>Done — create server</Button>
          </>
        )}
      </div>
      {props.doneId && (
        <div className="mt-3 rounded border border-emerald-800 bg-emerald-950/40 p-3 text-sm">
          <p>✅ {props.hasBackend ? 'Server record created' : 'Server created'}{!props.eula ? ' — note: EULA not accepted, Start is blocked until you accept it in Settings' : ''}.</p>
          <p className="mt-1 text-xs text-zinc-400">Client parity notice: players must join with the same MC version{props.pack ? ` and modpack version (${props.pack.packVersions[props.packVer].v})` : ''}. LAN hint: share {`127.0.0.1:${props.port}`} on your network.</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" pulse onClick={props.onExitConsole}>Go to Console — Start is pulsing</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

export type { StepInstallMockProps };
