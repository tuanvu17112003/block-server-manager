import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { Badge, Button, Card, CardTitle, Field, ProgressBar, inputCls } from '../components/ui';
import { hasBackend, onJobProgress, tauriJava } from '../tauri';
import type { JavaCandidate, JavaDetection } from '../tauri';

const CURSEFORGE_AUTO_DELETE_KEY = 'cf-auto-delete-zip';

export default function Settings() {
  const { active, updateServer, restart, pushToast, usedPorts, setJavaPath: persistJavaPath } = useStore();
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
  const activeIdRef = useRef(active.id);
  activeIdRef.current = active.id;

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
  }, [active.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
    name !== active.name || motd !== active.motd || maxP !== active.maxPlayers ||
    diff !== active.difficulty || gm !== active.gamemode || port !== active.port ||
    ram !== active.ramMb || online !== active.onlineMode || eula !== active.eulaAccepted;

  const portConflict = usedPorts.filter((p) => p !== active.port).includes(port);

  const save = () => {
    updateServer(active.id, {
      name, motd, maxPlayers: maxP, difficulty: diff, gamemode: gm,
      port, ramMb: ram, onlineMode: online, eulaAccepted: eula,
      version: `${active.mcVersion} ${active.loader}`,
    });
    pushToast(eula ? 'Settings saved (mock).' : 'Settings saved — Start still blocked until EULA is accepted.', eula ? 'ok' : 'err');
    if (diff !== active.difficulty || gm !== active.gamemode || ram !== active.ramMb || port !== active.port) setNeedsRestart(true);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      {needsRestart && (
        <div className="rounded-md border border-amber-800 bg-amber-950/60 px-3 py-2 text-sm text-amber-200">
          Restart required to apply difficulty / gamemode / RAM / port changes.{' '}
          <button className="underline" onClick={() => restart(active.id)}>Restart now</button>
        </div>
      )}
      <Card>
        <CardTitle>Server settings (7-field MVP subset)</CardTitle>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Server name"><input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} /></Field>
          <Field label="MOTD"><input value={motd} onChange={(e) => setMotd(e.target.value)} className={inputCls} /></Field>
          <Field label="Max players"><input type="number" min={1} max={500} value={maxP} onChange={(e) => setMaxP(Number(e.target.value))} className={inputCls} /></Field>
          <Field label="Port" hint={portConflict ? 'Conflict with another server (mock check).' : 'Port looks free (mock check).'}>
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
          <Button onClick={save} disabled={!dirty}>Save {dirty ? '(unsaved changes)' : ''}</Button>
          {dirty && <Badge tone="amber">unsaved</Badge>}
          <button className="ml-auto text-xs text-zinc-500 underline" onClick={() => pushToast('Advanced server.properties editor deferred (mock link).', 'info')}>
            Show advanced files (deferred)
          </button>
        </div>
      </Card>

      <Card>
        <CardTitle>EULA + environment</CardTitle>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={eula} onChange={(e) => setEula(e.target.checked)} className="mt-1" />
          <span>I accept the <a className="underline" href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">Minecraft EULA</a>
            <span className="block text-xs text-zinc-500">Start is blocked until this is checked and saved. Never auto-accepted.</span>
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
                    {javaLoading ? 'Checking installed Java…' : javaSelected
                      ? `Java ${javaSelected.major} · ${javaSelected.source}${active.javaPath ? ' · selected' : ' · auto'}`
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
        <p className="mt-2 text-xs text-zinc-500">Versions are a picker in Create, not a tab. Plugins/mods browser deferred.</p>
      </Card>
    </div>
  );
}
