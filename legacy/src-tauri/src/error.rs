//! Unified backend error, surfaced to the frontend as a toastable
//! `{code, message}` object (backend-plan Phase 0 binding).
//!
//! Binding rules that apply to every phase:
//! - EULA is NEVER auto-accepted (refused at `server_start`, Phase 2).
//! - RCON binds `127.0.0.1` only; generated passwords are NEVER logged.
//! - No Mojang assets/fonts bundled; no secrets ship in the binary.

use serde::ser::{Serialize, SerializeStruct, Serializer};

/// Stable error codes. The UI maps these to toasts — do not rename casually.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Validation(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("database error: {0}")]
    Db(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Validation(_) => "validation",
            AppError::NotFound(_) => "not-found",
            AppError::Conflict(_) => "conflict",
            AppError::Io(_) => "io",
            AppError::Db(_) => "db",
            AppError::Internal(_) => "internal",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut out = serializer.serialize_struct("AppError", 2)?;
        out.serialize_field("code", self.code())?;
        out.serialize_field("message", &self.to_string())?;
        out.end()
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Db(e.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(e: tauri::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl<T> From<std::sync::PoisonError<T>> for AppError {
    fn from(_: std::sync::PoisonError<T>) -> Self {
        AppError::Internal("database lock poisoned".to_string())
    }
}
