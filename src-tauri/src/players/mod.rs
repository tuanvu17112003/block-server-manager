#![allow(dead_code)]
//! Phase 7 (stub) — players.
//!
//! Read/write `whitelist.json`/`ops.json`/`banned-players.json`/
//! `banned-ips.json`; live-apply via RCON, file-edit when stopped;
//! Mojang name→UUID resolve with cache; offline roster from
//! `usercache.json` (+ playerdata NBT later).
