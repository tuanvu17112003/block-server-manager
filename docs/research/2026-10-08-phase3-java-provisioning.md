# Research 2026-10-08 — Phase 3 Java Provisioning

## Scope restored from the Phase 2 archive

The active implementation plan is Phase 3 Java provisioning. Its accepted examples are Minecraft 1.12.2 → Java 8, 1.20.1 → Java 17, and 1.21 → Java 21. The current Create catalogue ends at 1.21. This note corrects the older research note's future-version claim: Minecraft 26.1 requires Java 25, so it must not be inferred as Java 21 or exposed until the supported-major scope is extended.

## Temurin assets

The Adoptium API Cookbook documents a metadata endpoint for selecting the latest GA Temurin asset by feature version, operating system, architecture, and image type. For this Windows-first phase, request Windows x64 JDK assets for Java 8, 17, or 21. The asset metadata carries the package name, link, size, and SHA-256 checksum; use those release-specific values rather than hardcoding package URLs, sizes, or hashes. The API can return 404 for unavailable combinations, so report an actionable unsupported-build error.

Use the ZIP archive and extract into an app-managed runtime directory. Do not use MSI installers: Phase 3 should not change machine-wide PATH, `JAVA_HOME`, Java registry entries, or require elevation. The JDK includes `bin/java.exe` and the Adoptium API exposes the requested Windows x64 package.

## Resume, integrity, and disk space

HTTP byte-range requests are optional. RFC 9110 permits servers to ignore a `Range` request; a client must only append a response when it is a valid partial response for the same representation. Keep a `.part` archive keyed by the metadata checksum, request resume from the exact asset link, and fall back to a fresh transfer when the server does not honor the range. Always compare final byte length and SHA-256 before extracting. Do not extract a partial or hash-mismatched archive.

Check free space on the actual app-data volume using `GetDiskFreeSpaceExW`. Budget for the compressed archive, expanded JDK, and headroom; still handle a write failing after the preflight. Windows includes `curl` for HTTP, `tar` for ZIP extraction, and PowerShell's `Get-FileHash`/`certutil` for SHA-256, so Phase 3 can meet the scope without adding Rust crates. If an expected inbox tool is unavailable, return a clear platform error instead of silently succeeding.

## Minecraft Java requirement

The Mojang version manifest maps a version id to a version JSON URL. Read that JSON's `javaVersion.majorVersion` as the authority whenever present. The fallback below is only for metadata that lacks the field; unknown future versions must fail closed.

| Minecraft versions | Minimum Java fallback |
|---|---:|
| 1.8 through 1.16.5 | 8 |
| 1.17.x | 16 |
| 1.18 through 1.20.4 | 17 |
| 1.20.5 through 1.21.x | 21 |

When a fallback minimum is 16, the supported-runtime selector can provision Java 17. The Phase 3 Temurin allowlist remains 8/17/21. Mojang's Java 26.1 release notes specify Java 25; that version is outside the current catalogue and scope.

## Detection and validation

Candidate paths come from `JAVA_HOME`, `where.exe java.exe`, JavaSoft registry entries, and known Adoptium/Microsoft OpenJDK directories. Treat these sources as hints only: require an existing executable, run it to read `java.specification.version` and `sun.arch.data.model`, and verify compatibility with the selected Minecraft minimum. A chosen override must be a working 64-bit runtime with a sufficient major version. A server with no valid selection may use a detected compatible runtime; otherwise Start reports that Java must be installed or changed first.

Keep installed runtimes app-local and persist the selected executable path in the existing per-server `java_path` column. Do not mutate global environment variables or registry state.

## Sources

- [Adoptium API Cookbook](https://github.com/adoptium/api.adoptium.net/blob/main/docs/cookbook.adoc) and [API Swagger](https://api.adoptium.net/q/swagger-ui/)
- [Temurin archive installation](https://adoptium.net/installation/archives) and [Windows x64 release listings for Java 8](https://adoptium.net/temurin/releases/?arch=any&os=windows&version=8), [17](https://adoptium.net/temurin/releases/?arch=any&os=windows&version=17), [21](https://adoptium.net/temurin/releases/?arch=any&os=windows&version=21)
- [Mojang version manifest](https://piston-meta.mojang.com/mc/game/version_manifest_v2.json)
- Mojang release notes: [Java 16 in 1.17](https://feedback.minecraft.net/hc/en-us/articles/4402626897165-Minecraft-Caves-Cliffs-Part-1-1-17-Java), [Java 17 in 1.18](https://feedback.minecraft.net/hc/en-us/articles/4415128577293-Minecraft-Java-Edition-1-18), [Java 21 in 1.20.5](https://www.minecraft.net/en-us/article/minecraft-java-edition-1-20-5), and [Java 25 in 26.1](https://feedback.minecraft.net/hc/en-us/articles/44551668333837-Minecraft-Java-Edition-26-1)
- [RFC 9110 range requests](https://www.rfc-editor.org/rfc/rfc9110.html#name-range-requests)
- Microsoft docs: [curl on Windows](https://learn.microsoft.com/en-us/windows/curl/), [tar on Windows](https://learn.microsoft.com/en-us/windows/tar/), [Get-FileHash](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/get-filehash?view=powershell-5.1), [GetDiskFreeSpaceExW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getdiskfreespaceexw), and [Microsoft OpenJDK install behavior](https://learn.microsoft.com/en-us/java/openjdk/install)

## Implementation clarification after review

The fallback table above was researched for metadata that omits `javaVersion.majorVersion`. The implementation also uses that same fallback for a known Minecraft version when Mojang metadata is unreachable because of a network failure or HTTP 5xx, so Create/Settings can still resolve a known requirement. Available metadata remains authoritative: malformed metadata, HTTP 4xx, unknown versions, and an explicit unsupported major do not fall back. Start uses a separate local mapping for the current Create catalogue and does not make Mojang HTTP requests.
