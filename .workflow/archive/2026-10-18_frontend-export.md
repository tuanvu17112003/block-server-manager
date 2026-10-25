# WORKFLOW_STATE

## Current Goal
Export the production frontend into a separate copyable directory and document its deployment boundary.

## Acceptance Criteria
- [x] Production frontend assets are in `frontend-export/` with `index.html` and required assets.
- [x] Export README explains Tauri IPC coupling and how to attach the assets to another Tauri backend build.
- [x] Build output matches the export contents.

## Status
Phase: Done
Last updated: 2026-10-18
Owner: PQM
Active Task ID: frontend-export

## Active Plan
1. [x] Inspect frontend/backend boundary and build configuration.
2. [x] Build the production frontend.
3. [x] Copy the built assets to a standalone export directory and document use.
4. [x] Verify the exported file set: 10 asset files SHA-256 match `dist/`; HTML references bundled JS and CSS.

## Decisions
- The current Rust backend is registered as Tauri invoke commands, not a standalone HTTP API.
- The export is the built frontend asset directory for copying/rebundling; static hosting does not independently connect to the Rust backend.