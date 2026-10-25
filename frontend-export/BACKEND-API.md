# Framework-Neutral Backend API Specification

## Goal

Allow the exported React frontend to connect to any backend framework that implements one documented HTTP contract, while preserving desktop Tauri behavior.

## Runtime selection

- `backend-config.json` is loaded before React mounts.
- `apiBaseUrl` empty: preserve the existing browser mock mode.
- `apiBaseUrl` set: use browser HTTP mode for backend calls.
- Tauri runtime always uses native Tauri IPC, independent of the browser config.
- Static asset paths are relative so the export can be hosted from a root or subpath.

## RPC

`POST {apiBaseUrl}/rpc`

Request JSON:

```json
{"command":"servers_list","args":{}}
```

Success JSON:

```json
{"result":[]}
```

Error JSON:

```json
{"error":{"code":"validation","message":"Human-readable reason"}}
```

The server implements the command names currently exposed by `src/tauri.ts`: `ping`, `servers_list`, `server_get`, `servers_create`, `servers_delete`, `servers_set_java_path`, `java_detect`, `java_validate`, `java_ensure`, `versions_vanilla`, `versions_paper`, `loaders_resolve`, `modrinth_search_modpacks`, `modrinth_project_versions`, `modpack_pipeline_preview`, `modpack_pipeline_install`, `modpack_pipeline_cancel`, `modpack_pipeline_discard_preview`, `modpack_pipeline_release_local_mrpack`, `curseforge_list_zips`, `curseforge_inspect_zip`, `curseforge_cancel_download`, `server_install`, `server_install_cancel`, `server_start`, `server_stop`, `server_kill`, `server_restart`, `server_send_command`, `backup_now`, and `backup_restore`. Native picker and browser-opening commands are replaced by browser file input/external navigation. Keep arguments/results aligned with the TypeScript interfaces and Rust DTOs.

Some UI sections still use local mock data and do not yet call backend commands. They remain outside this API surface until corresponding typed frontend wrappers are added.

## Uploads

- `POST {apiBaseUrl}/uploads/modrinth-local` — multipart `file` (`.mrpack`), returns `{ "result": { "sourceId": "...", "fileName": "..." } }`.
- `POST {apiBaseUrl}/uploads/curseforge-server-zip` — multipart `file` (`.zip`), returns the staged ZIP DTO in the `result` envelope.

The backend validates file size/type and treats all uploaded archive contents as untrusted. Existing pipeline validation remains authoritative.

## Events

`GET {apiBaseUrl}/events?topic=<URL-encoded-topic>` with `Content-Type: text/event-stream`. Each update is an SSE `message` event whose `data` is JSON. The topic string is one of the existing channels: `server://log/{id}`, `server://status/{id}`, `job://progress/{jobId}`, or `curseforge://download`.

## Browser transport and security

- Send JSON commands with Fetch and `credentials: "include"` so same-site session-cookie deployments work.
- Use `EventSource` with credentials for event topics.
- Same-origin reverse proxying is preferred. Cross-origin services must allow only the exact deployed frontend origin and credentials; wildcard origins are not compatible with credentialed requests.
- Serve production deployments over HTTPS. Store secrets and authentication policy on the backend; do not embed backend secrets in the static frontend config.
- The backend validates authorization for each command and event topic; frontend route hiding is not authorization.

## Acceptance criteria

- Static build works under a relative path and reads runtime API configuration.
- The same typed frontend wrappers route to Tauri IPC in desktop mode and the HTTP contract in browser mode.
- Browser upload controls provide pack bytes through the documented multipart endpoints.
- Browser subscriptions receive server logs, status, job progress, and download progress through SSE.
- With no API base configured, existing browser mock mode remains available.
- OpenAPI document matches the implemented transport envelope and upload/event routes.
