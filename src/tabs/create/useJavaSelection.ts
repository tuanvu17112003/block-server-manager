// Java runtime selection for the Create wizard (extracted from Create.tsx, WP-6.5/WP-6.3).
import { useEffect, useState } from 'react';
import type { JavaCandidate, JavaDetection } from '../../tauri';
import { hasBackend, onJobProgress, tauriJava } from '../../tauri';
import { errorText } from './helpers';

interface Options {
  configuredMcVersion: string;
  pushToast: (message: string, tone: 'ok' | 'err' | 'info') => void;
}

export function useJavaSelection({ configuredMcVersion, pushToast }: Options) {
  const [javaDetection, setJavaDetection] = useState<JavaDetection | null>(null);
  const [javaSelected, setJavaSelected] = useState<JavaCandidate | null>(null);
  const [javaPath, setJavaPath] = useState('');
  const [javaOverride, setJavaOverride] = useState(false);
  const [javaLoading, setJavaLoading] = useState(false);
  const [javaInstalling, setJavaInstalling] = useState(false);
  const [javaProgress, setJavaProgress] = useState(0);
  const [javaProgressLog, setJavaProgressLog] = useState('');
  const [javaError, setJavaError] = useState('');
  const [javaRetry, setJavaRetry] = useState(0);

  useEffect(() => {
    if (!hasBackend() || !configuredMcVersion) {
      setJavaLoading(false);
      if (hasBackend()) {
        setJavaDetection(null);
        setJavaSelected(null);
        setJavaPath('');
        setJavaOverride(false);
      }
      return;
    }
    let cancelled = false;
    setJavaLoading(true);
    setJavaError('');
    void tauriJava.detect(configuredMcVersion).then((detection) => {
      if (cancelled) return;
      const candidate = detection.candidates.find((runtime) => runtime.major === detection.installMajor) ?? null;
      setJavaDetection(detection);
      setJavaSelected(candidate);
      setJavaPath(candidate?.path ?? '');
      setJavaOverride(false);
    }).catch((error: unknown) => {
      if (cancelled) return;
      const message = errorText(error, 'Could not inspect Java for this Minecraft version.');
      setJavaDetection(null);
      setJavaSelected(null);
      setJavaPath('');
      setJavaError(message);
      pushToast(message, 'err');
    }).finally(() => {
      if (!cancelled) setJavaLoading(false);
    });
    return () => { cancelled = true; };
  }, [configuredMcVersion, pushToast, javaRetry]);

  const installJava = async (): Promise<void> => {
    if (!hasBackend() || !javaDetection || javaInstalling) return;
    setJavaInstalling(true);
    setJavaProgress(0);
    setJavaProgressLog('Starting Temurin download…');
    setJavaError('');
    const jobId = `java-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await onJobProgress(jobId, (payload) => {
        setJavaProgress(payload.progress);
        setJavaProgressLog(payload.log ?? 'Installing Java…');
      });
      const candidate = await tauriJava.ensure(javaDetection.installMajor, jobId);
      setJavaSelected(candidate);
      setJavaPath(candidate.path);
      setJavaOverride(false);
      setJavaProgress(100);
      setJavaProgressLog(`Temurin Java ${candidate.major} is ready.`);
      pushToast(`Temurin Java ${candidate.major} is ready.`, 'ok');
    } catch (error) {
      const message = errorText(error, 'Java installation failed.');
      setJavaError(message);
      pushToast(message, 'err');
    } finally {
      unlisten?.();
      setJavaInstalling(false);
    }
  };

  const validateJavaOverride = async (): Promise<void> => {
    if (!javaPath.trim()) {
      setJavaError('Enter a JDK home folder or java.exe path.');
      return;
    }
    try {
      const candidate = await tauriJava.validate(configuredMcVersion, javaPath);
      setJavaSelected(candidate);
      setJavaPath(candidate.path);
      setJavaOverride(true);
      setJavaError('');
      pushToast(`Java ${candidate.major} (${candidate.architectureBits}-bit) is compatible with Minecraft ${configuredMcVersion}.`, 'ok');
    } catch (error) {
      const message = errorText(error, 'Java path could not be validated.');
      setJavaError(message);
      pushToast(message, 'err');
    }
  };

  /** "Change…": switch to the override editor prefilled with the detected candidate path. */
  const openJavaOverride = (): void => {
    setJavaOverride(true);
    setJavaPath(javaSelected?.path ?? '');
  };

  /** "Use detected Java": revert to the auto-detected candidate for the required install major. */
  const useDetectedJava = (): void => {
    setJavaOverride(false);
    const recommended = javaDetection?.candidates.find((runtime) => runtime.major === javaDetection.installMajor) ?? null;
    setJavaPath(recommended?.path ?? '');
    setJavaSelected(recommended);
    setJavaError('');
  };

  return {
    javaDetection,
    javaSelected,
    javaPath,
    setJavaPath,
    javaOverride,
    setJavaOverride,
    javaLoading,
    javaInstalling,
    javaProgress,
    javaProgressLog,
    javaError,
    setJavaError,
    retryJavaDetection: () => setJavaRetry((retry) => retry + 1),
    installJava,
    validateJavaOverride,
    openJavaOverride,
    useDetectedJava,
  };
}

export type JavaSelectionState = ReturnType<typeof useJavaSelection>;
