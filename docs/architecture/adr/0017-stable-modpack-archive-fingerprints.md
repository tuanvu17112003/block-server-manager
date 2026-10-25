# ADR-0017: Stable modpack archive fingerprints

**Status:** Accepted

## Context

Provider pins and per-file decisions must describe the same archive bytes. Running `certutil.exe` twice by executable name permits separate reads and does not bind execution to the system binary. Hashing an original file separately from ZIP inspection also leaves a time-of-check gap.

## Decision

Preflight free space on the temporary volume, then create the bounded private snapshot with a handle whose sharing mode denies other handles write/delete access. While copying, calculate SHA-1 and SHA-512 from the same byte chunks with Windows CNG. Retain that handle through ZIP classification and manifest parsing, and do not write through it after the copy. For remote Modrinth, require the calculated size and hashes to match its exact version metadata before continuing. For local Modrinth and CurseForge archives, record the calculated fingerprint as a source fingerprint only. Check cancellation during copying and between parser/selection stages; drop the snapshot on cancellation and every error path.

Do not execute an external hash utility and do not add a hashing dependency.

## Consequences

The provider plan and archive fingerprint are tied to one staged byte stream. Temporary snapshots must be created without following reparse points, enforce the existing compressed-size limit, and be cleaned up on cancellation or failure. File-download metadata must not include unresolved `AwaitingUserChoice` entries. A local fingerprint identifies the bytes inspected; it does not establish who authored them.
