import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { Badge, Button, Card, CardTitle, Confirm, Field, ProgressBar, inputCls } from '../components/ui';
import { hasBackend, onJobProgress, tauriDiagnostics, tauriJava, tauriServers } from '../tauri';
import type { JavaCandidate, JavaDetection, ServerSettingsDto } from '../tauri';

const CURSEFORGE_AUTO_DELETE_KEY = 'cf-auto-delete-zip';

/** Renderer-safe CurseForge key status (never contains the key itself). */
interface CurseForgeKeyStatusDto {
  configured: boolean;
  source: 'safeStorage' | 'file' | null;
  encrypted: boolean;
  hint: string;
}

/** Rebuild the `{code,message}` IPC error message into something user-readable. */
function optionalInvokeError(error: unknown, fallback: string): string {
  const raw = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '';
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as { message?: string };
    return parsed?.message ?? raw;
  } catch {
    return raw;
  }
}

export default function Settings() {
  const { active, updateServer, reloadServers, restart, pushToast, usedPorts, setJavaPath: persistJavaPath } = useStore();
  const [name, setName] = useState(active.name);
  const [motd, setMotd] = useState(active.motd);
  const [maxP, setMaxP] = useState(active.maxPlayers);
  const [diff, setDiff] = useState(active.difficulty);
  const [gm, setGm] = useState(active.gamemode);
  const [port, setPort] = useState(active.port);
  const [ram, setRam] = useState(active.ramMb);
  const [online, setOnline] = useState(active.onlineMode);
  const [eula, setEula] = useState(active.eulaAccepted);
  const [autoDeleteCurseForgeZip, setAutoDeleteCurseForgeZip] = useState(() => {
    try {
      return window.localStorage.getItem(CURSEFORGE_AUTO_DELETE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [needsRestart, setNeedsRestart] = useState(false);
  const [bundleBusy, setBundleBusy] = useState(false);
  const [bundlePath, setBundlePath] = useState('');
  const [javaDetection, setJavaDetection] = useState<JavaDetection | null>(null);
  const [javaSelected, setJavaSelected] = useState<JavaCandidate | null>(null);
  const [javaPathDraft, setJavaPathDraft] = useState(active.javaPath ?? '');
  const [javaOverride, setJavaOverride] = useState(false);
  const [javaLoading, setJavaLoading] = useState(false);
  const [javaBusy, setJavaBusy] = useState(false);
  const [javaInstalling, setJavaInstalling] = useState(false);
  const [javaProgress, setJavaProgress] = useState(0);
  const [javaProgressLog, setJavaProgressLog] = useState('');
  const [javaError, setJavaError] = useState('');
  const [settings, setSettings] = useState<ServerSettingsDto | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [portStatus, setPortStatus] = useState<{ available: boolean; suggested: number } | null>(null);
  const desktopBridge = typeof window !== 'undefined' ? window.electronAPI : undefined;
  const [cfKeyStatus, setCfKeyStatus] = useState<CurseForgeKeyStatusDto | null>(null);
  const [cfKeyDraft, setCfKeyDraft] = useState('');
  const [cfKeyBusy, setCfKeyBusy] = useState(false);
  const [cfKeyError, setCfKeyError] = useState('');
  const activeIdRef = useRef(active.id);
  activeIdRef.current = active.id;

  // TODO(WP-7.3 wiring): the Lead registers `curseforge_key_status|set|clear` IPC handlers; the
  // direct bridge call keeps this section working as soon as they land (same pattern as Backups).
  useEffect(() => {
    if (!desktopBridge) return;
    let cancelled = false;
    void desktopBridge.invoke('curseforge_key_status')
      .then((value) => { if (!cancelled) setCfKeyStatus(value as CurseForgeKeyStatusDto); })
      .catch(() => {
        // IPC not registered yet (Lead wiring) or bridge hiccup: show an explicit unavailable state
        // instead of a permanent "Checking...".
        if (!cancelled) setCfKeyStatus({ configured: false, source: null, encrypted: false, hint: 'Key management is not available in this build yet.' });
      });
    return () => { cancelled = true; };
  }, [desktopBridge]);

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
        hint: source === 'safeStorage' ? 'Configured with OS-encrypted storage.' : 'Configured in the app data folder (curseforge-key.txt).',
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

  useEffect(() => {
    try {
      window.localStorage.setItem(CURSEFORGE_AUTO_DELETE_KEY, autoDeleteCurseForgeZip ? '1' : '0');
    } catch {
      /* preference storage unavailable */
    }
  }, [autoDeleteCurseForgeZip]);

  // Re-sync when switching servers.
  useEffect(() => {
    setName(active.name);
    setMotd(active.motd);
    setMaxP(active.maxPlayers);
    setDiff(active.difficulty);
    setGm(active.gamemode);
    setPort(active.port);
    setRam(active.ramMb);
    setOnline(active.onlineMode);
    setEula(active.eulaAccepted);
    setNeedsRestart(false);
    setJavaPathDraft(active.javaPath ?? '');
    setJavaOverride(false);
    setJavaDetection(null);
    setJavaSelected(null);
    setJavaLoading(false);
    setJavaBusy(false);
    setJavaInstalling(false);
    setJavaProgress(0);
    setJavaProgressLog('');
    setJavaError('');
    setSettings(null);
    setSettingsError('');
    setSettingsLoading(false);
  }, [active.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Read the authoritative server.properties values for this server.
  useEffect(() => {
    if (!hasBackend() || !active.id) return;
    let cancelled = false;
    setSettingsLoading(true);
    setSettingsError('');
    void tauriServers.settingsGet(active.id).then((loaded) => {
      if (cancelled) return;
      setSettings(loaded);
      const v = loaded.values;
      setName(active.name);
      if (v['motd'] !== undefined) setMotd(v['motd']);
      if (v['max-players'] !== undefined) setMaxP(Number(v['max-players']));
      if (v['difficulty']) setDiff((v['difficulty'][0]!.toUpperCase() + v['difficulty'].slice(1)) as typeof diff);
      if (v['gamemode']) setGm((v['gamemode'][0]!.toUpperCase() + v['gamemode'].slice(1)) as typeof gm);
      if (v['server-port'] !== undefined) setPort(Number(v['server-port']));
      if (v['online-mode'] !== undefined) setOnline(v['online-mode'] === 'true');
      setEula(loaded.eulaAccepted);
    }).catch((err: unknown) => {
      if (cancelled) return;
      setSettingsError(err && typeof err === 'object' && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'Could not read server.properties.');
    }).finally(() => {
      if (!cancelled) setSettingsLoading(false);
    });
    return () => { cancelled = true; };
  }, [active.id, active.name]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!hasBackend() || !active.mcVersion) return;
    let cancelled = false;
    const isCurrentServer = () => !cancelled && activeIdRef.current === active.id;
    setJavaLoading(true);
    setJavaError('');
    void tauriJava.detect(active.mcVersion).then(async (detection) => {
      if (!isCurrentServer()) return;
      setJavaDetection(detection);
      const automatic = detection.candidates[0] ?? null;
      if (active.javaPath) {
        try {
          const configured = await tauriJava.validate(active.mcVersion, active.javaPath);
          if (isCurrentServer()) setJavaSelected(configured);
        } catch (err) {
          if (isCurrentServer()) {
            const message = err && typeof err === 'object' && 'message' in err
              ? String((err as { message: unknown }).message)
              : 'The configured Java runtime is no longer valid.';
            setJavaSelected(null);
            setJavaError(message);
          }
        }
      } else {
        setJavaSelected(automatic);
        setJavaPathDraft('');
      }
    }).catch((err: unknown) => {
      if (!isCurrentServer()) return;
      const message = err && typeof err === 'object' && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'Could not inspect Java for this Minecraft version.';
      setJavaDetection(null);
      setJavaSelected(null);
      setJavaError(message);
    }).finally(() => {
      if (isCurrentServer()) setJavaLoading(false);
    });
    return () => { cancelled = true; };
  }, [active.id, active.mcVersion, active.javaPath]);

  const javaControlsDisabled = active.status === 'starting' || active.status === 'running' || active.status === 'stopping';

  const installJava = async () => {
    if (!hasBackend() || !javaDetection || javaBusy || javaControlsDisabled) return;
    const serverId = active.id;
    setJavaBusy(true);
    setJavaInstalling(true);
    setJavaProgress(0);
    setJavaProgressLog('Starting Temurin download…');
    setJavaError('');
    const jobId = `java-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await onJobProgress(jobId, (payload) => {
        if (activeIdRef.current !== serverId) return;
        setJavaProgress(payload.progress);
        setJavaProgressLog(payload.log ?? 'Installing Java…');
      });
      const candidate = await tauriJava.ensure(javaDetection.installMajor, jobId);
      const saved = await persistJavaPath(serverId, candidate.path);
      if (saved && activeIdRef.current === serverId) {
        setJavaSelected(candidate);
        setJavaPathDraft(candidate.path);
        setJavaOverride(false);
        setJavaProgress(100);
        setJavaProgressLog(`Temurin Java ${candidate.major} is ready.`);
      }
    } catch (err) {
      const message = err && typeof err === 'object' && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'Java installation failed.';
      if (activeIdRef.current === serverId) setJavaError(message);
      pushToast(message, 'err');
    } finally {
      unlisten?.();
      if (activeIdRef.current === serverId) {
        setJavaBusy(false);
        setJavaInstalling(false);
      }
    }
  };

  const validateAndSaveJavaPath = async () => {
    if (!javaPathDraft.trim()) {
      setJavaError('Enter a JDK home folder or java.exe path.');
      return;
    }
    const serverId = active.id;
    const pathDraft = javaPathDraft;
    setJavaBusy(true);
    try {
      if (hasBackend()) {
        const candidate = await tauriJava.validate(active.mcVersion, pathDraft);
        const saved = await persistJavaPath(serverId, candidate.path);
        if (saved && activeIdRef.current === serverId) {
          setJavaSelected(candidate);
          setJavaPathDraft(candidate.path);
          setJavaOverride(false);
          setJavaError('');
        }
      } else {
        const saved = await persistJavaPath(serverId, pathDraft.trim());
        if (saved && activeIdRef.current === serverId) setJavaOverride(false);
      }
    } catch (err) {
      const message = err && typeof err === 'object' && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'Java path could not be validated.';
      if (activeIdRef.current === serverId) setJavaError(message);
      pushToast(message, 'err');
    } finally {
      if (activeIdRef.current === serverId) setJavaBusy(false);
    }
  };

  const clearJavaOverride = async () => {
    const serverId = active.id;
    const saved = await persistJavaPath(serverId, null);
    if (saved && activeIdRef.current === serverId) {
      setJavaPathDraft('');
      setJavaOverride(false);
      setJavaSelected(javaDetection?.candidates[0] ?? null);
      setJavaError('');
    }
  };

  const dirty =
    name !== active.name || motd !== (settings?.values['motd'] ?? active.motd) ||
    maxP !== (settings?.values['max-players'] !== undefined ? Number(settings.values['max-players']) : active.maxPlayers) ||
    diff !== (settings?.values['difficulty'] ? settings.values['difficulty'][0]!.toUpperCase() + settings.values['difficulty'].slice(1) : active.difficulty) ||
    gm !== (settings?.values['gamemode'] ? settings.values['gamemode'][0]!.toUpperCase() + settings.values['gamemode'].slice(1) : active.gamemode) ||
    port !== (settings?.values['server-port'] !== undefined ? Number(settings.values['server-port']) : active.port) ||
    ram !== active.ramMb ||
    online !== (settings?.values['online-mode'] !== undefined ? settings.values['online-mode'] === 'true' : active.onlineMode) ||
    eula !== (settings?.eulaAccepted ?? active.eulaAccepted);

  useEffect(() => {
    if (!hasBackend() || !Number.isInteger(port) || port < 1 || port > 65535) {
      setPortStatus(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void tauriServers.portCheck(port).then((status) => {
        if (!cancelled) setPortStatus(status);
      }).catch(() => {
        if (!cancelled) setPortStatus(null);
      });
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [port]);

  const portConflict = hasBackend()
    ? port !== active.port && portStatus !== null && !portStatus.available
    : usedPorts.filter((p) => p !== active.port).includes(port);

  const save = () => {
    const values: Record<string, string> = {
      'motd': motd,
      'max-players': String(maxP),
      'difficulty': diff.toLowerCase(),
      'gamemode': gm.toLowerCase(),
      'server-port': String(port),
      'online-mode': String(online),
    };
    if (!hasBackend()) {
      updateServer(active.id, {
        name, motd, maxPlayers: maxP, difficulty: diff, gamemode: gm,
        port, ramMb: ram, onlineMode: online, eulaAccepted: eula,
        version: `${active.mcVersion} ${active.loader}`,
      });
      pushToast(eula ? 'Settings saved (mock).' : 'Settings saved — Start still blocked until EULA is accepted.', eula ? 'ok' : 'err');
      if (diff !== active.difficulty || gm !== active.gamemode || ram !== active.ramMb || port !== active.port) setNeedsRestart(true);
      return;
    }
    // Only send the persisted extras that actually changed. A boolean eulaAccepted is treated by the
    // backend as an explicit accept/revoke (it may stop the server), so an unchanged checkbox is omitted.
    const loadedEula = settings?.eulaAccepted ?? active.eulaAccepted;
    const extra: { name?: string; ramMb?: number; eulaAccepted?: boolean } = {};
    if (name.trim() !== '' && name !== active.name) extra.name = name.trim();
    if (ram !== active.ramMb) extra.ramMb = ram;
    if (eula !== loadedEula) extra.eulaAccepted = eula;
    const restartFieldsChanged =
      diff !== active.difficulty || gm !== active.gamemode || port !== active.port ||
      ram !== active.ramMb || online !== active.onlineMode || maxP !== active.maxPlayers;
    setSaving(true);
    setSettingsError('');
    void tauriServers.settingsUpdate(active.id, values, extra)
      .then(() => {
        pushToast(eula ? 'Settings saved to server.properties.' : 'Settings saved — Start is blocked until the EULA is accepted.', eula ? 'ok' : 'err');
        setNeedsRestart(restartFieldsChanged);
        setSettings((current) => (current ? { ...current, eulaAccepted: eula, values: { ...current.values, ...values } } : current));
        void reloadServers();
        void tauriServers.settingsGet(active.id).then(setSettings).catch(() => undefined);
        if (extra.eulaAccepted !== undefined && (active.status === 'running' || active.status === 'starting')) {
          pushToast('EULA changed — the server was stopped so the new consent state applies.', 'info');
        }
      })
      .catch((err: unknown) => {
        const message = err && typeof err === 'object' && 'message' in err
          ? String((err as { message: unknown }).message)
          : 'Could not save server settings.';
        setSettingsError(message);
        pushToast(message, 'err');
      })
      .finally(() => setSaving(false));
  };

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      {needsRestart && (
        <div className="rounded-md border border-amber-800 bg-amber-950/60 px-3 py-2 text-sm text-amber-200">
          Restart required to apply difficulty / gamemode / RAM / port / online-mode / max-players changes.{' '}
          <button className="underline" onClick={() => restart(active.id)}>Restart now</button>
        </div>
      )}
      <Card>
        <CardTitle>Server settings (7-field MVP subset)</CardTitle>
        {settingsLoading && <p className="text-xs text-zinc-500">Reading server.properties…</p>}
        {settingsError && <p role="alert" className="mb-2 rounded border border-red-800 bg-red-950/60 px-2 py-1 text-xs text-red-200">{settingsError}</p>}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Server name"><input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} /></Field>
          <Field label="MOTD"><input value={motd} onChange={(e) => setMotd(e.target.value)} className={inputCls} /></Field>
          <Field label="Max players"><input type="number" min={1} max={500} value={maxP} onChange={(e) => setMaxP(Number(e.target.value))} className={inputCls} /></Field>
          <Field label="Port" hint={portConflict
            ? `Port ${port} is in use — try ${portStatus?.suggested ?? port + 1}.`
            : hasBackend() ? 'Port is free on 127.0.0.1.' : 'Port looks free (mock check).'}>
            <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} className={inputCls} />
          </Field>
          <Field label="Difficulty (restart badge)">
            <select value={diff} onChange={(e) => setDiff(e.target.value as typeof diff)} className={inputCls}>
              {['Peaceful', 'Easy', 'Normal', 'Hard'].map((d) => <option key={d}>{d}</option>)}
            </select>
          </Field>
          <Field label="Gamemode (restart badge)">
            <select value={gm} onChange={(e) => setGm(e.target.value as typeof gm)} className={inputCls}>
              {['Survival', 'Creative', 'Adventure', 'Spectator'].map((g) => <option key={g}>{g}</option>)}
            </select>
          </Field>
          <div className="md:col-span-2">
            <Field label={`RAM: ${ram} MB (recommended ${active.ramRecommendedMb} MB)`}>
              <input type="range" min={1024} max={16384} step={256} value={ram} onChange={(e) => setRam(Number(e.target.value))} className="ram-slider" />
            </Field>
          </div>
          <div className="md:col-span-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)} /> online-mode (Mojang auth)
            </label>
            {!online && <p className="mt-1 text-xs text-amber-300">⚠ Cracked/offline mode: OP and whitelist entries may not resolve — players can impersonate names.</p>}
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : `Save ${dirty ? '(unsaved changes)' : ''}`}</Button>
          {dirty && <Badge tone="amber">unsaved</Badge>}
          <button className="ml-auto text-xs text-zinc-500 underline" onClick={() => {
            if (!hasBackend()) {
              pushToast('server.properties opens in your editor only in the desktop app.', 'info');
              return;
            }
            void tauriServers.openFolder(active.id, 'server.properties')
              .catch((err: unknown) => pushToast(err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : 'Could not open server.properties.', 'err'));
          }}>
            Open server.properties
          </button>
          <button className="text-xs text-zinc-500 underline" title="Advanced: open the whole server folder (worlds, logs, configs, mods)" onClick={() => {
            if (!hasBackend()) {
              pushToast('The server folder is available in the desktop app.', 'info');
              return;
            }
            void tauriServers.openFolder(active.id)
              .catch((err: unknown) => pushToast(err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : 'Could not open the server folder.', 'err'));
          }}>
            Show advanced files
          </button>
        </div>
      </Card>

      <Card>
        <CardTitle>EULA + environment</CardTitle>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={eula} onChange={(e) => setEula(e.target.checked)} className="mt-1" />
          <span>I accept the <a className="underline" href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">Minecraft EULA</a>
            <span className="block text-xs text-zinc-500">Start is blocked until this is checked and saved. Never auto-accepted; the backend reads the acceptance from <code>eula.txt</code> (a file containing <code>eula=false</code> does not count).</span>
          </span>
        </label>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="md:col-span-2 space-y-2">
            <Field
              label={javaDetection ? `Java required: ${javaDetection.requiredMajor}` : 'Java runtime'}
              hint={hasBackend() ? 'Runtime is validated against Mojang metadata and this server must be stopped before changes.' : 'Java runtime selection is mocked in browser mode.'}
            >
              {!hasBackend() ? (
                <input value={active.javaPath ? `Override · ${active.javaPath}` : 'Auto — Java (mock)'} readOnly disabled className={`${inputCls} opacity-60`} />
              ) : (
                <div className="space-y-2 rounded border border-zinc-800 bg-zinc-950 p-2.5">
                  <p className="text-sm text-zinc-200">
                    {javaLoading
                      ? 'Checking installed Java… (Java requirement unavailable until the check finishes)'
                      : javaSelected
                        ? `Java ${javaSelected.major} · ${javaSelected.architectureBits}-bit · ${javaSelected.source}${active.javaPath ? ' · selected' : ' · auto'}`
                        : javaDetection ? `No compatible Java ${javaDetection.requiredMajor}+ runtime found.` : 'Java requirement unavailable.'}
                  </p>
                  {javaSelected && <p className="break-all text-xs text-zinc-500">{javaSelected.path}</p>}
                  {javaOverride && (
                    <div className="space-y-2">
                      <input
                        value={javaPathDraft}
                        onChange={(e) => { setJavaPathDraft(e.target.value); setJavaError(''); }}
                        placeholder="JDK home folder or bin\\java.exe"
                        className={inputCls}
                      />
                      <Button size="sm" disabled={javaBusy || javaControlsDisabled} onClick={validateAndSaveJavaPath}>
                        Validate and save path
                      </Button>
                    </div>
                  )}
                  {javaError && <p role="alert" className="text-xs text-red-300">{javaError}</p>}
                  {javaInstalling && (
                    <div className="space-y-1">
                      <ProgressBar value={javaProgress} />
                      <p className="text-xs text-zinc-400">{javaProgress}% · {javaProgressLog}</p>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {!javaOverride && <Button size="sm" variant="secondary" disabled={javaControlsDisabled || javaLoading || javaBusy} onClick={() => {
                      setJavaOverride(true);
                      setJavaPathDraft(active.javaPath ?? javaSelected?.path ?? '');
                    }}>Change…</Button>}
                    {javaOverride && <Button size="sm" variant="ghost" disabled={javaControlsDisabled || javaBusy} onClick={() => {
                      setJavaOverride(false);
                      setJavaPathDraft(active.javaPath ?? '');
                      setJavaError('');
                    }}>Cancel</Button>}
                    {active.javaPath && <Button size="sm" variant="ghost" disabled={javaControlsDisabled || javaBusy} onClick={clearJavaOverride}>Use automatic detection</Button>}
                    <Button size="sm" disabled={!javaDetection || javaLoading || javaBusy || javaControlsDisabled} onClick={installJava}>
                      Install Temurin Java {javaDetection?.installMajor ?? '…'}
                    </Button>
                  </div>
                </div>
              )}
            </Field>
          </div>
          <div className="md:col-span-2 rounded border border-zinc-800 bg-zinc-950 p-3">
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
                  Off by default. The original file selected from elsewhere is never deleted.
                </span>
              </span>
            </label>
          </div>
        </div>
        <p className="mt-2 text-xs text-zinc-500">Versions are a picker in Create, not a tab.</p>
      </Card>

      <Card>
        <CardTitle>CurseForge API key</CardTitle>
        <p className="text-xs text-zinc-400">
          Optional. Keyless CurseForge routes (public API + CDN) work without a key; a key enables the
          official API for one-click server packs. The key is stored with the OS keystore when
          available, otherwise in <code>curseforge-key.txt</code> inside the app data folder. It is
          never displayed in full and never written to logs.
        </p>
        <p className="mt-3 text-sm">
          <span className="text-zinc-300">Status: </span>
          {cfKeyStatus === null ? (
            <span className="text-zinc-500">Checking...</span>
          ) : cfKeyStatus.configured ? (
            <span className="text-emerald-300">
              {cfKeyStatus.source === 'safeStorage' ? 'Configured (OS-encrypted storage)' : 'Configured (app data file)'}
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

      <Card>
        <CardTitle>Danger zone</CardTitle>
        <p className="text-xs text-zinc-400">
          Deleting the server removes its record, server folder, worlds and backups index. This cannot be undone.
          Stop the server first.
        </p>
        <div className="mt-3">
          <Button
            variant="destructive"
            disabled={active.status !== 'stopped' && active.status !== 'crashed'}
            onClick={() => setDeleteOpen(true)}
          >
            Delete server
          </Button>
        </div>
      </Card>

      <Confirm
        open={deleteOpen}
        title={`Delete "${active.name}"?`}
        message={<p>The server folder and all worlds are removed permanently. Export any world or backup first.</p>}
        confirmLabel="Delete server"
        onConfirm={() => {
          if (!hasBackend()) {
            pushToast('Deleting a server requires the desktop backend.', 'info');
            return;
          }
          void tauriServers.remove(active.id)
            .then(() => {
              pushToast(`Server "${active.name}" deleted.`, 'ok');
              void reloadServers();
            })
            .catch((err: unknown) => pushToast(err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : 'Could not delete the server.', 'err'));
        }}
        onClose={() => setDeleteOpen(false)}
      />
    </div>
  );
}
