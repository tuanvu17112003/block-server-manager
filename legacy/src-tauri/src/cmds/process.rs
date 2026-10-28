//! Phase 2 IPC: `server_start/stop/kill/restart`, `server_send_command`.
//!
//! Commands are `async` so they run off the main thread, and they return
//! fast: staging work (spawn, stdin write, kill signal) happens inline so
//! validation errors (`eula`, `not-found`, `conflict`, `io`) reach the UI as
//! toastable `AppError`s, while completion (`running`/`stopped`/`crashed` +
//! log lines) arrives via `server://status/{id}` / `server://log/{id}` events.

use tauri::AppHandle;

use crate::error::AppError;
use crate::servers::process;

#[tauri::command]
pub async fn server_start(app: AppHandle, id: String) -> Result<(), AppError> {
    process::start_live_server(&app, &id)?;
    Ok(())
}

#[tauri::command]
pub async fn server_stop(app: AppHandle, id: String) -> Result<(), AppError> {
    process::stop_live_server(&app, &id)
}

#[tauri::command]
pub async fn server_kill(app: AppHandle, id: String) -> Result<(), AppError> {
    process::kill_live_server(&app, &id)
}

#[tauri::command]
pub async fn server_restart(app: AppHandle, id: String) -> Result<(), AppError> {
    process::restart_live_server(&app, &id)
}

#[tauri::command]
pub async fn server_send_command(app: AppHandle, id: String, cmd: String) -> Result<(), AppError> {
    process::send_to_live_server(&app, &id, &cmd)
}
