# ADR 0016: Rebuild the Modpack Setup Pipeline In-App

- Status: Accepted
- Date: 2026-10-11

## Context

The current app has separate Modrinth and CurseForge setup paths with recurring failures in pack-file selection, downloads, loader preparation, and diagnostics. The supplied survey found no mature Windows desktop drop-in. Its strongest implementation references are useful for policy, but they have container assumptions, beta/update gaps, incomplete security checks, or incompatible failure behavior. The user chose to keep CurseForge keyless, defer new Quilt installs, and use the current app as the product.

## Decision

Build a unified, staged install pipeline in the existing Tauri/Rust app. Provider adapters produce an exact-pinned install plan consumed by shared validation, file selection, loader setup, transaction, launch parsing, readiness, and reporting stages. The on-disk plan is an audit record only: install decisions are rederived from pinned source data and explicit UI choices before mutation. Use `itzg/mc-image-helper`, `nothub/mrpack-install`, and packwiz as reviewed references; do not bundle them or add a runtime dependency for this overhaul.

CurseForge intake remains author-provided server ZIP only. Modrinth accepts exact project/version selection and a local `.mrpack`. New Quilt installs remain disabled with an explicit planned/unsupported UI and backend response. Saved Quilt server behavior is unchanged.

Keep current core invariants: exact versions only; per-file hashes and size checks when metadata supplies them; safe bounded ZIP handling; no imported script execution; explicit EULA; same-volume staging; rollback-safe publication; world preservation; and no readiness success without the loader and `Done (...)!` evidence.

The update transaction records each pipeline-owned path and installed hash in an additive SQLite ownership registry; `managed-files.json` is an audit snapshot, not the sole deletion authority. It may remove a stale file only when the registry and manifest agree that the pipeline created it, the actual file hash matches its installed hash, the new plan no longer includes it, and the path is not protected. Every persisted target is rebound to the selected server ID and canonical app-data directory before access. Untracked files and locally modified managed files are preserved unless the user explicitly approves replacement after backup. Runtime failure classification reports evidence and does not repair pack contents automatically.

## Consequences

- A normalized plan makes provider-specific metadata errors visible before writing to the target server.
- A single policy and transaction path reduces behavioral drift between CurseForge and Modrinth.
- The app keeps control over its Windows safety and failure behavior without inheriting unsafe or incompatible upstream defaults.
- This is a multi-phase migration; the old installer handlers remain until the new pipeline passes acceptance and review.
- Curated side rules require a separate sourced/licensed review; the initial pipeline uses explicit pack metadata and user choices.
- Updates can remove stale pipeline-owned mods without sweeping up manually added files; the ownership manifest and backup are part of the published install record.
- Legacy servers without an ownership registry require reviewed adoption before the update path can prune stale files.
- Runtime errors become actionable diagnostics while the failed server remains available for review; quarantine and one-click repair are not part of this decision.
