# Backend Phase 3 — Verification

Date: 2026-10-08
Tester: independent read-only verification

| Command | Result |
|---|---|
| `npx tsc --noEmit` | PASS (exit 0) |
| `npm run build` | Host failure (exit 1): Vite/Node native `realpath` returned `EPERM` for `src/main.tsx` on H: |
| `npm run build` with temporary external Node realpath fallback | PASS (exit 0; 48 modules transformed); shim removed and project files unchanged |
| `cargo check` | Not run: `cargo` unavailable |
| `cargo test` | Not run: `cargo` unavailable |
| `cargo fmt --check` | Not run: `cargo` unavailable |
| Project test/lint scripts | None configured in `package.json` |

At the initial verification pass, TypeScript/build checks passed with the host workaround documented in the Phase 2 archive. Rust tooling had not yet been found; later final Rust results are recorded below. Windows runtime installation remains unverified.

## Rework verification — attempts 1 and 2

| Command | Result |
|---|---|
| `npx tsc --noEmit` after R1 | PASS |
| `npm run build` after R1 | Host `EPERM` on native `realpath` |
| `npm run build` after R1 with temporary external realpath fallback | PASS; shim removed afterward |
| `cargo test --manifest-path src-tauri/Cargo.toml java::tests` | Not run: Cargo unavailable |
| `cargo fmt --check` | Not run: Cargo unavailable |
| `npx tsc --noEmit` after R2 | PASS |
| `npm run build` after R2 | Host `EPERM` on native `realpath` |
| `npm run build` after R2 with temporary external realpath fallback | PASS; shim removed afterward |

Focused Rust tests were added for the current Create catalogue's local Start mappings and unsupported versions, offline fallback behavior, and byte-range unit validation. The Java download/extraction flow was not exercised end to end.

The local Start mapping test directly asserts all seven Create entries and fails closed for unknown versions and Minecraft 26.1. At the time of this R3 verification it was unexecuted; the later Rust toolchain section records its result.

## Verification after Rust toolchain was found

- Rust toolchain was present at `C:\Users\tronv\.cargo\bin` but was not on the shell PATH. Cargo downloaded the manifest-declared crate set after the user asked for the Rust checks; no `Cargo.toml` dependencies changed.
- `cargo test --offline --manifest-path src-tauri/Cargo.toml` — PASS, 5 passed / 0 failed (library); the binary and doc-test targets had 0 tests. A temporary 1×1 icon fixture was needed because the existing Tauri build script requires `src-tauri/icons/icon.ico`; the fixture directory was removed after the command.
- `cargo check --offline --manifest-path src-tauri/Cargo.toml` — PASS.
- `cargo clippy --offline --manifest-path src-tauri/Cargo.toml --all-targets` — PASS with warnings for two planned event helpers not yet used and a pre-existing `map_or` in `servers/process.rs`.
- `rustfmt --edition 2021 --check src-tauri/src/java/mod.rs` — PASS.
- `cargo fmt --check` for the full crate — FAIL due formatting differences in existing `src-tauri/src/cmds/process.rs`, `servers/mod.rs`, and `servers/process.rs`; the Phase 3 Java module itself is formatted. Those unrelated legacy sections were left unchanged.
- Compiler follow-up fixed invalid Windows path string escapes and a temporary-lifetime borrow error in the process status helper. Rust tests and cargo check pass afterward.
- No live Temurin download/extraction test was run; the tested paths are unit mappings and parser behavior.

## Rust toolchain recheck after user request

- `cargo fmt --check --manifest-path src-tauri/Cargo.toml` initially exposed invalid Windows path escapes in Java candidate discovery and a borrow-check error in `set_db_status`; both were corrected. The same command still exits 1 because rustfmt reports existing formatting differences in `src-tauri/src/cmds/process.rs`, `src-tauri/src/servers/mod.rs`, and `src-tauri/src/servers/process.rs`. The new Java module passes focused `rustfmt --edition 2021 --check`.
- `cargo test --offline --manifest-path src-tauri/Cargo.toml java::tests` — PASS, 5 passed / 0 failed.
- `cargo check --offline --manifest-path src-tauri/Cargo.toml` — PASS.
- `cargo clippy --offline --manifest-path src-tauri/Cargo.toml --all-targets` — PASS with warnings for two planned event helpers and an existing `map_or` in `servers/process.rs`.
- Tauri's build script requires `src-tauri/icons/icon.ico`, which is absent from the project. A temporary 1×1 icon fixture was created for the Rust commands and removed in a `finally` block. No source icon was added.
- Cargo generated `src-tauri/Cargo.lock` from the existing manifest; `Cargo.toml` was not changed.
- The Java installer was not run end to end and no Temurin JDK was downloaded.
