// Global (app-level) settings — separated from the per-server Settings tab.
// Covers the CurseForge API key, download location, CurseForge ZIP retention and diagnostics.
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { Badge, Button, Card, CardTitle, inputCls } from '../components/ui';
import { hasBackend, tauriDiagnostics, tauriStorage } from '../tauri';
import type { StorageInfoDto } from '../tauri';
import { CURSEFORGE_AUTO_DELETE_KEY } from './create/helpers';
import UpdatePanel from './UpdatePanel';

/** Renderer-safe CurseForge key status (never contains the key itself). */
interface CurseForgeKeyStatusDto {
  configured: boolean;
  source: 'safeStorage' | 'file' | null;
  encrypted: boolean;
  hint: string;
}

function optionalInvokeError(error: unknown, fallback: string): string {
  const raw = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '';
  if (!raw) return fallback;
  const stripCommandPrefix = (text: string): string => text.replace(/^[a-z0-9_]+:\s*/i, '');
  try {
    const parsed = JSON.parse(raw) as { message?: string };
    return stripCommandPrefix(parsed?.message ?? raw);
  } catch {
    return stripCommandPrefix(raw);
  }
}

export default function AppSettings() {
  const { pushToast } = useStore();
  const [cfKeyStatus, setCfKeyStatus] = useState<CurseForgeKeyStatusDto | null>(null);
  const [cfKeyDraft, setCfKeyDraft] = useState('');
  const [cfKeyBusy, setCfKeyBusy] = useState(false);
  const [cfKeyError, setCfKeyError] = useState('');
  const [storageInfo, setStorageInfo] = useState<StorageInfoDto | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [bundleBusy, setBundleBusy] = useState(false);
  const [bundlePath, setBundlePath] = useState('');
  const [autoDeleteCurseForgeZip, setAutoDeleteCurseForgeZip] = useState(() => {
    try {
      return window.localStorage.getItem(CURSEFORGE_AUTO_DELETE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const desktopBridge = typeof window !== 'undefined' ? window.electronAPI : undefined;

  useEffect(() => {
    if (!hasBackend()) return;
    let cancelled = false;
    void tauriStorage.get()
      .then((value) => { if (!cancelled) setStorageInfo(value); })
      .catch(() => { /* storage IPC unavailable in this build */ });
    const bridge = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (bridge) {
      void bridge.invoke('curseforge_key_status')
        .then((value) => { if (!cancelled) setCfKeyStatus(value as CurseForgeKeyStatusDto); })
        .catch(() => {
          if (!cancelled) setCfKeyStatus({ configured: false, source: null, encrypted: false, hint: 'Key management is not available in this build yet.' });
        });
    }
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(CURSEFORGE_AUTO_DELETE_KEY, autoDeleteCurseForgeZip ? '1' : '0');
    } catch {
      /* preference storage unavailable */
    }
  }, [autoDeleteCurseForgeZip]);

  const saveCurseForgeKey = async (): Promise<void> => {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (!api) { pushToast('CurseForge key storage requires the desktop app.', 'info'); return; }
    const key = cfKeyDraft.trim();
    if (!key) { setCfKeyError('Enter a CurseForge API key first.'); return; }
    setCfKeyBusy(true);
    setCfKeyError('');
    try {
      const result = await api.invoke('curseforge_key_set', { key }) as { source?: string; encrypted?: boolean };
      const source: CurseForgeKeyStatusDto['source'] = result?.source === 'safeStorage' ? 'safeStorage' : 'file';
      setCfKeyStatus({
        configured: true,
        source,
        encrypted: Boolean(result?.encrypted),
        hint: source === 'safeStorage' ? 'Configured with OS-encrypted storage.' : 'Configured in the app-data fallback (managed automatically).',
      });
      setCfKeyDraft('');
      pushToast(source === 'safeStorage' ? 'CurseForge key saved with OS-encrypted storage.' : 'CurseForge key saved to the app data folder.', 'ok');
    } catch (error) {
      setCfKeyError(optionalInvokeError(error, 'Could not save the CurseForge key.'));
    } finally {
      setCfKeyBusy(false);
    }
  };

  const clearCurseForgeKey = async (): Promise<void> => {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (!api) { pushToast('CurseForge key storage requires the desktop app.', 'info'); return; }
    setCfKeyBusy(true);
    setCfKeyError('');
    try {
      await api.invoke('curseforge_key_clear', {});
      setCfKeyStatus({ configured: false, source: null, encrypted: false, hint: 'No key configured - keyless CurseForge routes still work.' });
      setCfKeyDraft('');
      pushToast('CurseForge key cleared.', 'ok');
    } catch (error) {
      setCfKeyError(optionalInvokeError(error, 'Could not clear the CurseForge key.'));
    } finally {
      setCfKeyBusy(false);
    }
  };

  const chooseDownloadsFolder = async (): Promise<void> => {
    if (!desktopBridge) { pushToast('Choosing a folder requires the desktop app.', 'info'); return; }
    setStorageBusy(true);
    setStorageError('');
    try {
      const picked = await tauriStorage.pickFolder();
      if (!picked) return;
      const info = await tauriStorage.set(picked);
      setStorageInfo(info);
      pushToast(`Downloads will be saved to ${info.effectiveDownloadsPath}.`, 'ok');
    } catch (error) {
      setStorageError(optionalInvokeError(error, 'Could not change the download folder.'));
    } finally {
      setStorageBusy(false);
    }
  };

  const resetDownloadsFolder = async (): Promise<void> => {
    if (!desktopBridge) return;
    setStorageBusy(true);
    setStorageError('');
    try {
      const info = await tauriStorage.set(null);
      setStorageInfo(info);
      pushToast('Download folder reset to the app default.', 'ok');
    } catch (error) {
      setStorageError(optionalInvokeError(error, 'Could not reset the download folder.'));
    } finally {
      setStorageBusy(false);
    }
  };

  const openStorageFolder = async (target: 'downloads' | 'data'): Promise<void> => {
    try {
      await tauriStorage.openFolder(target);
    } catch (error) {
      pushToast(optionalInvokeError(error, 'Could not open the folder.'), 'err');
    }
  };

  const createBundle = async (): Promise<void> => {
    if (!desktopBridge) { pushToast('Support bundles require the desktop app.', 'info'); return; }
    setBundleBusy(true);
    setBundlePath('');
    try {
      const result = await tauriDiagnostics.bundle();
      setBundlePath(result.path);
      pushToast(`Support bundle created (${result.bytes} bytes).`, 'ok');
    } catch (error) {
      pushToast(optionalInvokeError(error, 'Could not create the support bundle.'), 'err');
    } finally {
      setBundleBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <Card>
        <CardTitle>CurseForge API key</CardTitle>
        <p className="text-xs text-zinc-400">
          Optional. Keyless CurseForge routes (public API + CDN) work without a key. Adding a classic
          CurseForge API key here enables <strong>in-app modpack browsing</strong> and one-click
          server-pack installs in the Create wizard — no file editing needed. The key is stored with
          the OS keystore when available (app-data fallback otherwise) and is never displayed in full,
          bundled, or written to logs or support bundles.
        </p>
        <p className="mt-3 text-sm">
          <span className="text-zinc-300">Status: </span>
          {cfKeyStatus === null ? (
            <span className="text-zinc-500">Checking...</span>
          ) : cfKeyStatus.configured ? (
            <span className="text-emerald-300">
              {cfKeyStatus.source === 'safeStorage' ? 'Configured (OS-encrypted storage)' : 'Configured (app-data fallback)'}
            </span>
          ) : (
            <span className="text-zinc-400">No key configured.</span>
          )}
        </p>
        {cfKeyStatus?.hint && <p className="mt-1 text-xs text-zinc-500">{cfKeyStatus.hint}</p>}
        <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto_auto]">
          <input
            type="password"
            value={cfKeyDraft}
            onChange={(event) => { setCfKeyDraft(event.target.value); setCfKeyError(''); }}
            placeholder="Paste your CurseForge API key"
            className={inputCls}
            autoComplete="off"
            spellCheck={false}
            disabled={!desktopBridge || cfKeyBusy}
          />
          <Button onClick={() => void saveCurseForgeKey()} disabled={!desktopBridge || cfKeyBusy || cfKeyDraft.trim().length === 0}>
            {cfKeyBusy ? 'Saving...' : 'Save key'}
          </Button>
          <Button variant="outline" onClick={() => void clearCurseForgeKey()} disabled={!desktopBridge || cfKeyBusy || !cfKeyStatus?.configured}>
            Clear key
          </Button>
        </div>
        {!desktopBridge && <p className="mt-2 text-xs text-zinc-500">Key management requires the desktop app.</p>}
        {cfKeyError && <p role="alert" className="mt-2 text-xs text-red-300">{cfKeyError}</p>}
        <p className="mt-2 text-xs text-zinc-500">
          The full key is never displayed. Clear it here after rotating or revoking it in your CurseForge account.
        </p>
      </Card>

      <Card>
        <CardTitle>Downloads &amp; storage</CardTitle>
        <p className="text-xs text-zinc-400">
          Choose where the manager saves its downloads (installer/loader jars, Modrinth and CurseForge pack
          archives, cached Java zips). Server folders, worlds and backups stay in the app data folder.
          Changing the folder applies to <strong>future downloads</strong>; existing files are not moved.
        </p>
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-zinc-300">Download folder:</span>
            {storageInfo ? (
              <code className="break-all rounded bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-200">{storageInfo.effectiveDownloadsPath}</code>
            ) : (
              <span className="text-xs text-zinc-500">Reading…</span>
            )}
            {storageInfo?.isDefault && <Badge tone="green">app default</Badge>}
            {storageInfo && !storageInfo.isDefault && <Badge tone="blue">custom</Badge>}
          </div>
          {storageInfo?.overrideUnavailable && (
            <p role="alert" className="text-xs text-amber-300">
              The saved folder is missing or unavailable; new downloads will be written there when it is reachable.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={!desktopBridge || storageBusy} onClick={() => void chooseDownloadsFolder()}>
              {storageBusy ? 'Saving…' : 'Choose folder…'}
            </Button>
            <Button size="sm" variant="outline" disabled={!desktopBridge || storageBusy || storageInfo?.isDefault !== false} onClick={() => void resetDownloadsFolder()}>
              Reset to default
            </Button>
            <Button size="sm" variant="outline" disabled={!desktopBridge} onClick={() => void openStorageFolder('downloads')}>
              Open download folder
            </Button>
          </div>
          <p className="text-xs text-zinc-500 break-all">
            App data folder (servers, worlds, backups, database): <code>{storageInfo?.dataRoot ?? '—'}</code>{' '}
            <button
              type="button"
              className="underline decoration-dotted"
              disabled={!desktopBridge}
              onClick={() => void openStorageFolder('data')}
            >
              open
            </button>
          </p>
          {storageError && <p role="alert" className="text-xs text-red-300">{storageError}</p>}
          {!desktopBridge && <p className="text-xs text-zinc-500">Storage settings require the desktop app.</p>}
        </div>
      </Card>

      <Card>
        <CardTitle>CurseForge download retention</CardTitle>
        <div className="rounded border border-zinc-800 bg-zinc-950 p-3">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoDeleteCurseForgeZip}
              onChange={(e) => setAutoDeleteCurseForgeZip(e.target.checked)}
              className="mt-1"
            />
            <span>
              Automatically delete staged CurseForge ZIP copies after successful installation
              <span className="block text-xs text-zinc-500">
                Off by default. The original file selected from elsewhere is never deleted. Applies to new installs only.
              </span>
            </span>
          </label>
        </div>
      </Card>

      <UpdatePanel />

      <Card>
        <CardTitle>Diagnostics</CardTitle>
        <p className="text-xs text-zinc-400">
          Create a support bundle for troubleshooting: app/Electron versions, platform, server summary,
          recent launcher log, lifecycle timeline and a redacted app-data.json. Worlds, mods, backups and
          secrets (including the CurseForge key) are never included.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={!desktopBridge || bundleBusy}
            onClick={() => void createBundle()}
          >
            {bundleBusy ? 'Creating…' : 'Create support bundle'}
          </Button>
          {bundlePath && <span className="text-xs text-zinc-400 break-all">{bundlePath}</span>}
        </div>
      </Card>
    </div>
  );
}
