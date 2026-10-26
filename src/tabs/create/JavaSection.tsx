// Create configure — Java runtime section (extracted from Create.tsx, WP-6.5 / WP-6.3 retries).
import { Button, Field, ProgressBar, inputCls } from '../../components/ui';
import type { JavaCandidate, JavaDetection } from '../../tauri';
import { javaCandidateLabel } from './helpers';

interface JavaSectionProps {
  hasBackend: boolean;
  javaDetection: JavaDetection | null;
  javaSelected: JavaCandidate | null;
  javaPath: string;
  javaOverride: boolean;
  javaLoading: boolean;
  javaInstalling: boolean;
  javaProgress: number;
  javaProgressLog: string;
  javaError: string;
  onPathChange: (value: string) => void;
  onValidatePath: () => void;
  onToggleOverride: (override: boolean) => void;
  onUseDetected: () => void;
  onInstallJava: () => void;
  onRetryDetection: () => void;
}

export function JavaSection(props: JavaSectionProps) {
  const statusText = props.javaLoading
    ? 'Checking installed Java…'
    : props.javaSelected
      ? `${javaCandidateLabel(props.javaSelected)}${props.javaOverride ? ' · override' : ' · auto'}`
      : props.javaDetection
        ? `No Java ${props.javaDetection.installMajor} runtime found. Install the recommended runtime before starting this pack.`
        : 'Java requirement unavailable.';

  return (
    <div className="space-y-2">
      <Field
        label={props.javaDetection ? `Java required: ${props.javaDetection.requiredMajor}` : 'Java runtime'}
        hint={props.hasBackend ? 'Java is checked against Mojang version metadata. You can install Temurin or choose a JDK path.' : 'Detected automatically at launch (mock).'}
      >
        {!props.hasBackend ? (
          <input value="Auto — Temurin 17/21 (mock)" readOnly disabled className={`${inputCls} opacity-60`} />
        ) : (
          <div className="space-y-2 rounded border border-zinc-800 bg-zinc-950 p-2.5">
            <p className="text-sm text-zinc-200">{statusText}</p>
            {props.javaSelected && <p className="break-all text-xs text-zinc-500">{props.javaSelected.path}</p>}
            {props.javaOverride && (
              <div className="space-y-2">
                <input
                  aria-label="Java executable path override"
                  value={props.javaPath}
                  onChange={(event) => props.onPathChange(event.target.value)}
                  placeholder="JDK home folder or bin\\java.exe"
                  className={inputCls}
                />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" disabled={props.javaLoading || props.javaInstalling} onClick={props.onValidatePath}>Validate path</Button>
                  <Button size="sm" variant="ghost" onClick={props.onUseDetected}>Use detected Java</Button>
                </div>
              </div>
            )}
            {props.javaError && (
              <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-red-300">
                <span>{props.javaError}</span>
                <Button size="sm" variant="secondary" disabled={props.javaLoading || props.javaInstalling} onClick={props.onRetryDetection}>
                  Retry Java detection
                </Button>
              </p>
            )}
            {props.javaInstalling && (
              <div className="space-y-1">
                <ProgressBar value={props.javaProgress} />
                <p className="text-xs text-zinc-400">{props.javaProgress}% · {props.javaProgressLog}</p>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {!props.javaOverride && (
                <Button size="sm" variant="secondary" disabled={!props.javaDetection || props.javaLoading || props.javaInstalling} onClick={() => props.onToggleOverride(true)}>Change…</Button>
              )}
              <Button size="sm" disabled={!props.javaDetection || props.javaLoading || props.javaInstalling} onClick={props.onInstallJava}>
                Install Temurin Java {props.javaDetection?.installMajor ?? '…'}
              </Button>
            </div>
          </div>
        )}
      </Field>
    </div>
  );
}

export type { JavaSectionProps };
