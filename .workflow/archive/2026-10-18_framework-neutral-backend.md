# WORKFLOW_STATE

## Current Goal
Make the static frontend configurable for any backend framework implementing a documented, versioned HTTP RPC/SSE/upload contract, while preserving desktop Tauri and browser mock modes.

## Acceptance Criteria
- [x] Static assets use relative base paths and load `backend-config.json` at runtime.
- [x] Typed backend wrappers use Tauri IPC in desktop, HTTP when configured, and existing mocks when no remote backend is configured.
- [x] Browser mode supports RPC errors, SSE log/status/job/download events, and multipart local pack uploads.
- [x] App/store/Create/Settings route backend-dependent flows through the new backend mode while native dialogs remain Tauri-specific.
- [x] API contract is published as OpenAPI and explains CORS/session-cookie deployment.
- [x] Fresh `frontend-export/` includes the runtime config and deployment guide.
- [x] `npm run build` passes and the bundle was inspected for relative asset paths/config file.
- [x] Compatible-backend boundary is documented; the existing Tauri backend was not converted to HTTP.

## Status
Phase: Done
Last updated: 2026-10-18
Owner: PQM
Active Task ID: framework-neutral-backend

## Active Plan
1. [x] Read workflow and map the existing Tauri/frontend boundary with CodeGraph.
2. [x] Research Fetch, CORS, SSE, Vite relative builds, and OpenAPI.
3. [x] Materialize ADR, API spec, OpenAPI, research, and implementation plan.
4. [x] Implement runtime-configured HTTP RPC/SSE/upload client and preserve Tauri transport.
5. [x] Update app/store/Create/Settings browser-backend gating and remote file selection.
6. [x] Build and verify fresh export.

## Decisions
- “Any backend framework” means a backend in any language/framework that implements the published `/api/v1` contract, not arbitrary undocumented endpoints.
- The current Rust/Tauri process manager is not being converted into an HTTP server by this task.
- Browser-mode local `.mrpack` and server ZIP files upload to the configured backend; process management and Java operations execute on that backend host.
- Same-origin reverse proxy is the recommended deployment; cross-origin services must use explicit CORS origins and credential handling.

## Quality Gate Results
- Research/docs gate: PASS before implementation.
- `npm run build`: PASS (TypeScript and Vite production build).
- Export verification: 12 production files match `dist/` by SHA-256; relative asset paths, runtime config, and exported API docs present.
- No compatible HTTP backend service exists in this workspace; real service integration remains a separate deployable component, not a verified runtime result.
