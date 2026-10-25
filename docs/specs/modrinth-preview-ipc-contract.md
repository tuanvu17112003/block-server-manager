# Modrinth Preview IPC Contract

## Purpose

Ensure the Create wizard can pass its typed pack-source selection to the Rust preview command without losing field names at the Tauri/Serde boundary.

## Contract

- The source request remains a `kind`-tagged union with `modrinthRemote`, `localMrpack`, and `curseForgeServerZip` variants.
- The frontend wire fields use camelCase: remote uses `projectId`, `versionId`, and `javaPath`; local uses `sourceId`; CurseForge uses `zipName`.
- Rust deserializes all struct-variant fields with the same camelCase names. `loader` remains a nested camelCase `LoaderPin` object.
- A remote preview resolves the exact selected provider project/version and then performs the existing archive integrity checks.
- IPC failures surfaced to Create preserve the backend message whether Tauri rejects with an object or a primitive string.

## Acceptance criteria

- Rust tests deserialize the remote, local, and CurseForge source variants from frontend-shaped camelCase JSON.
- A bridge reproduction with the screenshot's Modrinth project/version reaches provider resolution instead of failing with a missing snake_case field.
- A deliberately malformed IPC source retains its Tauri error text in the UI.
- The reproduction uses isolated app data and does not install a pack or start a server.
