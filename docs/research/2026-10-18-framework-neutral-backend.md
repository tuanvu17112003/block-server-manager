# Framework-Neutral Backend Deployment Research

## Finding

The frontend is currently a Tauri client. Persistence, process lifecycle, Java discovery, modpack installation, and progress/log events are Tauri commands/events. A static Vite bundle by itself cannot connect to a remotely deployed Rust process manager. To support another backend framework, the frontend needs a stable HTTP contract and a runtime-configured API origin; each backend framework must implement that same contract.

## Contract choice

- Use HTTP JSON RPC for the existing command surface. This avoids binding the browser app to a particular server framework or duplicating dozens of client methods into a framework-specific SDK.
- Use Server-Sent Events for server logs, lifecycle status, job progress, and CurseForge transfer progress. SSE is browser-native and supports one-way server-to-client event streams.
- Use multipart upload endpoints for `.mrpack` and CurseForge server ZIP inputs because browser deployments cannot open native desktop file dialogs.
- Configure the API base at runtime from a copied `backend-config.json`, so a single static export can point at different compatible deployments.
- Prefer serving the API under the same origin as the static files. Cross-origin deployments must configure exact-origin CORS and credentials; never wildcard credentialed origins. Browser Fetch enforces CORS.
- Keep the existing Tauri transport for desktop mode. The browser transport is an additional adapter over the same typed frontend wrappers.

## Boundaries

This makes the frontend compatible with any backend framework that implements the documented versioned API contract. It does not convert the current Rust/Tauri backend into a remote HTTP service. It also does not expose filesystem access to the browser: local packs are uploaded to the backend, and Java/process operations execute on the backend host.

## Sources

- Vite [production builds and relative base paths](https://vite.dev/guide/build#relative-base).
- MDN [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch) and its CORS behavior.
- MDN [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events).
- OpenAPI Initiative [OpenAPI Specification 3.1.2](https://spec.openapis.org/oas/v3.1.2.html).
