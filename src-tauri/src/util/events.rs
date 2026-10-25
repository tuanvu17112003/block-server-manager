//! Event channel names (backend-plan Phase 0 binding).
//!
//! - `server://log/{id}` — stdout/stderr lines (Phase 2/6).
//! - `server://status/{id}` — lifecycle transitions (Phase 2).
//! - `server://players/{id}` — roster snapshots (Phase 7).
//! - `job://progress/{jobId}` — install/backup progress (Phase 4/5/8).
//! - `metrics://tick/{id}` — sampled stats (Phase 9).
//!
//! Emit from Rust with `app.emit(&name, payload)` (`tauri::Emitter`);
//! subscribe from the frontend with `listen()` (`@tauri-apps/api/event`).

/// `server://log/{server_id}`
pub fn server_log_event(server_id: &str) -> String {
    format!("server://log/{server_id}")
}

/// `server://status/{server_id}`
pub fn server_status_event(server_id: &str) -> String {
    format!("server://status/{server_id}")
}

/// `server://players/{server_id}` (Phase 7)
pub fn server_players_event(server_id: &str) -> String {
    format!("server://players/{server_id}")
}

/// `job://progress/{job_id}`
pub fn job_progress_event(job_id: &str) -> String {
    format!("job://progress/{job_id}")
}

/// `metrics://tick/{server_id}` (Phase 9)
pub fn metrics_tick_event(server_id: &str) -> String {
    format!("metrics://tick/{server_id}")
}
