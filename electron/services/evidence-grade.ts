// How strongly a format's support is proven (docs/audit/19 §2), resolved to what the user sees.
//
// Why this lives inside the renderer rather than `shared/`: `electron/tsconfig.json` has `rootDir: "."`, so an
// Electron source file cannot import from `../shared` without changing the emit layout (it would push every
// module down a directory and break every `require` path). The repo's existing answer to that is a runtime
// mirror plus a contract test asserting the copies agree — see `electron/services/validate-ipc.ts:9-18`, which
// documents exactly this for `shared/contracts.ts`. This module follows the same pattern:
// `electron/test/unit/ui-evidence-grade.test.ts` pins the rule itself, and `shared/contracts.ts` stays the
// single source for DTO shapes.
//
// The rule is a correctness property, not styling: **a grade below E2 must never be presented as supported.**
// E3 means the format was reconstructed from a schema and no real pack of it has ever been installed; calling
// that supported is the unfalsifiable-claim error the C0–C8 remediation existed to remove (doc 22 RC-4).

export interface EvidenceGradeView {
  /** True only when the format is proven AND the plan will actually populate the server. */
  supported: boolean;
  tone: 'green' | 'amber';
  label: string;
}

/**
 * Map an evidence grade onto what the user sees.
 *
 * Fails closed: any grade not exactly `E1`/`E2` — including an empty string, a lowercase `e2`, or a future grade
 * — is treated as unsupported, so it cannot be optimistically displayed as verified.
 */
export function describeEvidence(evidence: { grade: string; selfContained?: boolean; plannedFileCount?: number }): EvidenceGradeView {
  const proven = evidence.grade === 'E1' || evidence.grade === 'E2';
  if (!proven) {
    return { supported: false, tone: 'amber', label: `Format not yet proven (${evidence.grade})` };
  }
  // DV-44: a proven format whose plan downloads nothing is NOT "verified and ready". A Prism/MultiMC instance is
  // recognised correctly yet carries its payload in the launcher, so the server this produces would be empty.
  if (evidence.selfContained === false) {
    return {
      supported: false,
      tone: 'amber',
      label: `Launcher instance (${evidence.grade}) — no files to install`,
    };
  }
  return { supported: true, tone: 'green', label: `Verified format (${evidence.grade})` };
}
