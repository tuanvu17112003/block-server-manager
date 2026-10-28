#![allow(dead_code)]
//! Phase 9 (stub) — metrics.
//!
//! Per-PID CPU/RAM, disk usage, uptime; players via RCON `list`/Query;
//! TPS/MSPT only where available (Paper `tps`, spark) else `null` → the
//! existing "needs RCON" hint. 1-min samples, 7-day retention.
