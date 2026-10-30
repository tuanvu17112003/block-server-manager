// Google Drive backup panel, shown in the Backups tab.
//
// This is the user-facing half of the Drive integration. The important distinction it makes visible: the OAuth client
// configured by the maintainer identifies the *application*; the account shown here is the *user's own* Google account,
// connected by them, with tokens stored encrypted on their machine. No credential of the user's ever leaves it, and the
// backups land in their Drive, not anyone else's.
//
// States handled explicitly, because each one is a real situation a user will hit:
//   * not configured  — the app has no OAuth client; nothing the user can do, so say so instead of a dead button;
//   * configured but not connected — offer Connect, which opens their browser;
//   * connected — show quota and the remote backup list, with upload and delete per item;
//   * needs re-auth   — the refresh token died (revoked, password change, 6 months unused); retrying is pointless, so
//                       offer Reconnect rather than an error the user cannot act on.
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, CardTitle } from '../components/ui';

const bridge = typeof window !== 'undefined' ? window.electronAPI : undefined;

interface QuotaInfo {
  limitBytes: number;
  usageBytes: number;
  remainingBytes: number;
}

interface DriveStatus {
  configured: boolean;
  connected: boolean;
  /** Why Drive cannot be used, when configured is false. Shown verbatim so the user can fix their own setup. */
  configError?: string;
  configWarning?: string;
  needsReauth?: boolean;
  lastError?: string;
  quota?: QuotaInfo;
}

interface DriveFile {
  id: string;
  name: string;
  sizeBytes: number;
  createdAt: string;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export default function DrivePanel({ serverId, refreshKey }: { serverId: string; refreshKey?: number }) {
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    const next = await bridge?.invoke('gdrive_status') as DriveStatus | undefined;
    if (next !== undefined) setStatus(next);
  }, []);

  const loadFiles = useCallback(async () => {
    const result = await bridge?.invoke('gdrive_list_backups') as { ok: boolean; files?: DriveFile[]; error?: string } | undefined;
    if (result?.ok === true && result.files !== undefined) setFiles(result.files);
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (status?.connected === true) void loadFiles();
  }, [status?.connected, loadFiles]);

  // Reload when the parent reports a new upload. Without this the panel kept showing a stale list: a file uploaded from
  // the backup row appeared in Google Drive but the panel still said "0 backups", which reads as a failed upload.
  useEffect(() => {
    if (refreshKey === undefined || status?.connected !== true) return;
    void loadFiles();
  }, [refreshKey, status?.connected, loadFiles]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
      void loadStatus();
    }
    void label;
  };

  const connect = () => run('connect', async () => {
    const next = await bridge?.invoke('gdrive_connect') as DriveStatus | undefined;
    if (next !== undefined) setStatus(next);
    setNotice('Connected. Backups from this server will be uploaded to your Google Drive.');
  });

  const disconnect = () => run('disconnect', async () => {
    const next = await bridge?.invoke('gdrive_disconnect') as DriveStatus | undefined;
    if (next !== undefined) setStatus(next);
    setFiles([]);
    setNotice('Disconnected. Stored tokens were removed from this computer.');
  });

  const deleteRemote = (file: DriveFile) => run('delete', async () => {
    await bridge?.invoke('gdrive_delete_backup', { fileId: file.id });
    setNotice(`Deleted "${file.name}" from Google Drive.`);
    await loadFiles();
  });

  if (status === null) {
    return (
      <Card>
        <CardTitle>Google Drive</CardTitle>
        <p className="text-sm text-zinc-500">Checking connection…</p>
      </Card>
    );
  }

  if (!status.configured) {
    return (
      <Card>
        <CardTitle>Google Drive</CardTitle>
        <p className="text-sm text-zinc-400">
          Backup upload to Google Drive is not set up yet.
        </p>
        {/* The specific reason, not a blanket "not configured": the most likely causes are a missing file, a file in
            the wrong shape, or a client of the wrong type — and the user can fix all three themselves if told which. */}
        {status.configError !== undefined && (
          <p className="mt-2 text-xs text-amber-200">{status.configError}</p>
        )}
        <div className="mt-3 rounded border border-zinc-800 bg-zinc-900/60 p-2 text-xs text-zinc-400">
          <p className="font-semibold text-zinc-300">How to set it up</p>
          <ol className="mt-1 list-decimal space-y-1 pl-4">
            <li>In Google Cloud Console, enable the Drive API and create an OAuth client of type <span className="font-mono">Desktop app</span>.</li>
            <li>Download the JSON file it offers.</li>
            <li>
              Save it as <span className="font-mono">google-oauth.json</span> in the app data folder, replacing the
              existing file. The <span className="font-mono">installed</span> object is read from it directly — do not
              rewrite the file into a different shape.
            </li>
            <li>Restart the app, then click Connect.</li>
          </ol>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardTitle>Google Drive backup</CardTitle>

      {status.configWarning !== undefined && (
        <p className="mb-2 text-xs text-amber-200">{status.configWarning}</p>
      )}

      {!status.connected && (
        <>
          <p className="text-sm text-zinc-400">
            Connect your own Google account to upload this server&apos;s backups to your Drive. The app can only see
            files it creates; nothing else in your Drive is read. Your sign-in stays on this computer, encrypted.
          </p>
          {status.needsReauth === true && (
            <p className="mt-2 text-xs text-amber-200">
              Your Google authorization has expired or was revoked. Reconnect to resume uploading.
              {status.lastError !== undefined ? ` (${status.lastError})` : ''}
            </p>
          )}
          <div className="mt-3">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => { void connect(); }}>
              {busy ? 'Opening browser…' : status.needsReauth === true ? 'Reconnect Google Drive' : 'Connect Google Drive'}
            </Button>
          </div>
        </>
      )}

      {status.connected && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="green">Connected</Badge>
            {status.quota !== undefined && status.quota.limitBytes > 0 && (
              <span className="text-xs text-zinc-400">
                {formatBytes(status.quota.usageBytes)} of {formatBytes(status.quota.limitBytes)} used
                {' · '}
                <span className={status.quota.remainingBytes < 1024 ** 3 ? 'text-amber-300' : ''}>
                  {formatBytes(status.quota.remainingBytes)} free
                </span>
              </span>
            )}
            <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={() => { void disconnect(); }}>
              Disconnect
            </Button>
          </div>

          {/* A quota that is nearly full is the difference between "auto-upload works" and "backups silently stop
              reaching the cloud weeks from now". The number alone does not convey that, so it is spelled out. */}
          {status.quota !== undefined && status.quota.limitBytes > 0 && status.quota.remainingBytes < 2 * 1024 ** 3 && (
            <p className="mt-2 text-xs text-amber-200">
              Google Drive is nearly full — {formatBytes(status.quota.remainingBytes)} remains. A backup larger than that
              will not upload, and automatic upload stops working once the Drive fills. Delete old backups here or in
              Google Drive to make room.
            </p>
          )}

          <div className="mt-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Backups in your Drive ({files.length})
              </span>
              <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={() => { void loadFiles(); }}>
                Refresh
              </Button>
            </div>

            {files.length === 0 && (
              <p className="mt-2 text-xs text-zinc-500">
                No backups uploaded yet. Backups made from now on upload automatically.
              </p>
            )}

            {files.length > 0 && (
              <ul className="mt-2 space-y-1">
                {files.map((file) => (
                  <li key={file.id} className="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900/60 px-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-zinc-200">{file.name}</p>
                      <p className="text-[11px] text-zinc-500">
                        {formatBytes(file.sizeBytes)} · {formatDate(file.createdAt)}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => { void deleteRemote(file); }}
                      title="Delete this backup from Google Drive (the local backup is not affected)"
                    >
                      Delete
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {notice !== null && <p className="mt-2 text-xs text-emerald-300">{notice}</p>}
      {error !== null && <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
      {serverId === '' && <p className="mt-2 text-xs text-zinc-500">Select a server to manage its Drive backups.</p>}
    </Card>
  );
}
