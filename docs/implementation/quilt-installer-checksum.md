# Quilt Installer Checksum

> Retired for new server creation on 2026-10-09. This note records the historical approved verification approach only; Quilt is no longer offered or installed for new servers. Existing saved Quilt server process support remains.

## Goal

Install Quilt 0.15.1 using the user-approved Maven checksum sidecar policy while keeping byte verification fail-closed and making the upstream mismatch visible.

## Ordered steps

1. Keep resolving the installer version, exact Maven URL, and expected size from Quilt Meta. **Done.**
2. Validate the exact URL against `maven.quiltmc.org`, then fetch `<url>.sha256` without following redirects and require HTTP 200.
3. Parse only a bare 64-digit checksum or a checksum followed by the exact expected filename; reject junk text even if it contains a 64-digit token. Missing/malformed sidecars and byte mismatches fail closed.
4. Emit a visible install-log warning when Quilt Meta’s SHA-256 differs from the Maven sidecar. **Done.**
5. Include the artifact filename in hash mismatch errors. **Done.**
6. Tests/build: **Done**, Rust suite 18/18, formatting passes, elevated Tauri dev build succeeds, independent review PASS. The live Quilt retry is pending.

## Acceptance criteria

- The downloaded Quilt installer remains size-checked and SHA-256-verified.
- The approved Maven sidecar is restricted to the exact validated Quilt Maven artifact URL, with no redirect following; only HTTP 200 and strict checksum syntax are accepted. The disagreement is visible and malformed/missing data fails closed.
- No dependency is added.
- A live Quilt install reaches completion after the chosen resolution.
