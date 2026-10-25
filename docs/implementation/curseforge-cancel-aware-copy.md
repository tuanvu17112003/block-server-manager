# Implementation — cancellation-aware wrapped CurseForge ZIP copy

## Owned paths

- `src-tauri/src/modpacks/curseforge_import.rs`
- `src-tauri/src/modpacks/pipeline/providers/curseforge.rs`
- `src-tauri/src/modpacks/pipeline/providers/mod.rs`

## Ordered steps

1. Add a cancellation-aware archive-classification entry point that reuses the current classifier and sends single-file wrapper extraction through the existing chunked copy helper. Keep the non-cancellable wrapper for inspection and other existing callers.
2. Add a `NestedArchiveCopy` resolution checkpoint and pass the job cancellation callback into that entry point during provider re-resolution.
3. Translate copy cancellation to `ProviderResolutionError::Cancelled`; preserve normal archive classification and RAII cleanup behavior.

## Verification and review

- Run the Rust compile check and the scoped `rustfmt --check` for touched Rust files.
- Obtain the independent review requested for this follow-up, focused on cancellation reaching the actual install-time re-resolution path, cancelled-error mapping, and temporary-file cleanup.
- No live server or user archive is needed for static verification.
