# Framework-Neutral Backend Frontend Adapter

## Owned paths

- `src/tauri.ts`
- `src/backend/**`
- `src/main.tsx`
- `src/store.tsx`, `src/App.tsx`, `src/tabs/Create.tsx`, `src/tabs/Settings.tsx`
- `vite.config.ts`, `public/backend-config.json`, `frontend-export/**`
- `docs/api/openapi.yaml` and backend-deployment docs

## Sequence

1. Add runtime config loading before React mounts and relative Vite asset paths.
2. Add a single browser HTTP transport for command RPC, normalized errors, multipart uploads, and SSE subscriptions.
3. Route existing typed wrappers through Tauri in desktop mode, HTTP when runtime API config is set, and existing mocks only when no backend is configured.
4. Separate `isTauri()` OS/dialog decisions from `hasBackend()` UI/data decisions.
5. Use browser file inputs plus upload endpoints for local mrpack and CurseForge server ZIP in HTTP mode; use `window.open` for external CurseForge browsing.
6. Switch store hydration, process actions, live logs/status, and Java controls to backend mode when configured.
7. Generate a fresh `frontend-export/` with runtime config and deployment instructions.
8. Type/build check and inspect the static export. Do not create a fake remote backend or claim deployment against an unimplemented server.

## Quality gates

- OpenAPI and prose contract agree on request/response/event shapes.
- Production bundle uses relative assets and contains `backend-config.json`.
- `npm run build` passes.
- No browser backend configuration means existing mock behavior remains.
- Tauri mode still uses native commands and native pickers.
- Review all `isTauri()` gates to ensure only native capabilities remain desktop-specific.

## Verification record — 2026-10-18

- `npm run build`: PASS (TypeScript and Vite production bundle).
- Static export: 12 production files in `frontend-export/` match `dist/` byte-for-byte by SHA-256; `index.html` uses relative JS/CSS asset references.
- Export includes runtime `backend-config.json`, same-origin example config, `BACKEND-API.md`, and the matching OpenAPI document.
- No HTTP backend service was available in this project, so no live remote-backend integration was claimed. A compatible service must implement the published contract.
