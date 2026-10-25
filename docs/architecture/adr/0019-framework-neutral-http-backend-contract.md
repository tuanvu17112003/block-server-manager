# ADR-0019: Framework-Neutral HTTP Backend Contract

## Status

Accepted

## Context

The React frontend currently calls Rust functions through Tauri IPC. The built Vite files can be copied and served statically, but a normal browser cannot invoke Tauri commands. The user wants to deploy the frontend separately and choose a backend framework.

## Decision

Define a versioned, framework-neutral browser API under `/api/v1`:

- `POST /rpc` accepts `{ command, args }` and returns `{ result }` or `{ error: { code, message } }`.
- `GET /events?topic=<topic>` streams the existing event payloads as SSE `message` events containing JSON data.
- `POST /uploads/modrinth-local` and `POST /uploads/curseforge-server-zip` accept multipart field `file` and return the same selection/staging DTOs used by desktop mode.
- The API base URL is read from runtime `backend-config.json`; an empty value retains browser mock mode. Same-origin `/api/v1` is the recommended deployment. Cross-origin backends must implement exact-origin CORS and cookie credential support.
- Tauri desktop mode continues to call the existing Tauri IPC transport. Browser API mode uses HTTP and uploads.

Any backend language/framework may implement this contract. The current Rust process manager remains a Tauri backend and does not gain network endpoints in this decision.

## Consequences

- Backend framework choices are decoupled from the frontend through the published API contract.
- Remote backends own server files, Java installs, uploaded packs, and Minecraft processes on the backend host.
- Browser local file inputs replace native picker dialogs for remote mode.
- Deployments must protect the API with their chosen authentication, restrict CORS to trusted origins, and serve frontend/API over HTTPS outside localhost.
- An OpenAPI description documents the HTTP surface; command-specific JSON payloads remain aligned with the existing typed Tauri DTO contract.
