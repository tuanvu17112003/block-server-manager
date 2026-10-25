# ADR 0003 — App-Local Java Runtime Provisioning

Status: Accepted for Phase 3 (2026-10-08)

## Context

Minecraft servers require different Java major versions. Phase 3 supports Windows x64 Java 8, 17, and 21; server records already contain a `java_path` field. A machine-wide MSI install could modify PATH, `JAVA_HOME`, or registry state and can require elevation. The Rust crate currently has no HTTP, archive, or hashing dependencies, and the project requires approval before adding dependencies.

## Decision

Download the release-specific Temurin Windows x64 JDK ZIP identified by Adoptium asset metadata. Keep partial and final archives and extracted runtimes under application data. Use Windows inbox `curl`, `tar`, and SHA-256 tooling, plus `GetDiskFreeSpaceExW` for the free-space preflight. Validate `java.exe` before publishing the runtime and persist a validated executable path per server.

Mojang version JSON `javaVersion.majorVersion` is authoritative. A maintained fallback handles only known versions. Phase 3's supported majors remain 8/17/21; Java 25 and Minecraft 26.1 stay out of scope until the plan is explicitly expanded.

## Consequences

- Java installation does not mutate machine-wide PATH, `JAVA_HOME`, or registry state, and it requires no new Rust crate.
- Windows must provide the documented inbox transfer/archive/hash tools; missing tools produce a clear error.
- HTTP range resume is best-effort because servers may ignore range requests; every completed archive still requires exact size and SHA-256 verification.
- Non-Windows provisioning and ARM64 packages are outside this Phase 3 implementation.
