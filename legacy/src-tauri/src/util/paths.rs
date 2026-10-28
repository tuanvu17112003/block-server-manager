//! Shared path helpers: app-data dir, per-server dirs, DB + log paths.
//!
//! Per-server folder: `<app-data>/servers/<id>/`
//! (`server.jar`, `mods/`, `world/`, `server.properties`, `eula.txt`,
//! `logs/`, `backups/`, `installer.log` — scaffolded on create, Phase 1).

use std::path::{Path, PathBuf};

use crate::error::AppError;

/// Resolve the app-data dir for `app.db`, `servers/`, `logs/`.
pub fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    use tauri::Manager;
    Ok(app.path().app_data_dir()?)
}

/// `<app-data>/servers/`
pub fn servers_dir(app_data: &Path) -> PathBuf {
    app_data.join("servers")
}

/// `<app-data>/servers/<id>/` — rejects path separators (never trust ids).
pub fn server_dir(app_data: &Path, id: &str) -> Result<PathBuf, AppError> {
    validate_id(id)?;
    Ok(servers_dir(app_data).join(id))
}

/// `<app-data>/app.db`
pub fn db_path(app_data: &Path) -> PathBuf {
    app_data.join("app.db")
}

/// `<app-data>/logs/` → contains `launcher.log` (daily rotation).
pub fn logs_dir(app_data: &Path) -> PathBuf {
    app_data.join("logs")
}

/// Create the top-level dirs (per-server dirs are scaffolded on create).
pub fn ensure_dirs(app_data: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(servers_dir(app_data))?;
    std::fs::create_dir_all(logs_dir(app_data))?;
    Ok(())
}

/// Server ids are uuid v4 hex (`xxxxxxxx-...`); refuse anything that could
/// escape the per-server folder (separators, `..`, empty).
pub fn validate_id(id: &str) -> Result<(), AppError> {
    if id.is_empty() || id.len() > 64 {
        return Err(AppError::Validation("invalid server id".to_string()));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::Validation("invalid server id".to_string()));
    }
    Ok(())
}
