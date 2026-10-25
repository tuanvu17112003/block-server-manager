# Implementation — Server Pack Correctness

## Owned paths

- `src-tauri/src/modpacks/curseforge_import.rs`
- `src-tauri/src/modpacks/install.rs`
- `src-tauri/src/installer/mod.rs`
- Focused existing UI only if the install summary/error needs a user-visible message.
- Update the spec, ADR, research index, and workflow state after review.

## Ordered work

1. Fix Forge argument parsing so `-DignoreList` basenames are excluded while actual argument/classpath JAR references remain checked.
2. Add one-level single-inner-ZIP materialization with bounded streaming, same-volume temporary files, RAII cleanup, and existing archive/path limits.
3. Parse recognized ServerPackCreator metadata and exact supported loader versions. For metadata-only packs, run the existing official base installer before safely overlaying server files. Never invoke pack scripts.
4. Add exact Fabric loader metadata verification to CurseForge import and permit Fabric only for the recognized metadata format.
5. Parse Modrinth `env.server`, keep required/optional files, skip unsupported entries, retain backward-compatible absent fields, and report counts.
6. Before publication, inspect Fabric mod metadata for supported `depends.java` major constraints and reject a mismatched selected runtime.
7. Add focused regression coverage for the exact ignore-list shape, nested pack manifest, environment selection, and Java 21 versus Java 25 constraints.
8. Independently review the diff and run the affected Rust module checks plus relevant application build checks. Do not start a server or execute pack scripts.

## Quality constraints

- No new Rust dependency without explicit user consent.
- Do not change database records or existing server folders; supplied logs are read-only evidence.
- Preserve exact URL and hash validation, cancellation, explicit EULA, atomic publication, loader checks, and the existing manager launch path.
- Keep unknown formats unsupported and explain which marker is missing.

