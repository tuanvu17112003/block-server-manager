//! Structured file logging → `<app-data>/logs/launcher.log` (daily rotation).
//!
//! Never log secrets: no RCON passwords, no CurseForge API keys,
//! no full command lines containing credentials.

use std::path::Path;

use tracing_subscriber::EnvFilter;

/// Initialise process-wide tracing once. Safe to call early in `setup`
/// (subsequent calls are ignored via `try_init`).
pub fn init_file_logging(app_data: &Path) {
    let logs_dir = crate::util::paths::logs_dir(app_data);
    if std::fs::create_dir_all(&logs_dir).is_err() {
        return;
    }
    let file_appender = tracing_appender::rolling::daily(&logs_dir, "launcher.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    // Worker guard must live for the whole process; leaking is intentional.
    Box::leak(Box::new(guard));

    let _ = tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::new("info"))
        .with_writer(non_blocking)
        .with_ansi(false)
        .try_init();

    tracing::info!("launcher log started");
}
