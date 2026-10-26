// Port availability for the Create wizard (WP-6.3): debounced backend port_check + derived block state.
import { useEffect, useState } from 'react';
import { hasBackend, tauriServers } from '../../tauri';

export function usePortAvailability(port: number, usedPorts: number[]) {
  const [portCheck, setPortCheck] = useState<{ port: number; available: boolean; suggested: number } | null>(null);
  const [portChecking, setPortChecking] = useState(false);

  useEffect(() => {
    if (!hasBackend()) return;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setPortCheck(null);
      setPortChecking(false);
      return;
    }
    let cancelled = false;
    setPortChecking(true);
    const timeout = window.setTimeout(() => {
      void tauriServers.portCheck(port).then((result) => {
        if (!cancelled) setPortCheck(result);
      }).catch(() => {
        if (!cancelled) setPortCheck(null);
      }).finally(() => {
        if (!cancelled) setPortChecking(false);
      });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [port]);

  const portConflict = usedPorts.includes(port);
  const portOutOfRange = !Number.isInteger(port) || port < 1 || port > 65535;
  const portCheckMatches = Boolean(portCheck && portCheck.port === port);
  const portUnavailable = Boolean(hasBackend() && !portOutOfRange && portCheckMatches && portCheck && !portCheck.available);
  const portBlocked = portOutOfRange || portConflict || portUnavailable;
  const portSuggested = hasBackend() && portCheckMatches && portCheck && !portCheck.available && portCheck.suggested !== port
    ? portCheck.suggested
    : null;

  return { portChecking, portConflict, portOutOfRange, portUnavailable, portBlocked, portSuggested, setPortCheck, resetPortCheck: () => setPortCheck(null) };
}

export type PortAvailabilityState = ReturnType<typeof usePortAvailability>;
