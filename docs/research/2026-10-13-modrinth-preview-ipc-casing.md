# Modrinth Preview IPC Casing Diagnosis

## Reported symptom

The Create wizard displays the selected Modrinth pack/version but review fails with the generic toast “Could not review the selected modpack.” The user reports this for all Modrinth packs.

## Reproduction evidence

- The screenshot identifies Cobblemon Official Modpack [Fabric], version 1.8.2 for Minecraft 1.21.1/Fabric. The UI's exact Modrinth version ID is `BpTjgzL8`; the Modrinth project ID is `5FFgwNNP`.
- In a debug Tauri instance with a unique identifier and dedicated `appDirectoriesOverride` scratch root, invoking `modpack_pipeline_preview` with the camelCase payload shape used by `src/tauri.ts` failed before entering the command handler: `invalid args source ... missing field project_id`.
- A direct `window.__TAURI__.core.invoke(...)` reproduction confirmed Tauri rejects with a primitive JavaScript string. `Create.tsx`'s `errorText` only reads an object's `message` property, so it replaces that useful deserialization error with the generic fallback.

## Root cause

`PipelineSourceRequest` is an internally tagged Serde enum with struct variants. Its existing `#[serde(rename_all = "camelCase")]` changes enum variant names; it does not rename fields in each struct variant. The TypeScript discriminated union sends `projectId`, `versionId`, and `javaPath`, while Rust expects `project_id`, `version_id`, and `java_path`. The local and CurseForge variants have the same mismatch for `sourceId`/`source_id` and `zipName`/`zip_name`.

Use `rename_all_fields = "camelCase"` on the enum. Serde documents this container attribute for applying field renaming to every struct variant. Also preserve primitive string rejections in the frontend error formatter so any future IPC argument error remains visible.

## Scope and validation

Fix only the shared source-request wire contract and error display. Add Rust deserialization regressions for all three variants using the exact frontend field names. Reproduce the remote Modrinth preview against the screenshot's exact pin using isolated app data; do not invoke installation or start a server during the bridge repro.

## Sources

- Serde [container attributes](https://serde.rs/container-attrs.html) (`rename_all_fields`).
- Serde [variant attributes](https://serde.rs/variant-attrs.html) (`rename_all` on struct variants).
- Modrinth official project API: `https://api.modrinth.com/v2/project/cobblemon-fabric` (project ID `5FFgwNNP`).
- Modrinth official [project versions page](https://modrinth.com/modpack/cobblemon-fabric/versions); the exact version ID `BpTjgzL8` was read from the supplied screenshot and confirmed by the successful isolated API preview.
