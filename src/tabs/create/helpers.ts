// Shared types/helpers for the Create wizard (extracted from Create.tsx, WP-6.5).
import type { Modpack, Server } from '../../types';
import type {
  CurseForgeArchiveInspection,
  JavaCandidate,
  LoaderChoiceDto,
  ModrinthInstallLoader,
  PipelineFileDecision,
  ServerDto,
} from '../../tauri';

export type PipelineFileReason = PipelineFileDecision['reason'];

export type Kind = 'vanilla' | 'curseforge' | 'modrinth';

export const MODRINTH_PAGE_SIZE = 20;
export const MAX_REPORT_DETAIL_ROWS = 100;
export const CURSEFORGE_AUTO_DELETE_KEY = 'cf-auto-delete-zip';
export const MAX_LOCAL_MRPACK_BYTES = 2 * 1024 ** 3;

export const MODRINTH_LOADER_NAMES: Record<ModrinthInstallLoader, string> = {
  minecraft: 'Vanilla',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
};

export const MODRINTH_INSTALLER_LOADER_NAMES: Record<ModrinthInstallLoader, LoaderChoiceDto['loader']> = {
  minecraft: 'Vanilla',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
};

export type ModrinthLoaderOption = {
  id: string;
  loader: ModrinthInstallLoader | null;
  label: string;
  reason?: string;
};

export const fmtDl = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}K`);

export function modrinthLoaderOptions(version: { loaders: string[] } | null): ModrinthLoaderOption[] {
  if (!version) return [];
  const declared = Array.from(new Set(version.loaders.map((value) => value.trim().toLowerCase()).filter(Boolean)));
  if (declared.length === 0) {
    return [{ id: 'minecraft', loader: 'minecraft', label: 'Vanilla (no loader dependency)' }];
  }
  return declared.map((id) => {
    if (id === 'minecraft' || id === 'fabric' || id === 'forge' || id === 'neoforge') {
      return {
        id,
        loader: id,
        label: id === 'minecraft' ? 'Vanilla' : MODRINTH_LOADER_NAMES[id],
      };
    }
    const name = id === 'quilt' ? 'Quilt' : id.charAt(0).toUpperCase() + id.slice(1);
    return {
      id,
      loader: null,
      label: `${name} — unsupported for new server installs`,
      reason: id === 'quilt' ? 'Quilt pack installs are not supported.' : `The ${name} loader is not supported for new server installs.`,
    };
  });
}

export function cfInstallable(inspection: CurseForgeArchiveInspection | null): boolean {
  return Boolean(inspection && (inspection.classification === 'supportedServerPack' || inspection.classification === 'clientExport'));
}

export function errorText(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error;
  return error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : fallback;
}

export function serverFromInstall(dto: ServerDto, recommended: number, modpack?: string): Server {
  return {
    id: dto.id,
    name: dto.name,
    status: 'stopped',
    mcVersion: dto.mcVersion,
    javaPath: dto.javaPath ?? undefined,
    loader: dto.loader,
    loaderVersion: dto.loaderVersion ?? undefined,
    modpack,
    playersOnline: 0,
    maxPlayers: 20,
    port: dto.port,
    ramMb: dto.ramMb,
    ramRecommendedMb: recommended,
    uptimeSec: 0,
    cpuPct: 0,
    ramPct: 0,
    tps: null,
    mspt: null,
    address: '127.0.0.1',
    eulaAccepted: dto.eulaAccepted,
    motd: 'A fresh server!',
    difficulty: 'Normal',
    gamemode: 'Survival',
    onlineMode: true,
    seed: '',
    worldName: 'world',
    worldSizeMb: 0,
    worldLastPlayed: '—',
    version: dto.mcVersion + ' ' + dto.loader,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

/** User-choice rows: optional files default to include; only conflicts require an explicit answer. */
export function isReviewableDecision(decision: PipelineFileDecision): boolean {
  return decision.reason === 'optionalDefaultKeep' || decision.action === 'awaitingUserChoice';
}

export function initialPipelineChoices(decisions: PipelineFileDecision[]): Record<string, 'include' | 'exclude'> {
  const choices: Record<string, 'include' | 'exclude'> = {};
  for (const decision of decisions) {
    if (decision.reason === 'optionalDefaultKeep') choices[decision.path] = 'include';
  }
  return choices;
}

export function decisionReasonLabel(reason: PipelineFileReason): string {
  return reason === 'serverUnsupported' ? 'unsupported on servers' : reason;
}

export function validatesMrpackFile(file: { name: string; size: number }): string | null {
  if (!/\.mrpack$/i.test(file.name)) return 'Select a file with a .mrpack extension.';
  if (file.size === 0 || file.size > MAX_LOCAL_MRPACK_BYTES) return '.mrpack size is outside the 2 GiB import limit.';
  return null;
}

/** CurseForge project input: numeric id, project URL or slug. */
export function curseforgeProjectInputError(rawInput: string): string | null {
  const raw = rawInput.trim();
  if (!raw) return 'Paste a CurseForge modpack URL, slug or numeric project id.';
  if (raw.length > 512 || /[\s<>"'`]/.test(raw)) return 'Enter a modpack URL, slug or numeric project id without spaces or quotes.';
  if (!/^\d+$/.test(raw) && !/^https?:\/\/[^\s]+\.[^\s]+\//i.test(raw) && !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(raw)) {
    return 'That does not look like a CurseForge modpack URL, slug or numeric project id.';
  }
  return null;
}

export function javaCandidateLabel(candidate: JavaCandidate): string {
  return `Java ${candidate.major} · ${candidate.architectureBits}-bit · ${candidate.source}`;
}

export type { Modpack };


/**
 * Evidence-grade presentation (docs/audit/26 Item 4). The single implementation lives in
 * `electron/services/evidence-grade.ts` and is pinned by `electron/test/unit/ui-evidence-grade.test.ts`.
 * Mirrored here because `electron/tsconfig.json` uses `rootDir: "."` so an Electron module cannot be imported
 * from the renderer bundle without changing the emit layout — the same constraint and the same
 * mirror-plus-contract-test pattern the repo already uses for `shared/contracts.ts`
 * (`electron/services/validate-ipc.ts:9-18`). Keep the two in step: the test fails if this rule drifts.
 */
export interface EvidenceGradeView {
  supported: boolean;
  tone: 'green' | 'amber';
  label: string;
}

/** A grade below E2 is never presented as supported; unrecognised grades fail closed. */
export function describeEvidence(evidence: { grade: string }): EvidenceGradeView {
  const supported = evidence.grade === 'E1' || evidence.grade === 'E2';
  return supported
    ? { supported, tone: 'green', label: `Verified format (${evidence.grade})` }
    : { supported, tone: 'amber', label: `Format not yet proven (${evidence.grade})` };
}
