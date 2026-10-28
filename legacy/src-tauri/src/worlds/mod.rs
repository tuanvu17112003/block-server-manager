#![allow(dead_code)]
//! Phase 8 (stub) — worlds, backups, settings/files.
//!
//! World discovery via `level.dat` scan; activate stopped-only with
//! auto-backup; `.zip` import validated on `level.dat`; backup via
//! save-off/flush/zip/save-on with progress events + retention prune;
//! restore stop→validate→replace; `server.properties` subset read/write
//! + validation + restart-required flag; `server-icon.png` 64×64 validate.
