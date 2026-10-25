# Implementation — Modrinth Runtime and Fabric Metadata Preflight

## Owned paths

- `src/tabs/Create.tsx` — recommended-major default selection and readiness/error guidance.
- `src/tauri.ts` — install input shape only if the explicit override state must cross IPC.
- `src-tauri/src/modpacks/install.rs` — bounded Fabric metadata parsing and dependency predicates.
- `src-tauri/src/installer/mod.rs` — move the compatibility preflight before override application.
- Focused existing tests in the owned Rust modules; no dependency additions.
- Update the linked spec/ADR/state only if implementation reality requires a documented adjustment.

## Ordered work

1. Make automatic Create selection prefer the detected Minecraft-recommended Java major exactly; if unavailable, surface the existing compatible-major install action before a pack install is started. Keep a user's explicit override explicit.
2. Update Fabric JAR inspection to tolerate the metadata forms Fabric Loader accepts, including the raw line feed in the known Better End description. Keep archive-entry and decompressed metadata bounds.
3. Interpret `depends.java` string and string-array forms correctly: array is OR, whitespace-separated terms are AND, bare major is exact, comparison predicates are honored. Because runtime detection currently exposes only the Java major, do not truncate minor/patch constraints into a falsely compatible major-only result; report predicates whose precision cannot be compared as unverified. Unknown syntax or unreadable metadata also emits a scoped unverified warning rather than blocking on a false mismatch.
4. Run the scan after selected server mod JAR downloads and loader preparation, but before the expensive shared/server override copy. Include JARs supplied or replaced by either override layer in the effective-set scan, preserving shared-then-server precedence. Check cancellation between inspected JARs and ensure all temporary scratch content is removed before success/publication; cleanup failure must prevent publication.
5. Add focused regression cases for: Better End raw-LF metadata with no Java dependency; exact `21` against Java 25; `>=21` against Java 25; array alternative matching; array with no matching alternative; unsupported syntax; and scan ordering before large overrides.

## Acceptance checklist

- [x] On Minecraft 1.21.1 with Java 25 installed and no Java 21 installed, automatic Modrinth setup does not silently use Java 25; the user is directed to install/select Java 21 before large downloads.
- [x] A deliberate Java override is retained and checked after server mod JARs become available.
- [x] Java 25 passes `>=21` and fails exact `21`; array alternatives and space-separated conjunctions match Fabric behavior.
- [x] The local Better End metadata shape does not fail installation solely because strict JSON rejects its description; absence of `depends.java` is not treated as a Java mismatch.
- [x] A positively discovered Java conflict is surfaced before server overrides are applied.
- [x] Fabric JARs included or replaced by shared/server override layers are checked before the large override copy, with the documented precedence preserved.
- [x] Constraints requiring Java minor/patch precision are not silently reduced to a major-only comparison; cancellation and scratch cleanup are guaranteed across both preflight scans.
- [x] Unknown/unreadable metadata is identified as unverified with the mod/archive context and does not claim full compatibility.
- [x] Existing download hash/path checks, server environment policy, cancellation, EULA, staging, publication, and no-script guarantees remain intact.
- [x] Independent review passes; focused tests (100/100 Rust tests), Rust formatting, library build, and frontend production build pass.

## References

- [Specification](../specs/server-pack-install-correctness.md)
- [ADR-0014](../architecture/adr/0014-modrinth-java-runtime-and-fabric-metadata-preflight.md)
- [Research](../research/2026-10-10-modrinth-runtime-and-fabric-metadata.md)
