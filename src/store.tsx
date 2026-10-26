import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { LogLine, Server } from './types';
import { initialLogs, initialServers, tickLogPool } from './mocks/data';
import {
  backendUnavailableReason,
  createLatestRequest,
  formatErrorText,
  hasBackend,
  isInformativeErrorCode,
  normalizeError,
  onServerLog,
  onServerMetrics,
  onServerReadiness,
  onServerStatus,
  tauriServer,
  tauriServers,
} from './tauri';
import type { CreateServerInput, NormalizedError, ServerDto, ServerReadinessPayload } from './tauri';
import { LOG_BATCH_DELAY_MS, MAX_RETAINED_LOG_LINES } from './logs';

export interface Toast {
  id: number;
  msg: string;
  kind: 'ok' | 'err' | 'info';
  /** Backend AppError code when the toast came from a failed request (F-19). */
  code?: string;
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
  /** Last readiness payload per server (boot phases, auto-fix retries, ready/failed). */
  readiness: Record<string, ServerReadinessPayload>;
  /** Readiness payload for the active server, or null when it never started in this session. */
  startingPhase: ServerReadinessPayload | null;
  /** True while a start/stop/restart/kill request or a starting/stopping transition is in flight. */
  busy: Record<string, boolean>;
  isBusy: (id: string) => boolean;
  /** Non-null when Electron is running without its preload bridge; the app must fail closed. */
  backendUnavailableReason: string | null;
  pushToast: (msg: string, kind?: Toast['kind'], code?: string) => void;
  /** Formats a backend `{code,message}` rejection into one error toast and returns the normalized error. */
  errorToast: (error: unknown, fallback?: string) => NormalizedError;
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
  saveServerSettings: (
    id: string,
    values: Record<string, string>,
    extra?: { name?: string; ramMb?: number; eulaAccepted?: boolean },
  ) => Promise<NormalizedError | null>;
  deleteServer: (id: string) => Promise<boolean>;
  /** Silent server-list refresh: never clears serversHydrated, never flashes the shell (F-06). */
  refreshServers: () => Promise<void>;
  /** Initial load / explicit retry: shows the loading state and error screen on failure. */
  retryServers: () => Promise<void>;
  /** Compatibility alias for existing callers: silent refresh (tabs should migrate to refreshServers). */
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
    motd: dto.motd ?? '',
    maxPlayers: dto.maxPlayers ?? 20,
    difficulty: (dto.difficulty as Server['difficulty']) ?? 'Normal',
    gamemode: (dto.gamemode as Server['gamemode']) ?? 'Survival',
    onlineMode: dto.onlineMode ?? true,
    worldName: dto.worldName ?? 'world',
    version: `${dto.mcVersion} ${dto.loader}`,
  };
}

/**
 * Apply a fresh persisted DTO over the in-memory row without losing runtime-only samples that are
 * not part of ServerDto (uptime, CPU/RAM, TPS, world stats). This is what lets mutations and silent
 * refreshes patch state in place instead of replacing rows with defaults.
 */
function mergeServer(existing: Server | undefined, mapped: Server): Server {
  if (existing === undefined) return mapped;
  return {
    ...mapped,
    uptimeSec: existing.uptimeSec,
    cpuPct: existing.cpuPct,
    ramPct: existing.ramPct,
    memoryMb: existing.memoryMb,
    playersOnline: existing.playersOnline,
    tps: existing.tps,
    mspt: existing.mspt,
    seed: existing.seed,
    worldSizeMb: existing.worldSizeMb,
    worldLastPlayed: existing.worldLastPlayed,
    address: existing.address,
  };
}

function stamp(): string {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

/** Keep the selected id valid after a server set change; fall back to the first server (F-08). */
function reconcileActiveId(current: string, servers: Server[]): string {
  if (current !== '' && servers.some((server) => server.id === current)) return current;
  return servers[0]?.id ?? '';
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const bridgeUnavailable = backendUnavailableReason();
  // Browser mock mode is only valid in a real browser preview. Inside Electron without a preload
  // bridge the app must fail closed (App shows the bridge error) instead of showing fake servers.
  const mockMode = !hasBackend() && bridgeUnavailable === null;
  const [servers, setServers] = useState<Server[]>(() => (mockMode ? initialServers : []));
  const [serversHydrated, setServersHydrated] = useState(() => mockMode);
  const [serversLoadError, setServersLoadError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState(() => (mockMode ? initialServers[0]?.id ?? '' : ''));
  const [logs, setLogs] = useState<Record<string, LogLine[]>>(() => {
    const initial = mockMode ? initialLogs : {};
    return Object.fromEntries(
      Object.entries(initial).map(([id, lines]) => [id, lines.slice(-MAX_RETAINED_LOG_LINES)]),
    );
  });
  const [cmdHistory, setCmdHistory] = useState<string[]>(['say Hello!', 'save-all', 'time set day']);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [readiness, setReadiness] = useState<Record<string, ServerReadinessPayload>>({});
  const [pendingActions, setPendingActions] = useState<Record<string, boolean>>({});
  const serversListRequest = useRef(0);
  const pendingLogs = useRef<Record<string, LogLine[]>>({});
  const logFlushTimer = useRef<number | null>(null);
  const pendingRef = useRef<Record<string, boolean>>({});
  const failureNotified = useRef<Record<string, { at: number; message: string }>>({});

  // Refs mirror render state for callbacks/effects that must read the latest rows without
  // re-subscribing (event handlers, async mutations, request guards).
  const serversRef = useRef(servers);
  serversRef.current = servers;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const hydratedRef = useRef(serversHydrated);
  hydratedRef.current = serversHydrated;

  useEffect(() => () => {
    if (logFlushTimer.current !== null) {
      window.clearTimeout(logFlushTimer.current);
      logFlushTimer.current = null;
    }
    pendingLogs.current = {};
  }, []);

  const addToast = useCallback((msg: string, kind: Toast['kind'], code?: string) => {
    const id = toastId++;
    setToasts((current) => [...current, { id, msg, kind, code }]);
    window.setTimeout(() => setToasts((current) => current.filter((entry) => entry.id !== id)), 3800);
  }, []);

  const pushToast = useCallback((msg: string, kind: Toast['kind'] = 'info', code?: string) => {
    const display = code !== undefined && isInformativeErrorCode(code) ? `[${code}] ${msg}` : msg;
    addToast(display, kind, code);
  }, [addToast]);

  // Single shared backend-error helper (F-19): keeps the AppError code and shows `[code] message`
  // only for actionable (non-generic) codes.
  const errorToast = useCallback((error: unknown, fallback?: string): NormalizedError => {
    const normalized = normalizeError(error, fallback);
    addToast(normalized.display, 'err', normalized.code);
    return normalized;
  }, [addToast]);

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
    setServers((prev) => prev.map((server) => (server.id === id ? { ...server, ...patch } : server)));
  }, []);

  const markPending = useCallback((id: string, pending: boolean) => {
    if (pending) {
      if (pendingRef.current[id]) return;
      pendingRef.current[id] = true;
      setPendingActions((prev) => ({ ...prev, [id]: true }));
      return;
    }
    if (!pendingRef.current[id]) return;
    delete pendingRef.current[id];
    setPendingActions((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const select = useCallback((id: string) => setActiveId(id), []);

  /** Upsert one server row from a completed mutation, patching state in place (no reload flash). */
  const applyServerDto = useCallback((dto: ServerDto) => {
    const mapped = serverFromDto(dto);
    setServers((prev) => {
      const exists = prev.some((server) => server.id === dto.id);
      if (!exists) return [...prev, mapped];
      return prev.map((server) => (server.id === dto.id ? mergeServer(server, mapped) : server));
    });
    setActiveId((current) => (current === '' ? dto.id : current));
  }, []);

  /** Replace the list from the backend while keeping live runtime samples and reconciling activeId. */
  const applyServerRecords = useCallback((records: ServerDto[]) => {
    const loaded = records.map(serverFromDto);
    setServers((prev) => {
      const byId = new Map(prev.map((server) => [server.id, server]));
      return loaded.map((mapped) => mergeServer(byId.get(mapped.id), mapped));
    });
    setLogs((current) => {
      const next = { ...current };
      loaded.forEach((server) => {
        next[server.id] ??= [];
      });
      return next;
    });
    setActiveId((current) => reconcileActiveId(current, loaded));
    const ids = new Set(loaded.map((server) => server.id));
    setReadiness((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of Object.keys(next)) {
        if (!ids.has(id)) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setPendingActions((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of Object.keys(next)) {
        if (!ids.has(id)) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    for (const id of Object.keys(pendingRef.current)) {
      if (!ids.has(id)) delete pendingRef.current[id];
    }
    for (const id of Object.keys(failureNotified.current)) {
      if (!ids.has(id)) delete failureNotified.current[id];
    }
  }, []);

  const fetchServers = useCallback(async (mode: 'initial' | 'refresh'): Promise<void> => {
    if (!hasBackend()) return;
    const requestId = ++serversListRequest.current;
    const initial = mode === 'initial' || !hydratedRef.current;
    if (initial) {
      setServersHydrated(false);
      setServersLoadError(null);
    }
    try {
      const records = await tauriServers.list();
      if (requestId !== serversListRequest.current) return;
      applyServerRecords(records);
      setServersLoadError(null);
      setServersHydrated(true);
    } catch (error) {
      if (requestId !== serversListRequest.current) return;
      const normalized = normalizeError(error, 'Could not load saved servers.');
      if (initial) {
        setServersLoadError(normalized.message);
        setServersHydrated(false);
      }
      addToast(normalized.display, 'err', normalized.code);
    }
  }, [addToast, applyServerRecords]);

  const refreshServers = useCallback(() => fetchServers('refresh'), [fetchServers]);
  const retryServers = useCallback(() => fetchServers('initial'), [fetchServers]);
  // Kept for existing tab callers: previously cleared serversHydrated (whole-shell flash, F-06);
  // it is now a silent refresh. New callers should use refreshServers/retryServers explicitly.
  const reloadServers = useCallback(() => {
    void fetchServers('refresh');
  }, [fetchServers]);

  const isBusy = useCallback((id: string): boolean => {
    if (pendingRef.current[id]) return true;
    const status = serversRef.current.find((server) => server.id === id)?.status;
    return status === 'starting' || status === 'stopping';
  }, []);

  const hasRecentFailure = useCallback((id: string): boolean => {
    const last = failureNotified.current[id];
    return last !== undefined && Date.now() - last.at < 5000;
  }, []);

  const reportServerFailure = useCallback((id: string, message: string, code?: string) => {
    const text = message.trim() === '' ? 'Server failed to start.' : message.trim();
    const previous = failureNotified.current[id];
    if (previous !== undefined && Date.now() - previous.at < 5000
      && (previous.message === text || previous.message.includes(text) || text.includes(previous.message))) return;
    failureNotified.current[id] = { at: Date.now(), message: text };
    appendLog(id, 'ERROR', 'Launcher', text);
    const name = serversRef.current.find((server) => server.id === id)?.name ?? id;
    pushToast(`Server "${name}" could not start: ${text}`, 'err', code ?? 'start-failed');
  }, [appendLog, pushToast]);

  const start = useCallback(
    (id: string): boolean => {
      const server = serversRef.current.find((candidate) => candidate.id === id);
      if (!server) return false;
      // EULA gate — never auto-accept (spec).
      if (!server.eulaAccepted) {
        pushToast('Blocked: accept the Minecraft EULA first (Create → Configure, or Settings).', 'err');
        return false;
      }
      if (server.status === 'running' || server.status === 'starting') return true;
      // backend-wired: fast-ack start; running/crashed arrives via server://status + readiness events.
      if (hasBackend()) {
        markPending(id, true);
        updateServer(id, { status: 'starting' });
        appendLog(id, 'INFO', 'Launcher', `Starting "${server.name}" (java auto, ${server.ramMb} MB, :${server.port})…`);
        tauriServer.start(id).catch((error: unknown) => {
          const current = serversRef.current.find((candidate) => candidate.id === id)?.status;
          if (current !== 'crashed') updateServer(id, { status: 'stopped' });
          if (!hasRecentFailure(id)) {
            const normalized = normalizeError(error, 'Server failed to start.');
            reportServerFailure(id, normalized.message, normalized.code);
          }
        }).finally(() => markPending(id, false));
        return true;
      }
      updateServer(id, { status: 'starting' });
      appendLog(id, 'INFO', 'Launcher', `Starting "${server.name}" (java auto, ${server.ramMb} MB, :${server.port})…`);
      void tauriServer.start(id);
      window.setTimeout(() => {
        updateServer(id, { status: 'running', uptimeSec: 1, tps: 20.0, mspt: 10.2 });
        appendLog(id, 'INFO', 'Server', 'Done! For help, type "help"');
      }, 1600);
      return true;
    },
    [appendLog, hasRecentFailure, markPending, pushToast, reportServerFailure, updateServer],
  );

  const stop = useCallback(
    (id: string) => {
      // backend-wired: graceful stdin `stop`; `stopped` via status event.
      if (hasBackend()) {
        markPending(id, true);
        updateServer(id, { status: 'stopping' });
        appendLog(id, 'INFO', 'Server', 'Stopping server...');
        tauriServer.stop(id).catch((error: unknown) => {
          errorToast(error, 'Could not stop the server.');
        }).finally(() => markPending(id, false));
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
    [appendLog, errorToast, markPending, updateServer],
  );

  const restart = useCallback(
    (id: string) => {
      // backend-wired: restart is fast-ack; events drive the UI.
      if (hasBackend()) {
        const server = serversRef.current.find((candidate) => candidate.id === id);
        if (!server) return;
        // EULA gate — never auto-accept (spec).
        if (!server.eulaAccepted) {
          pushToast('Blocked: accept the Minecraft EULA first (Create → Configure, or Settings).', 'err');
          return;
        }
        markPending(id, true);
        appendLog(id, 'INFO', 'Launcher', `Restarting "${server.name}"…`);
        tauriServer.restart(id).catch((error: unknown) => {
          errorToast(error, 'Could not restart the server.');
        }).finally(() => markPending(id, false));
        return;
      }
      stop(id);
      window.setTimeout(() => start(id), 1200);
    },
    [appendLog, errorToast, markPending, pushToast, start, stop],
  );

  const kill = useCallback(
    (id: string) => {
      // backend-wired: immediate terminate; `stopped` via events.
      if (hasBackend()) {
        markPending(id, true);
        tauriServer.kill(id).catch((error: unknown) => {
          errorToast(error, 'Could not kill the server process.');
        }).finally(() => markPending(id, false));
        return;
      }
      void tauriServer.kill(id);
      updateServer(id, { status: 'stopped', uptimeSec: 0, cpuPct: 0, ramPct: 0, playersOnline: 0, tps: null, mspt: null });
      appendLog(id, 'WARN', 'Launcher', 'Process force-killed by user.');
      pushToast('Server process killed.', 'info');
    },
    [appendLog, errorToast, markPending, pushToast, updateServer],
  );

  const sendCommand = useCallback(
    (id: string, cmd: string) => {
      const command = cmd.trim();
      if (!command) return;
      appendLog(id, 'CMD', 'Console', `> ${command}`);
      setCmdHistory((history) => [...history.slice(-49), command]);
      // backend-wired: stdin write; no fake replies — real output streams back via logs.
      if (hasBackend()) {
        tauriServer.sendCommand(id, command).catch((error: unknown) => {
          errorToast(error, 'Command was not sent.');
        });
        return;
      }
      void tauriServer.sendCommand(id, command);
      window.setTimeout(() => {
        if (command.startsWith('say ')) appendLog(id, 'INFO', 'Chat', `[Server] ${command.slice(4)}`);
        else if (command === 'save-all') appendLog(id, 'INFO', 'Server', 'Saved the game');
        else if (command === 'list') appendLog(id, 'INFO', 'Server', 'There are 3 of max 20 players online: Steve, Alex, Notch_2');
        else appendLog(id, 'INFO', 'Server', `Executed "${command}" (mock response)`);
      }, 350);
    },
    [appendLog, errorToast],
  );

  const clearLogs = useCallback((id: string) => {
    delete pendingLogs.current[id];
    if (Object.keys(pendingLogs.current).length === 0 && logFlushTimer.current !== null) {
      window.clearTimeout(logFlushTimer.current);
      logFlushTimer.current = null;
    }
    setLogs((prev) => ({ ...prev, [id]: [] }));
  }, []);

  const addServer = useCallback((server: Server) => {
    setServers((prev) => [...prev, server]);
    setLogs((prev) => ({ ...prev, [server.id]: [] }));
    setActiveId(server.id);
  }, []);

  const createServer = useCallback(
    async (input: CreateServerInput): Promise<Server | null> => {
      if (!hasBackend()) return null;
      try {
        const dto = await tauriServers.create(input);
        const server = serverFromDto(dto);
        addServer(server);
        pushToast('Server record created.', 'ok');
        return server;
      } catch (error) {
        errorToast(error, 'Could not create the server.');
        return null;
      }
    },
    [addServer, errorToast, pushToast],
  );

  const setJavaPath = useCallback(
    async (id: string, javaPath: string | null): Promise<boolean> => {
      if (!hasBackend()) {
        updateServer(id, { javaPath: javaPath ?? undefined });
        pushToast(javaPath ? 'Java runtime saved (mock).' : 'Java override cleared (mock).', 'ok');
        return true;
      }
      try {
        const dto = await tauriServers.setJavaPath(id, javaPath);
        applyServerDto(dto);
        pushToast(javaPath ? 'Java runtime saved.' : 'Java override cleared; automatic detection will be used.', 'ok');
        return true;
      } catch (error) {
        errorToast(error, 'Could not save the Java runtime.');
        return false;
      }
    },
    [applyServerDto, errorToast, pushToast, updateServer],
  );

  /** Settings save: patch the returned row in place instead of reloading the whole shell (F-06). */
  const saveServerSettings = useCallback(
    async (
      id: string,
      values: Record<string, string>,
      extra?: { name?: string; ramMb?: number; eulaAccepted?: boolean },
    ): Promise<NormalizedError | null> => {
      if (!hasBackend()) return null;
      try {
        const dto = await tauriServers.settingsUpdate(id, values, extra);
        applyServerDto(dto);
        return null;
      } catch (error) {
        return errorToast(error, 'Could not save server settings.');
      }
    },
    [applyServerDto, errorToast],
  );

  /** Delete a server and patch the list/selection in place; never leaves a stale active id (F-08). */
  const deleteServer = useCallback(
    async (id: string): Promise<boolean> => {
      if (!hasBackend()) {
        const remaining = serversRef.current.filter((server) => server.id !== id);
        setServers(remaining);
        setActiveId((current) => reconcileActiveId(current, remaining));
        setLogs((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        pushToast('Server deleted (mock).', 'ok');
        return true;
      }
      try {
        await tauriServers.remove(id);
      } catch (error) {
        errorToast(error, 'Could not delete the server.');
        return false;
      }
      const remaining = serversRef.current.filter((server) => server.id !== id);
      setServers(remaining);
      setActiveId((current) => reconcileActiveId(current, remaining));
      setLogs((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setReadiness((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      markPending(id, false);
      delete failureNotified.current[id];
      pushToast('Server deleted.', 'ok');
      return true;
    },
    [errorToast, markPending, pushToast],
  );

  const value = useMemo<Store>(() => {
    const active = servers.find((server) => server.id === activeId) ?? servers[0] ?? EMPTY_SERVER;
    const busy: Record<string, boolean> = {};
    for (const server of servers) {
      if (pendingActions[server.id] || server.status === 'starting' || server.status === 'stopping') {
        busy[server.id] = true;
      }
    }
    for (const id of Object.keys(pendingActions)) {
      if (pendingActions[id]) busy[id] = true;
    }
    return {
      servers,
      serversHydrated,
      serversLoadError,
      activeId,
      active,
      logs,
      cmdHistory,
      toasts,
      readiness,
      startingPhase: readiness[active.id] ?? null,
      busy,
      isBusy,
      backendUnavailableReason: bridgeUnavailable,
      pushToast,
      errorToast,
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
      saveServerSettings,
      deleteServer,
      refreshServers,
      retryServers,
      reloadServers,
      usedPorts: servers.map((server) => server.port),
    };
  }, [
    servers, serversHydrated, serversLoadError, activeId, logs, cmdHistory, toasts, readiness,
    pendingActions, bridgeUnavailable, pushToast, errorToast, select, start, stop, restart, kill,
    sendCommand, appendLog, clearLogs, updateServer, addServer, createServer, setJavaPath,
    saveServerSettings, deleteServer, refreshServers, retryServers, reloadServers, isBusy,
  ]);

  // Initial load only; background refreshes are silent so the shell never flashes (F-06).
  useEffect(() => {
    if (!hasBackend()) return;
    void fetchServers('initial');
    return () => {
      serversListRequest.current += 1;
    };
  }, [fetchServers]);

  // Restored command history + append-only console log for the selected server.
  // Guarded against a deleted/stale active id and against responses for a previous selection (F-07/F-08).
  useEffect(() => {
    if (!hasBackend() || !activeId) return;
    if (!serversRef.current.some((server) => server.id === activeId)) return;
    const requestedId = activeId;
    let cancelled = false;
    const isCurrent = (): boolean => !cancelled && activeIdRef.current === requestedId;
    void tauriServers.commandHistory(requestedId).then((history) => {
      if (isCurrent()) setCmdHistory(history.slice(-50));
    }).catch(() => undefined);
    void tauriServers.logsTail(requestedId, 500).then((raw) => {
      if (!isCurrent() || raw.length === 0) return;
      setLogs((prev) => {
        if ((prev[requestedId]?.length ?? 0) > 0) return prev;
        const lines: LogLine[] = raw.map((text) => {
          const match = /^\[(\d{2}:\d{2}:\d{2})\]/.exec(text);
          const msg = text.replace(/^\[[^\]]+\]\s*/, '');
          const level: LogLine['level'] = /error/i.test(msg) ? 'ERROR' : /warn/i.test(msg) ? 'WARN' : 'INFO';
          return { id: cmdSeq++, ts: match?.[1] ?? stamp(), level, source: 'Server', msg };
        });
        return { ...prev, [requestedId]: lines.slice(-MAX_RETAINED_LOG_LINES) };
      });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [activeId]);

  // Re-subscribe to real log/status/metrics/readiness events when the server set changes.
  const serverIds = useMemo(() => servers.map((server) => server.id).join(','), [servers]);
  useEffect(() => {
    if (!hasBackend()) return;
    let cancelled = false;
    const cleanups: Array<() => void> = [];
    const ids = serverIds.split(',').filter((id) => id.length > 0);
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
          const current = serversRef.current.find((server) => server.id === sid);
          pushToast(`Server "${current?.name ?? sid}" crashed. Check the Console for details.`, 'err');
          appendLog(sid, 'ERROR', 'Launcher', 'Server process exited unexpectedly (crash).');
          updateServer(sid, { status, uptimeSec: 0, cpuPct: 0, ramPct: 0, playersOnline: 0, tps: null, mspt: null, memoryMb: undefined });
          markPending(sid, false);
        } else if (status === 'stopped') {
          updateServer(sid, { status, uptimeSec: 0, cpuPct: 0, ramPct: 0, playersOnline: 0, memoryMb: undefined });
          markPending(sid, false);
        } else if (status === 'running') {
          delete failureNotified.current[sid];
          updateServer(sid, { status, uptimeSec: 1 });
          markPending(sid, false);
        } else {
          updateServer(sid, { status });
        }
      }).then((off) => {
        if (cancelled) off();
        else cleanups.push(off);
      });
      void onServerMetrics(sid, (payload) => {
        const current = serversRef.current.find((server) => server.id === sid);
        if (!current) return;
        updateServer(sid, {
          uptimeSec: payload.uptimeSec,
          cpuPct: payload.cpuPct ?? current.cpuPct,
          ramPct: payload.ramPct ?? current.ramPct,
          memoryMb: payload.memoryMb ?? current.memoryMb,
          playersOnline: payload.playersOnline ?? current.playersOnline,
          maxPlayers: payload.maxPlayers ?? current.maxPlayers,
          tps: payload.tps,
          mspt: payload.mspt,
        });
      }).then((off) => {
        if (cancelled) off();
        else cleanups.push(off);
      });
      // Boot/auto-fix phases (D8): surfaces preparing/spawning/retrying/ready/failed to the UI.
      void onServerReadiness(sid, (payload) => {
        if (!payload || typeof payload.phase !== 'string') return;
        setReadiness((prev) => ({ ...prev, [sid]: payload }));
        if (payload.phase === 'failed') {
          reportServerFailure(sid, payload.message ?? 'Server failed to start.', 'start-failed');
          markPending(sid, false);
        } else if (payload.phase === 'ready' || payload.phase === 'stopped') {
          markPending(sid, false);
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
  }, [serverIds, appendLog, updateServer, pushToast, markPending, reportServerFailure]);

  // Ambient browser-mode tick only; the desktop host is driven by real events.
  useEffect(() => {
    if (hasBackend()) return;
    const timer = window.setInterval(() => {
      const current = serversRef.current.find((server) => server.id === activeIdRef.current);
      if (!current || current.status !== 'running') return;
      const pick = tickLogPool[Math.floor(Math.random() * tickLogPool.length)];
      appendLog(current.id, pick.level, pick.source, pick.msg);
      setServers((prev) =>
        prev.map((server) =>
          server.id === current.id
            ? {
                ...server,
                uptimeSec: server.uptimeSec + 3,
                cpuPct: Math.max(2, Math.min(95, Math.round(server.cpuPct + (Math.random() * 10 - 5)))),
                ramPct: Math.max(10, Math.min(97, Math.round(server.ramPct + (Math.random() * 6 - 3)))),
              }
            : server,
        ),
      );
    }, 6000);
    return () => window.clearInterval(timer);
  }, [appendLog]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const value = useContext(Ctx);
  if (!value) throw new Error('useStore outside provider');
  return value;
}

export interface ServerRequestContext {
  readonly serverId: string;
  readonly signal: AbortSignal;
  /** False once the tab switched server/reloaded/unmounted; never commit state when false. */
  isCurrent: () => boolean;
}

export interface ServerRequestState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Request-safe loader for per-server tab data (F-07): re-runs on active-server change, aborts stale
 * responses, and exposes normalized `[code] message` errors. Tab adoption is the other workstream's
 * change; this hook is the shared implementation they should call instead of raw fetch+setState.
 */
export function useActiveServerRequest<T>(
  loader: (context: ServerRequestContext) => Promise<T>,
  deps: readonly unknown[] = [],
): ServerRequestState<T> {
  const { activeId } = useStore();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const requestSeq = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!activeId) {
      requestSeq.current += 1;
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    const requestId = ++requestSeq.current;
    const controller = new AbortController();
    let released = false;
    const isCurrent = (): boolean => !released && mounted.current && requestSeq.current === requestId && !controller.signal.aborted;
    setLoading(true);
    setError(null);
    void Promise.resolve()
      .then(() => loader({ serverId: activeId, signal: controller.signal, isCurrent }))
      .then((result) => {
        if (isCurrent()) {
          setData(result);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (isCurrent()) setError(formatErrorText(cause, 'Could not load this tab.'));
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
    return () => {
      released = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, nonce, ...deps]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, loading, error, reload };
}

export interface LatestRequestContext {
  readonly signal: AbortSignal;
  /** False when a newer request started, the caller unmounted, or the controller was cancelled. */
  isCurrent: () => boolean;
}

export interface UseLatestRequest {
  run<T>(task: (context: LatestRequestContext) => Promise<T>): Promise<T | undefined>;
  cancel: () => void;
}

/**
 * Request-safe helper for query/action callbacks that are not keyed by the active server (Content
 * search/version lookups, refresh buttons). Each `run` supersedes the previous one, so a slow older
 * response can no longer overwrite newer state (F-07). Stale rejections resolve to `undefined`.
 */
export function useLatestRequest(): UseLatestRequest {
  const controller = useRef(createLatestRequest());
  useEffect(() => () => controller.current.cancel(), []);
  const run = useCallback(async <T,>(task: (context: LatestRequestContext) => Promise<T>): Promise<T | undefined> => {
    const lease = controller.current.begin();
    const context: LatestRequestContext = { signal: lease.signal, isCurrent: lease.isCurrent };
    try {
      return await task(context);
    } catch (error) {
      if (lease.isCurrent()) throw error;
      return undefined;
    }
  }, []);
  const cancel = useCallback(() => controller.current.cancel(), []);
  return useMemo(() => ({ run, cancel }), [run, cancel]);
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
