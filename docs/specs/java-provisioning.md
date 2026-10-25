# Specification — Java Provisioning (Backend Phase 3)

## Goal

Select a compatible 64-bit Java runtime for each server, detect user-installed Java, and install Temurin on demand when no compatible runtime is available. Keep the runtime path attached to the server record so process launch is deterministic.

## Supported scope

- Windows x64; app-managed Temurin JDK ZIPs for Java 8, 17, 21, and 25.
- Minecraft requirement comes from the selected release's Mojang version JSON `javaVersion.majorVersion`. For a known version, use the documented fallback if that field is absent or Mojang metadata cannot be reached because of a network failure or HTTP 5xx response. Mojang metadata stays authoritative when available: malformed metadata, an unknown version, HTTP 4xx, and an explicitly unsupported Java requirement fail without fallback.
- Create discovers every official Mojang release. Minecraft 26.1 is supported with Java 25. If Mojang declares a Java major beyond the app's supported runtime set, report that the app needs an update.
- Do not modify global PATH, `JAVA_HOME`, JavaSoft registry values, or install into machine-wide directories.
- Browser development keeps existing mock behavior.

## User flows

### Create

1. When the Minecraft version changes, resolve its required Java major and inspect installed candidates.
2. Show the required major and selected runtime (for example, “Java 17 · Temurin · auto”). If none is compatible, offer “Install Temurin Java N”.
3. Emit real progress while downloading and verifying the archive. On completion, keep the resulting `java.exe` path in the pending server configuration.
4. “Change…” reveals a path override field. Accept either a `java.exe` path or a JDK home directory; validate it before use.
5. Include the selected path in `servers_create` so `java_path` is saved with the new server.

### Existing server Settings

1. Display the server's configured/detected runtime and required major.
2. Let the user install the matching supported Temurin runtime or enter a path override.
3. Validate and persist the path on the stopped server. Switching servers resets transient UI state.
4. Surface backend validation errors through the existing toast path.

### Start

- Resolve the Java minimum from the local mapping for the current Create catalogue and validate the executable locally. Start must not request Mojang metadata or wait on Mojang network access.
- If `java_path` is set, validate that executable's major and architecture before launch.
- If it is unset, detect a compatible local runtime and use it; otherwise return a clear error directing the user to install/change Java in Create or Settings.
- Reject missing, non-running, 32-bit, or too-old Java. Never launch a known-incompatible runtime.
- Unknown Minecraft versions fail closed at Start until the local catalogue mapping is updated. Mojang metadata remains authoritative when Create/Settings detect requirements or validate a selected override.

The local Start mapping covers current release families and the Java requirement introduced by Minecraft 26.1:

| Minecraft version | Minimum Java |
|---|---:|
| Releases before 1.17 when no metadata is available | 8 |
| 1.17.x | 16 |
| 1.18 through 1.20.4 | 17 |
| 1.20.5 through 1.21.x | 21 |
| 26.1.x | 25 |

For a Java 16 minimum, the app provisions Java 17 as the nearest supported compatible Temurin runtime.

## Backend behavior

- `java_detect(mc_version)` returns the metadata/fallback requirement plus compatible candidate details.
- `java_ensure(major, job_id)` accepts only 8/17/21/25, reuses an installed matching app-managed runtime, or downloads the latest GA Windows x64 Temurin JDK ZIP.
- Use Adoptium asset metadata for the exact package link, expected size, package name, and SHA-256. Store partial bytes under a checksum-derived filename and resume only when the transfer resumes the same asset correctly. Verify complete size and hash before extraction; extract into a staging directory and publish only after `bin/java.exe` validates.
- Check free space before downloading and preserve resumable partial data after transient network failures. Delete partial data after a checksum mismatch.
- Emit `job://progress/{jobId}` updates with progress and plain status/log text. Do not include tokens or secrets.
- `servers_set_java_path(id, path)` validates the server is stopped, validates the runtime against the server's Minecraft requirement, then updates the existing SQLite `java_path` column.
- `server_start` uses the recorded path or a validated compatible detected runtime; it reports a user-facing error when neither exists.

## Acceptance criteria

- A clean Windows x64 machine can install and use the correct runtime for legacy releases (8), 1.20.1 (17), 1.21 (21), and 26.1 (25).
- Metadata is authoritative; fallback does not guess unknown future requirements.
- The known-release fallback keeps Create/Settings requirement resolution available during Mojang network failures. Start uses a local mapping for current official release families; an explicit unsupported Mojang Java major still fails closed during selection and override validation.
- Downloads can resume when the asset server accepts byte ranges, and restart safely when it does not.
- SHA-256 mismatch, insufficient disk space, missing inbox tools, unsupported major, and invalid override each fail clearly without installing an unverified runtime.
- Java paths persist after application restart and the process manager rejects an incompatible runtime.
- Create and Settings show download progress and a usable override; browser mocks continue to work.
