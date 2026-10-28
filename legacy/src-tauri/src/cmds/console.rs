//! Phase 6 IPC for persisted console history and server log tails.

use tauri::{AppHandle, State};

use crate::db::DbState;
use crate::error::AppError;
use crate::servers::{self, console::CommandHistoryEntry};
use crate::util::paths;

#[tauri::command]
pub fn logs_tail(
    app: AppHandle,
    state: State<'_, DbState>,
    id: String,
    limit: Option<usize>,
) -> Result<Vec<String>, AppError> {
    {
        let conn = state.0.lock()?;
        servers::get_server(&conn, &id)?;
    }
    let app_data = paths::app_data_dir(&app)?;
    servers::console::logs_tail(
        &app_data,
        &id,
        limit.unwrap_or(servers::console::DEFAULT_LOG_TAIL_LINES),
    )
}

#[tauri::command]
pub fn server_command_history(
    state: State<'_, DbState>,
    id: String,
    limit: Option<usize>,
) -> Result<Vec<CommandHistoryEntry>, AppError> {
    let conn = state.0.lock()?;
    servers::get_server(&conn, &id)?;
    servers::console::command_history(
        &conn,
        &id,
        limit.unwrap_or(servers::console::MAX_COMMAND_HISTORY),
    )
}
