//! Phase 1 IPC: `servers_list`, `server_get`, `servers_create`, `servers_delete`.
//!
//! These replace the `initialServers` / `addServer` mocks (`store.tsx`)
//! once the frontend wires the store to them (later phase — Phase 0+1
//! ships no UI behaviour change).

use tauri::{AppHandle, Manager, State};

use crate::db::DbState;
use crate::error::AppError;
use crate::servers::{self, CreateServerInput, ServerRecord};
use crate::util::paths;

#[tauri::command]
pub fn servers_list(state: State<'_, DbState>) -> Result<Vec<ServerRecord>, AppError> {
    let conn = state.0.lock()?;
    servers::list_servers(&conn)
}

#[tauri::command]
pub fn server_get(state: State<'_, DbState>, id: String) -> Result<ServerRecord, AppError> {
    let conn = state.0.lock()?;
    servers::get_server(&conn, &id)
}

#[tauri::command]
pub fn servers_create(
    app: AppHandle,
    state: State<'_, DbState>,
    input: CreateServerInput,
) -> Result<ServerRecord, AppError> {
    let app_data = paths::app_data_dir(&app)?;
    let conn = state.0.lock()?;
    servers::create_server(&conn, &app_data, input)
}

#[tauri::command]
pub fn servers_set_java_path(
    app: AppHandle,
    state: State<'_, DbState>,
    id: String,
    path: Option<String>,
) -> Result<ServerRecord, AppError> {
    let current = {
        let conn = state.0.lock()?;
        servers::get_server(&conn, &id)?
    };
    let validated_path = path
        .filter(|path| !path.trim().is_empty())
        .map(|path| {
            crate::java::validate_java_for_version(&path, &current.mc_version)
                .map(|candidate| candidate.path)
        })
        .transpose()?;

    // Hold the process start reservation while writing so a concurrent start
    // cannot begin between the stopped check and this update.
    servers::process::with_server_stopped(&app, &id, || {
        let conn = state.0.lock()?;
        servers::set_server_java_path(&conn, &id, validated_path.as_deref())
    })
}

#[tauri::command]
pub fn servers_delete(
    app: AppHandle,
    state: State<'_, DbState>,
    id: String,
) -> Result<(), AppError> {
    // Phase 2: refuse to delete a running server — removing its folder would
    // orphan the live `java` child (stop/kill first).
    let live = app
        .state::<servers::process::ProcessState>()
        .0
        .lock()
        .map(|m| m.contains_key(&id))
        .unwrap_or(false);
    if live {
        return Err(AppError::Conflict(
            "stop the server before deleting it".to_string(),
        ));
    }
    let app_data = paths::app_data_dir(&app)?;
    let conn = state.0.lock()?;
    servers::delete_server(&conn, &app_data, &id)
}
