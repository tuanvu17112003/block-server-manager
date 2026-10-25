#![allow(dead_code)]
//! Phase 5 (stub) — modpack sources (Modrinth-first, CurseForge-gated).
//!
//! Modrinth v2 search/project/version/download (open, `User-Agent` header,
//! 300/min etiquette); CurseForge v1 behind a USER-supplied key stored in
//! the OS keyring — the key NEVER ships in the binary. `.mrpack` + CF
//! manifest extraction; `modpack_install` as a cancellable job emitting
//! `job://progress/{jobId}`.
