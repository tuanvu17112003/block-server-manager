// Auto-update panel for the App settings tab.
//
// Design intent: an update is offered, never imposed. This component shows what the app knows, gives the user one
// button per step, and refuses to install while a server is running — because installing restarts the app and would
// take the server down with it.
//
// The portable build is a real case, not an edge case: it cannot self-update (there is no installed application to
// replace), so instead of a broken "Check for updates" button the panel explains what to do instead.
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, CardTitle } from '../components/ui';
import { onUpdateState, type UpdateStatePayload } from '../tauri';

/** The preload bridge. Undefined in a browser build, where the update panel simply cannot act. */
const bridge = typeof window !== 'undefined' ? window.electronAPI : undefined;

function relativeTime(iso: string | undefined): string {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} day${hours < 48 ? '' : 's'} ago`;
}

export default function UpdatePanel() {
  const [state, setState] = useState<UpdateStatePayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void bridge?.invoke('update_state')
      .then((next) => setState(next as UpdateStatePayload))
      .catch(() => { /* status is optional: a failure here must not break the settings page */ });
  }, []);

  useEffect(() => {
    refresh();
    // The main process pushes state changes (download progress, availability). Refresh on each push so the panel and
    // the actual updater state cannot disagree; `refresh` re-reads the authoritative value rather than trusting the
    // event payload, which keeps one source of truth.
    let unsubscribe: (() => void) | undefined;
    void onUpdateState(() => { refresh(); }).then((fn) => { unsubscribe = fn; });
    return () => { if (typeof unsubscribe === 'function') unsubscribe(); };
  }, [refresh]);

  const run = async (command: 'update_check' | 'update_download' | 'update_install') => {
    setBusy(true);
    setError(null);
    try {
      const result = await bridge?.invoke(command, {});
      if (result === undefined) throw new Error('The desktop bridge is unavailable, so updates cannot be managed here.');
      refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  if (state === null) {
    return (
      <Card>
        <CardTitle>Updates</CardTitle>
        <p className="text-sm text-zinc-500">Reading update status…</p>
      </Card>
    );
  }

  if (!state.supported) {
    return (
      <Card>
        <CardTitle>Updates</CardTitle>
        <p className="text-sm text-zinc-400">
          This build does not update itself.{state.unsupportedReason ? ` ${state.unsupportedReason}` : ''}
        </p>
        <p className="mt-2 text-xs text-zinc-500">
          Current version: <span className="font-mono">{state.currentVersion}</span>
        </p>
      </Card>
    );
  }

  const stage = state.stage;
  const showProgress = stage === 'downloading';

  return (
    <Card>
      <CardTitle>Updates</CardTitle>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-zinc-400">
          Running <span className="font-mono text-zinc-200">{state.currentVersion}</span>
        </span>
        {stage === 'available' && state.availableVersion !== undefined && (
          <Badge tone="amber">Version {state.availableVersion} available</Badge>
        )}
        {stage === 'not-available' && <Badge tone="green">Up to date</Badge>}
        {stage === 'downloaded' && state.availableVersion !== undefined && (
          <Badge tone="green">Version {state.availableVersion} ready to install</Badge>
        )}
        {stage === 'error' && <Badge tone="red">Check failed</Badge>}
        <span className="text-xs text-zinc-500">Last checked {relativeTime(state.lastCheckedAt)}</span>
      </div>

      {showProgress && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>Downloading update…</span>
            <span className="font-mono">{state.percent ?? 0}%</span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-zinc-800">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${state.percent ?? 0}%` }} />
          </div>
        </div>
      )}

      {stage === 'available' && state.releaseNotes !== undefined && (
        <p className="mt-3 max-h-24 overflow-y-auto rounded border border-zinc-800 bg-zinc-900/60 p-2 text-xs text-zinc-400 thin-scroll">
          {state.releaseNotes}
        </p>
      )}

      {stage === 'downloaded' && (
        <p className="mt-3 text-xs text-amber-200">
          Installing restarts the app. Stop any running server first — a restart would shut it down without saving.
        </p>
      )}

      {(error !== null || state.error !== undefined) && (
        <p role="alert" className="mt-3 text-xs text-red-300">
          {error ?? state.error}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="default"
          disabled={busy || stage === 'checking' || stage === 'downloading'}
          onClick={() => { void run('update_check'); }}
        >
          {stage === 'checking' ? 'Checking…' : 'Check for updates'}
        </Button>

        {stage === 'available' && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => { void run('update_download'); }}>
            Download {state.availableVersion ?? 'update'}
          </Button>
        )}

        {stage === 'downloaded' && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => { void run('update_install'); }}>
            Restart and install
          </Button>
        )}
      </div>
    </Card>
  );
}
