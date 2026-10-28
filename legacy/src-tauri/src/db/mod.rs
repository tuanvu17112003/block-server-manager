//! SQLite open + migrations (schema v1/v3, backend-plan §Data model).
//!
//! Tables: `servers`, `backups`, `worlds`, `jobs`, `settings`, `console_command_history`, `managed_server_files`.
//! Keep migrations additive from day one — later phases ALTER, never drop.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::AppError;

/// Managed Tauri state: single SQLite connection behind a mutex.
/// (WAL + busy-timeout keep short UI-path writes from blocking.)
pub struct DbState(pub Mutex<Connection>);

/// Schema v1. `IF NOT EXISTS` keeps this idempotent across restarts.
const SCHEMA_V1: &str = "
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS servers (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  loader         TEXT NOT NULL,
  mc_version     TEXT NOT NULL,
  loader_version TEXT,
  modpack_id     TEXT,
  port           INTEGER NOT NULL UNIQUE,
  ram_mb         INTEGER NOT NULL,
  java_path      TEXT,
  eula_accepted  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'stopped',
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backups (
  id         TEXT PRIMARY KEY,
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  size_mb    REAL NOT NULL DEFAULT 0,
  path       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS worlds (
  id        TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  path      TEXT NOT NULL,
  size_mb   REAL NOT NULL DEFAULT 0,
  seed      TEXT NOT NULL DEFAULT '',
  active    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS jobs (
  id       TEXT PRIMARY KEY,
  kind     TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  log      TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
";

/// Schema v2. New tables stay additive so existing app databases upgrade in place.
const SCHEMA_V2: &str = "
CREATE TABLE IF NOT EXISTS console_command_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  command    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS console_command_history_server_id
  ON console_command_history (server_id, id DESC);
";

/// Schema v3. Ownership rows are additive and bound to a server plus the
/// canonical app-data root used when a file was installed.
const SCHEMA_V3: &str = "
CREATE TABLE IF NOT EXISTS managed_server_files (
  server_id       TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  canonical_root  TEXT NOT NULL,
  path_key        TEXT NOT NULL,
  relative_path   TEXT NOT NULL,
  installed_size  INTEGER NOT NULL CHECK (installed_size >= 0),
  installed_sha1  TEXT NOT NULL,
  installed_sha512 TEXT NOT NULL,
  plan_id         TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (server_id, path_key)
);

CREATE INDEX IF NOT EXISTS managed_server_files_server_id
  ON managed_server_files (server_id, path_key);
";

pub(crate) fn apply_migrations(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(SCHEMA_V1)?;
    conn.execute_batch(SCHEMA_V2)?;
    conn.execute_batch(SCHEMA_V3)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_v3_adds_managed_file_ownership_without_removing_prior_tables() {
        let conn = Connection::open_in_memory().unwrap();
        apply_migrations(&conn).unwrap();
        let table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('servers', 'backups', 'console_command_history', 'managed_server_files')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_count, 4);
        let columns = conn
            .prepare("PRAGMA table_info(managed_server_files)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            columns,
            [
                "server_id",
                "canonical_root",
                "path_key",
                "relative_path",
                "installed_size",
                "installed_sha1",
                "installed_sha512",
                "plan_id",
                "updated_at"
            ]
        );
    }
}

/// Open (creating parent dirs) and apply additive schemas.
pub fn open_and_migrate(db_path: &Path) -> Result<Connection, AppError> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(db_path)?;
    apply_migrations(&conn)?;
    Ok(conn)
}
