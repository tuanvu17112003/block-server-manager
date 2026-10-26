// Shared install/install-job state for the Create wizard flows (extracted from Create.tsx, WP-6.5).
import { useRef, useState } from 'react';
import type { PipelinePreviewDto } from '../../tauri';
import type { Kind } from './helpers';

export function useInstallState() {
  const [progress, setProgress] = useState(0);
  const [installing, setInstalling] = useState(false);
  const [installStage, setInstallStage] = useState('');
  const [installLogs, setInstallLogs] = useState<string[]>([]);
  const [installBytes, setInstallBytes] = useState<{ downloaded: number | null; total: number | null }>({
    downloaded: null,
    total: null,
  });
  const [installError, setInstallError] = useState('');
  const [installJobId, setInstallJobId] = useState<string | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const cancelRequestedRef = useRef(false);
  const installingRef = useRef(false);
  const installRequestStartedRef = useRef(false);
  const installTimerRef = useRef<number | null>(null);
  const [doneId, setDoneId] = useState<string | null>(null);
  const pipelinePreviewRef = useRef<PipelinePreviewDto | null>(null);
  const installCleanupRef = useRef<{ jobId: string | null; installing: boolean; kind: Kind }>({
    jobId: null,
    installing: false,
    kind: 'vanilla',
  });

  return {
    progress,
    setProgress,
    installing,
    setInstalling,
    installStage,
    setInstallStage,
    installLogs,
    setInstallLogs,
    installBytes,
    setInstallBytes,
    installError,
    setInstallError,
    installJobId,
    setInstallJobId,
    cancelRequested,
    setCancelRequested,
    cancelRequestedRef,
    installingRef,
    installRequestStartedRef,
    installTimerRef,
    doneId,
    setDoneId,
    pipelinePreviewRef,
    installCleanupRef,
  };
}

export type InstallState = ReturnType<typeof useInstallState>;
