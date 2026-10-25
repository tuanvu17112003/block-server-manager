# Research — Modrinth Root-Level Override Failure

Date: 2026-10-09  
Trigger: A server modpack install stops during “Applying server overrides” with `Modrinth override has no destination parent`. The screenshot shows 87% progress. The user also reports the same error with another pack and with pack version 4.0.5.

## Finding

This is an app-side extraction bug. The installer accepts a valid override file path such as `options.txt`, then asks Rust for its parent and rejects the empty parent. Rust documents that a one-component relative path has `Some("")` as its parent. The `.mrpack` specification explicitly includes `overrides/options.txt` as a valid root-level override and says it is copied to the instance root. The same path shape can occur after stripping `server-overrides/`.

The shared and server layers are already applied in the specified order. The failure occurs before installation publication, while an override file is being copied into staging. Since the pack archive itself was not attached, the exact entry that triggered the screenshot cannot be identified; the error text and code path nevertheless pinpoint the invalid assumption.

The pasted launcher log is a separate later startup failure on `Hasturian2_1`: Fabric loads, then aborts on missing dependencies (`modmenu`, `s_lib`, and `simplytooltips`). It does not explain the install-time override error and remains covered by the prior server-start research note.

## Code evidence

- `src-tauri/src/modpacks/install.rs`, `apply_override_layer`: after `safe_target` validates the destination, the code filters out an empty `Path::parent()` and returns the reported error. For a root-level filename, the empty parent is expected and means the target is directly under the staging root.
- `archive_layer` strips `overrides/` or `server-overrides/`; the remaining filename is allowed by `validate_relative_path`.
- `safe_target` validates the complete relative path and checks the staging root and existing components for reparse points. The fix should keep this validation and skip parent-directory creation only when the validated file is at the staging root.

## Recommended correction

Create the destination parent directory only when a nonempty parent exists. For a root-level file, write directly to the already validated target under staging. Preserve archive path validation, reserved-path checks, reparse-point checks, regular-file conflict handling, cancellation, and shared-then-server layer order.

## Sources

- Modrinth Help Center, [Modrinth Modpack Format (.mrpack)](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack) — defines override files as relative to the instance root, demonstrates `overrides/options.txt`, and documents server override layering.
- Rust standard library, [`Path::parent`](https://doc.rust-lang.org/stable/std/path/struct.Path.html#method.parent) — documents `Some("")` for a relative path with one component.
