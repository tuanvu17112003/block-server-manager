# Framework-neutral frontend export

This is the production frontend build. Copy the whole directory, keeping `index.html`, `assets/`, and `backend-config.json` together. The bundle uses relative asset paths and can be hosted at a domain root or under a subpath.

## Configure a backend

Edit `backend-config.json` and set `apiBaseUrl` to the versioned API base. Use `/api/v1` when a reverse proxy serves the API on the same origin; use an absolute HTTPS URL for another host. `backend-config.example.json` shows the same-origin setting. Reload after changing the config.

Any language/framework may implement the backend if it follows `BACKEND-API.md` and `backend-openapi.yaml`:

- `POST /rpc` dispatches the typed command names and returns `{ "result": ... }` or `{ "error": { "code", "message" } }`.
- `GET /events?topic=...` streams logs, server status, job progress, and download progress as Server-Sent Events.
- Multipart upload routes accept local `.mrpack` files and author-provided CurseForge server ZIPs.

Serve production deployments over HTTPS. Same-origin reverse proxying is simplest. Cross-origin services must allow the exact frontend origin and credentialed Fetch/SSE requests. Do not place backend secrets in this public config file; use a server session cookie and authorize every command and event topic.

## What the backend runs

In browser/API mode, server processes, Java management, pack staging, and uploaded files belong to the configured backend host. The current Rust/Tauri app remains a desktop backend; this change does not turn it into an HTTP service. A separately deployed service must implement the published contract. UI panels that do not yet call typed backend commands remain on their existing mock data.

## Desktop Tauri builds

The same frontend source retains native Tauri IPC mode. To bundle this export with another Tauri checkout, point `src-tauri/tauri.conf.json` `build.frontendDist` at this directory, then build the Tauri app. Native file pickers remain active in Tauri; browser mode uploads selected files.

## Rebuild

From the source project root, run `npm run build`, then copy the contents of `dist/` into this directory and refresh `BACKEND-API.md`, `backend-openapi.yaml`, and this README if the API contract changes.