import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { LogLine, Server } from './types';
import { initialLogs, initialServers, tickLogPool } from './mocks/data';
import { hasBackend, onServerLog, onServerStatus, tauriServer, tauriServers } from './tauri';
import type { CreateServerInput, ServerDto } from './tauri';
import { LOG_BATCH_DELAY_MS, MAX_RETAINED_LOG_LINES } from './logs';

export interface Toast {
  id: number;
  msg: string;
  kind: 'ok' | 'err' | 'info';
}

interface Store {
  servers: Server[];
  serversHydrated: boolean;
  serversLoadError: string | null;
  activeId: string;
  active: Server;
  logs: Record<string, LogLine[]>;
  cmdHistory: string[];
  toasts: Toast[];
  pushToast: (msg: string, kind?: Toast['kind']) => void;
  select: (id: string) => void;
  start: (id: string) => boolean;
  stop: (id: string) => void;
  restart: (id: string) => void;
  kill: (id: string) => void;
  sendCommand: (id: string, cmd: string) => void;
  appendLog: (id: string, level: LogLine['level'], source: string, msg: string) => void;
  clearLogs: (id: string) => void;
  updateServer: (id: string, patch: Partial<Server>) => void;
  addServer: (s: Server) => void;
  createServer: (input: CreateServerInput) => Promise<Server | null>;
  setJavaPath: (id: string, path: string | null) => Promise<boolean>;
  reloadServers: () => void;
  usedPorts: number[];
}

const Ctx = createContext<Store | null>(null);
let toastId = 1;
let cmdSeq = 100000;

const EMPTY_SERVER: Server = {
  id: '',
  name: 'No server selected',
  status: 'stopped',
  mcVersion: '',
  loader: 'Vanilla',
  playersOnline: 0,
  maxPlayers: 20,
  port: 0,
  ramMb: 0,
  ramRecommendedMb: 4096,
  uptimeSec: 0,
  cpuPct: 0,
  ramPct: 0,
  tps: null,
  mspt: null,
  address: '127.0.0.1',
  eulaAccepted: false,
  motd: '',
  difficulty: 'Normal',
  gamemode: 'Survival',
  onlineMode: true,
  seed: '',
  worldName: 'world',
  worldSizeMb: 0,
  worldLastPlayed: '—',
  version: '',
};

function serverFromDto(dto: ServerDto): Server {
  let status: Server['status'];
  switch (dto.status) {
    case 'starting':
    case 'running':
    case 'stopping':
    case 'crashed':
    case 'stopped':
      status = dto.status;
      break;
    default:
      status = 'stopped';
  }
  return {
    ...EMPTY_SERVER,
    id: dto.id,
    name: dto.name,
    status,
    mcVersion: dto.mcVersion,
    javaPath: dto.javaPath ?? undefined,
    loader: dto.loader,
    loaderVersion: dto.loaderVersion ?? undefined,
    modpack: dto.modpackId ?? undefined,
    port: dto.port,
    ramMb: dto.ramMb,
    ramRecommendedMb: dto.modpackId ? 8192 : 4096,
    eulaAccepted: dto.eulaAccepted,
    version: `${dto.mcVersion} ${dto.loader}`,
  };
}

function stamp(): string {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

// backend-wired: extract the toastable message from a backend AppError
// ({code, message}) rejection on the Tauri path.
function backendMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  return 'Backend request failed.';
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [servers, setServers] = useState<Server[]>(() => (hasBackend() ? [] : initialServers));
  const [serversHydrated, setServersHydrated] = useState(() => !hasBackend());
  const [serversLoadError, setServersLoadError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState(() => (hasBackend() ? '' : initialServers[0]?.id ?? ''));
  const [logs, setLogs] = useState<Record<string, LogLine[]>>(() => {
    const initial = hasBackend() ? {} : initialLogs;
    return Object.fromEntries(
      Object.entries(initial).map(([id, lines]) => [id, lines.slice(-MAX_RETAINED_LOG_LINES)]),
    );
  });
  const [cmdHistory, setCmdHistory] = useState<string[]>(['say Hello!', 'save-all', 'time set day']);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const serversListRequest = useRef(0);
  const pendingLogs = useRef<Record<string, LogLine[]>>({});
  const logFlushTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (logFlushTimer.current !== null) {
      window.clearTimeout(logFlushTimer.current);
      logFlushTimer.current = null;
    }
    pendingLogs.current = {};
  }, []);

  const pushToast = useCallback((msg: string, kind: Toast['kind'] = 'info') => {
    const id = toastId++;
    setToasts((t) => [...t, { id, msg, kind }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);

  const flushLogs = useCallback(() => {
    if (logFlushTimer.current !== null) {
      window.clearTimeout(logFlushTimer.current);
      logFlushTimer.current = null;
    }
    const batch = pendingLogs.current;
    pendingLogs.current = {};
    const entries = Object.entries(batch);
    if (entries.length === 0) return;

    setLogs((prev) => {
      const next = { ...prev };
      entries.forEach(([id, lines]) => {
        next[id] = [...(prev[id] ?? []), ...lines].slice(-MAX_RETAINED_LOG_LINES);
      });
      return next;
    });
  }, []);

  const appendLog = useCallback((id: string, level: LogLine['level'], source: string, msg: string) => {
    const line: LogLine = { id: cmdSeq++, ts: stamp(), level, source, msg };
    const queued = pendingLogs.current[id] ?? (pendingLogs.current[id] = []);
    queued.push(line);
    if (logFlushTimer.current === null) {
      logFlushTimer.current = window.setTimeout(flushLogs, LOG_BATCH_DELAY_MS);
    }
  }, [flushLogs]);

  const updateServer = useCallback((id: string, patch: Partial<Server>) => {
    setServers((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  const select = useCallback((id: string) => setActiveId(id), []);

  const start = useCallback(
    (id: string): boolean => {
      const s = servers.find((x) => x.id === id);
      if (!s) return false;
      // EULA gate — never auto-accept (spec).
      if (!s.eulaAccepted) {
        pushToast('Blocked: accept the Minecraft EULA first (Create → Configure, or Settings).', 'err');
        return false;
      }
      if (s.status === 'running' || s.status === 'starting') return true;
      // backend-wired: under Tauri the real process manager runs and
      // completion (running/crashed) arrives via server://status events.
      if (hasBackend()) {
        updateServer(id, { status: 'starting' });
        appendLog(id, 'INFO', 'Launcher', `Starting "${s.name}" (java auto, ${s.ramMb} MB, :${s.port})…`);
        tauriServer.start(id).catch((err: unknown) => {
          updateServer(id, { status: 'stopped' });
          pushToast(backendMessage(err), 'err');
        });
        return true;
      }
      updateServer(id, { status: 'starting' });
      appendLog(id, 'INFO', 'Launcher', `Starting "${s.name}" (java auto, ${s.ramMb} MB, :${s.port})…`);
      void tauriServer.start(id);
      window.setTimeout(() => {
        updateServer(id, { status: 'running', uptimeSec: 1, tps: 20.0, mspt: 10.2 });
        appendLog(id, 'INFO', 'Server', 'Done! For help, type "help"');
      }, 1600);
      return true;
    },
    [servers, updateServer, appendLog, pushToast],
  );

  const stop = useCallback(
    (id: string) => {
      // backend-wired: graceful stdin `stop` in Rust; `stopped` via status event.
      if (hasBackend()) {
        updateServer(id, { status: 'stopping' });
        appendLog(id, 'INFO', 'Server', 'Stopping server...');
        tauriServer.stop(id).catch((err: unknown) => {
          updateServer(id, { status: 'stopped' });
          pushToast(backendMessage(err), 'err');
        });
        return;
      }
      updateServer(id, { status: 'stopping' });
      appendLog(id, 'INFO', 'Server', 'Stopping server...');
      void tauriServer.stop(id);
      window.setTimeout(() => {
        updateServer(id, { status: 'stopped', uptimeSec: 0, cpuPct: 0, ramPct: 0, playersOnline: 0 });
        appendLog(id, 'INFO', 'Server', 'Server stopped.');
      }, 900);
    },
    [updateServer, appendLog, pushToast],
  );

  const restart = useCallback(
    (id: string) => {
      // backend-wired: stop+start sequencing in Rust; events drive the UI.
      if (hasBackend()) {
        const s = servers.find((x) => x.id === id);
        if (!s) return;
        // EULA gate — never auto-accept (spec).
        if (!s.eulaAccepted) {
          pushToast('Blocked: accept the Minecraft EULA first (Create → Configure, or Settings).', 'err');
          return;
        }
        appendLog(id, 'INFO', 'Launcher', `Restarting "${s.name}"…`);
        tauriServer.restart(id).catch((err: unknown) => {
          pushToast(backendMessage(err), 'err');
        });
        return;
      }
      stop(id);
      window.setTimeout(() => start(id), 1200);
    },
    [servers, stop, start, appendLog, pushToast],
  );

  const kill = useCallback(
    (id: string) => {
      // backend-wired: immediate terminate in Rust; log + `stopped` via events.
      if (hasBackend()) {
        tauriServer.kill(id).catch((err: unknown) => {
          pushToast(backendMessage(err), 'err');
        });
        return;
      }
      void tauriServer.kill(id);
      updateServer(id, { status: 'stopped', uptimeSec: 0, cpuPct: 0, ramPct: 0, playersOnline: 0, tps: null, mspt: null });
      appendLog(id, 'WARN', 'Launcher', 'Process force-killed by user.');
      pushToast('Server process killed.', 'info');
    },
    [updateServer, appendLog, pushToast],
  );

  const sendCommand = useCallback(
    (id: string, cmd: string) => {
      const c = cmd.trim();
      if (!c) return;
      appendLog(id, 'CMD', 'Console', `> ${c}`);
      setCmdHistory((h) => [...h.slice(-49), c]);
      // backend-wired: stdin write in Rust (fails toastably when stopped);
      // no fake replies on the Tauri path — real output streams back via logs.
      if (hasBackend()) {
        tauriServer.sendCommand(id, c).catch((err: unknown) => {
          pushToast(backendMessage(err), 'err');
        });
        return;
      }
      void tauriServer.sendCommand(id, c);
      window.setTimeout(() => {
        if (c.startsWith('say ')) appendLog(id, 'INFO', 'Chat', `[Server] ${c.slice(4)}`);
        else if (c === 'save-all') appendLog(id, 'INFO', 'Server', 'Saved the game');
        else if (c === 'list') appendLog(id, 'INFO', 'Server', 'There are 3 of max 20 players online: Steve, Alex, Notch_2');
        else appendLog(id, 'INFO', 'Server', `Executed "${c}" (mock response)`);
      }, 350);
    },
    [appendLog, pushToast],
  );

  const clearLogs = useCallback((id: string) => {
    delete pendingLogs.current[id];
    if (Object.keys(pendingLogs.current).length === 0 && logFlushTimer.current !== null) {
      window.clearTimeout(logFlushTimer.current);
      logFlushTimer.current = null;
    }
    setLogs((prev) => ({ ...prev, [id]: [] }));
  }, []);

  const addServer = useCallback(
    (s: Server) => {
      setServers((prev) => [...prev, s]);
      setLogs((prev) => ({ ...prev, [s.id]: [] }));
      setActiveId(s.id);
    },
    [],
  );

  const createServer = useCallback(
    async (input: CreateServerInput): Promise<Server | null> => {
      if (!hasBackend()) return null;
      try {
        const dto = await tauriServers.create(input);
        const server = serverFromDto(dto);
        addServer(server);
        pushToast('Server record created.', 'ok');
        return server;
      } catch (err) {
        pushToast(backendMessage(err), 'err');
        return null;
      }
    },
    [addServer, pushToast],
  );

  const setJavaPath = useCallback(
    async (id: string, path: string | null): Promise<boolean> => {
      if (!hasBackend()) {
        updateServer(id, { javaPath: path ?? undefined });
        pushToast(path ? 'Java runtime saved (mock).' : 'Java override cleared (mock).', 'ok');
        return true;
      }
      try {
        const dto = await tauriServers.setJavaPath(id, path);
        updateServer(id, { javaPath: dto.javaPath ?? undefined });
        pushToast(path ? 'Java runtime saved.' : 'Java override cleared; automatic detection will be used.', 'ok');
        return true;
      } catch (err) {
        pushToast(backendMessage(err), 'err');
        return false;
      }
    },
    [updateServer, pushToast],
  );

  const reloadServers = useCallback(() => {
    if (!hasBackend()) return;
    const requestId = ++serversListRequest.current;
    setServersHydrated(false);
    setServersLoadError(null);
    void tauriServers.list().then((records) => {
      if (requestId !== serversListRequest.current) return;
      const loaded = records.map(serverFromDto);
      setServers((current) => {
        const merged = new Map<string, Server>();
        loaded.forEach((server) => merged.set(server.id, server));
        current.forEach((server) => {
          if (!merged.has(server.id)) merged.set(server.id, server);
        });
        return [...merged.values()];
      });
      setLogs((current) => {
        const next = { ...current };
        loaded.forEach((server) => {
          next[server.id] ??= [];
        });
        return next;
      });
      setActiveId((current) => current || loaded[0]?.id || '');
      setServersLoadError(null);
      setServersHydrated(true);
    }).catch((err: unknown) => {
      if (requestId !== serversListRequest.current) return;
      const message = backendMessage(err);
      setServersLoadError(message);
      pushToast(message, 'err');
    });
  }, [pushToast]);

  // Tauri server identity is owned by SQLite. Browser mode keeps its local mocks.
  useEffect(() => {
    if (!hasBackend()) return;
    reloadServers();
    return () => {
      serversListRequest.current += 1;
    };
  }, [reloadServers]);

  // Live tick: while the active server runs, append ambient log lines + jitter stats.
  const serversRef = useRef(servers);
  serversRef.current = servers;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  // backend-wired: re-subscribe to real log/status events when the server set changes.
  const serverIds = useMemo(() => servers.map((s) => s.id).join(','), [servers]);
  useEffect(() => {
    if (!hasBackend()) return;
    let cancelled = false;
    const cleanups: Array<() => void> = [];
    const ids = serverIds.split(',').filter((x) => x.length > 0);
    ids.forEach((sid) => {
      void onServerLog(sid, (line) => {
        const level: LogLine['level'] = /error/i.test(line) ? 'ERROR' : /warn/i.test(line) ? 'WARN' : 'INFO';
        appendLog(sid, level, 'Server', line);
      }).then((off) => {
        if (cancelled) off();
        else cleanups.push(off);
      });
      void onServerStatus(sid, (payload) => {
        const status = payload.status;
        if (status !== 'running' && status !== 'stopped' && status !== 'starting' && status !== 'stopping' && status !== 'crashed') return;
        if (status === 'crashed') {
          const cur = serversRef.current.find((s) => s.id === sid);
          pushToast(`Server "${cur?.name ?? sid}" crashed. Check the Console for details.`, 'err');
          appendLog(sid, 'ERROR', 'Launcher', 'Server process exited unexpectedly (crash).');
          updateServer(sid, { status, uptimeSec: 0, cpuPct: 0, ramPct: 0, playersOnline: 0, tps: null, mspt: null });
        } else if (status === 'stopped') {
          updateServer(sid, { status, uptimeSec: 0, cpuPct: 0, ramPct: 0, playersOnline: 0 });
        } else if (status === 'running') {
          updateServer(sid, { status, uptimeSec: 1 });
        } else {
          updateServer(sid, { status });
        }
      }).then((off) => {
        if (cancelled) off();
        else cleanups.push(off);
      });
    });
    return () => {
      cancelled = true;
      cleanups.forEach((off) => off());
    };
  }, [serverIds, appendLog, updateServer, pushToast]);
  useEffect(() => {
    // backend-wired: under Tauri, real log/status events replace the ambient mocks.
    if (hasBackend()) return;
    const t = window.setInterval(() => {
      const cur = serversRef.current.find((s) => s.id === activeIdRef.current);
      if (!cur || cur.status !== 'running') return;
      const pick = tickLogPool[Math.floor(Math.random() * tickLogPool.length)];
      appendLog(cur.id, pick.level, pick.source, pick.msg);
      setServers((prev) =>
        prev.map((s) =>
          s.id === cur.id
            ? {
                ...s,
                uptimeSec: s.uptimeSec + 3,
                cpuPct: Math.max(2, Math.min(95, Math.round(s.cpuPct + (Math.random() * 10 - 5)))),
                ramPct: Math.max(10, Math.min(97, Math.round(s.ramPct + (Math.random() * 6 - 3)))),
              }
            : s,
        ),
      );
    }, 6000);
    return () => window.clearInterval(t);
  }, [appendLog]);

  const value = useMemo<Store>(() => {
    const active = servers.find((s) => s.id === activeId) ?? servers[0] ?? EMPTY_SERVER;
    return {
      servers,
      serversHydrated,
      serversLoadError,
      activeId,
      active,
      logs,
      cmdHistory,
      toasts,
      pushToast,
      select,
      start,
      stop,
      restart,
      kill,
      sendCommand,
      appendLog,
      clearLogs,
      updateServer,
      addServer,
      createServer,
      setJavaPath,
      reloadServers,
      usedPorts: servers.map((s) => s.port),
    };
  }, [servers, serversHydrated, serversLoadError, activeId, logs, cmdHistory, toasts, pushToast, select, start, stop, restart, kill, sendCommand, appendLog, clearLogs, updateServer, addServer, createServer, setJavaPath, reloadServers]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStore outside provider');
  return v;
}

export function formatUptime(sec: number): string {
  if (sec <= 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
