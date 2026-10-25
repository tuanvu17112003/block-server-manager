# Modrinth Preview IPC Casing Fix

## Owned paths

- `src-tauri/src/modpacks/pipeline/commands.rs`
- `src/tabs/Create.tsx`
- `docs/research/2026-10-13-modrinth-preview-ipc-casing.md`
- `docs/specs/modrinth-preview-ipc-contract.md`

## Steps

1. Apply Serde camelCase field renaming to all struct variants in `PipelineSourceRequest`.
2. Add a deserialization regression for remote, local, and CurseForge request shapes copied from the TypeScript contract.
3. Update `errorText` to return nonempty primitive string rejections before falling back.
4. Build and run focused Rust tests.
5. Reproduce the screenshot's exact remote Modrinth pin with a Tauri debug build configured with unique app directories; capture the preview result/error. Do not invoke the install command or start a server in the smoke test.

## Quality gates

- `cargo test --lib ... modpacks::pipeline::commands::tests` passes with the new wire-contract cases.
- `cargo check --lib --offline`, scoped Rust formatting, and `npm run build` pass.
- The exact remote preview reaches provider validation; other IPC argument failures remain visible in the toast.
- Independent review confirms every request variant matches the TypeScript wire shape.

## Verification record — 2026-10-13

- Focused Rust command tests: 3/3 passed, including camelCase deserialization for remote Modrinth, local `.mrpack`, and CurseForge requests.
- `cargo check --lib --offline`: passed with existing dead-code warnings; scoped `rustfmt --check` passed.
- `npm run build`: passed (TypeScript and Vite production bundle).
- Isolated Tauri repro: before the fix, the exact request failed with `missing field project_id` and the webview received a string rejection. After the fix, Cobblemon project `5FFgwNNP`, version `BpTjgzL8`, Minecraft 1.21.1/Fabric preview succeeded with 77 file decisions. No install or server start was invoked.
- Independent source review: PASS; no actionable findings. The reviewer did not run tests or the Tauri reproduction.
