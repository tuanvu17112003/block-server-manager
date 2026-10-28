//! Console history and bounded reads from a server's native log file.

use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::error::AppError;
use crate::util::paths;

pub const DEFAULT_LOG_TAIL_LINES: usize = 1_000;
pub const MAX_LOG_TAIL_LINES: usize = 10_000;
pub const MAX_COMMAND_HISTORY: usize = 100;

const LOG_READ_CHUNK_BYTES: usize = 8 * 1024;
const MAX_LOG_READ_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistoryEntry {
    pub command: String,
    pub created_at: String,
}

pub fn validate_command(command: &str) -> Result<&str, AppError> {
    let line = command.trim();
    if line.is_empty() {
        return Err(AppError::Validation("command is empty".to_string()));
    }
    if line.chars().any(|c| c == '\n' || c == '\r') {
        return Err(AppError::Validation(
            "command must be a single line".to_string(),
        ));
    }
    Ok(line)
}

pub fn logs_tail(
    app_data: &Path,
    id: &str,
    requested_limit: usize,
) -> Result<Vec<String>, AppError> {
    paths::validate_id(id)?;
    let limit = requested_limit.min(MAX_LOG_TAIL_LINES);
    if limit == 0 {
        return Ok(Vec::new());
    }
    let Some((path, log_root)) = latest_log_path(app_data, id)? else {
        return Ok(Vec::new());
    };
    tail_log_file(&log_root, &path, limit)
}

pub fn command_history(
    conn: &Connection,
    id: &str,
    requested_limit: usize,
) -> Result<Vec<CommandHistoryEntry>, AppError> {
    paths::validate_id(id)?;
    let limit = requested_limit.min(MAX_COMMAND_HISTORY);
    if limit == 0 {
        return Ok(Vec::new());
    }

    let mut statement = conn.prepare(
        "SELECT command, created_at FROM console_command_history \
         WHERE server_id = ?1 ORDER BY id DESC LIMIT ?2",
    )?;
    let rows = statement.query_map(params![id, limit as i64], |row| {
        Ok(CommandHistoryEntry {
            command: row.get(0)?,
            created_at: row.get(1)?,
        })
    })?;
    let mut history = Vec::new();
    for row in rows {
        history.push(row?);
    }
    Ok(history)
}

pub fn record_command(conn: &mut Connection, id: &str, command: &str) -> Result<(), AppError> {
    paths::validate_id(id)?;
    let line = validate_command(command)?;
    let created_at = Utc::now().to_rfc3339();
    let transaction = conn.transaction()?;
    transaction.execute(
        "INSERT INTO console_command_history (server_id, command, created_at) \
         VALUES (?1, ?2, ?3)",
        params![id, line, created_at],
    )?;
    transaction.execute(
        "DELETE FROM console_command_history \
         WHERE server_id = ?1 AND id NOT IN (\
           SELECT id FROM console_command_history \
           WHERE server_id = ?1 ORDER BY id DESC LIMIT ?2\
         )",
        params![id, MAX_COMMAND_HISTORY as i64],
    )?;
    transaction.commit()?;
    Ok(())
}

fn latest_log_path(app_data: &Path, id: &str) -> Result<Option<(PathBuf, PathBuf)>, AppError> {
    let servers_dir = paths::servers_dir(app_data);
    if !existing_real_directory(&servers_dir, "servers")? {
        return Ok(None);
    }
    let canonical_servers_dir = fs::canonicalize(&servers_dir)?;

    let server_dir = paths::server_dir(app_data, id)?;
    if !existing_real_directory(&server_dir, "server")? {
        return Ok(None);
    }
    let canonical_server_dir = fs::canonicalize(&server_dir)?;
    if canonical_server_dir != canonical_servers_dir.join(id) {
        return Err(AppError::Validation(
            "server directory resolves outside its managed path".to_string(),
        ));
    }

    let logs_dir = server_dir.join("logs");
    if !existing_real_directory(&logs_dir, "server logs")? {
        return Ok(None);
    }
    let canonical_logs_dir = fs::canonicalize(&logs_dir)?;
    if canonical_logs_dir != canonical_server_dir.join("logs") {
        return Err(AppError::Validation(
            "server logs directory resolves outside its managed path".to_string(),
        ));
    }

    let log_path = logs_dir.join("latest.log");
    match fs::symlink_metadata(&log_path) {
        Ok(metadata) if metadata.is_file() && !is_reparse_point(&metadata) => {
            Ok(Some((log_path, canonical_logs_dir)))
        }
        Ok(_) => Err(AppError::Validation(
            "server latest.log is not a regular file".to_string(),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn existing_real_directory(path: &Path, display_name: &str) -> Result<bool, AppError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !is_reparse_point(&metadata) => Ok(true),
        Ok(_) => Err(AppError::Validation(format!(
            "server {display_name} path is not a real directory"
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn tail_log_file(
    log_root: &Path,
    path: &Path,
    requested_limit: usize,
) -> Result<Vec<String>, AppError> {
    let limit = requested_limit.min(MAX_LOG_TAIL_LINES);
    if limit == 0 {
        return Ok(Vec::new());
    }

    let Some(mut file) = open_log_file(log_root, path)? else {
        return Ok(Vec::new());
    };
    let length = file.metadata()?.len();
    let mut offset = length;
    let mut bytes_left = length.min(MAX_LOG_READ_BYTES as u64);
    let mut newline_count = 0usize;
    let mut chunks = Vec::new();

    while offset > 0 && bytes_left > 0 {
        let requested = offset.min(LOG_READ_CHUNK_BYTES as u64).min(bytes_left) as usize;
        offset -= requested as u64;
        file.seek(SeekFrom::Start(offset))?;
        let mut chunk = vec![0; requested];
        let read = file.read(&mut chunk)?;
        chunk.truncate(read);
        if read == 0 {
            break;
        }
        newline_count += chunk.iter().filter(|byte| **byte == b'\n').count();
        bytes_left = bytes_left.saturating_sub(read as u64);
        chunks.push(chunk);
        if read < requested || offset == 0 || newline_count > limit {
            break;
        }
    }

    let byte_count = chunks.iter().map(Vec::len).sum();
    let mut bytes = Vec::with_capacity(byte_count);
    for chunk in chunks.iter().rev() {
        bytes.extend_from_slice(chunk);
    }

    // The first collected line may begin before the byte window. Drop it rather
    // than returning a partial line from a large or actively rotated log.
    if offset > 0 {
        let Some(first_line_end) = bytes.iter().position(|byte| *byte == b'\n') else {
            return Ok(Vec::new());
        };
        bytes.drain(..=first_line_end);
    }

    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    if lines.len() > limit {
        lines.drain(..lines.len() - limit);
    }
    Ok(lines)
}

#[cfg(windows)]
fn open_log_file(log_root: &Path, path: &Path) -> Result<Option<fs::File>, AppError> {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};

    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() || is_reparse_point(&metadata) {
        return Err(AppError::Validation(
            "server latest.log is not a regular file".to_string(),
        ));
    }

    let final_path = final_path_from_handle(file.as_raw_handle())?;
    if !final_path.starts_with(log_root) {
        return Err(AppError::Validation(
            "server latest.log resolves outside its managed directory".to_string(),
        ));
    }
    Ok(Some(file))
}

#[cfg(target_os = "linux")]
fn open_log_file(log_root: &Path, path: &Path) -> Result<Option<fs::File>, AppError> {
    use std::os::unix::{fs::OpenOptionsExt, io::AsRawFd};

    const LINUX_O_NONBLOCK: i32 = 0o4000;

    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(LINUX_O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !file.metadata()?.is_file() {
        return Err(AppError::Validation(
            "server latest.log is not a regular file".to_string(),
        ));
    }
    let descriptor_path = PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()));
    let final_path = fs::canonicalize(descriptor_path)?;
    if !final_path.starts_with(log_root) {
        return Err(AppError::Validation(
            "server latest.log resolves outside its managed directory".to_string(),
        ));
    }
    Ok(Some(file))
}

#[cfg(not(any(windows, target_os = "linux")))]
fn open_log_file(_log_root: &Path, _path: &Path) -> Result<Option<fs::File>, AppError> {
    Err(AppError::Internal(
        "safe server log handles are not supported on this platform".to_string(),
    ))
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetFinalPathNameByHandleW(
        file: *mut std::ffi::c_void,
        path: *mut u16,
        path_capacity: u32,
        flags: u32,
    ) -> u32;
}

#[cfg(windows)]
fn final_path_from_handle(handle: std::os::windows::io::RawHandle) -> Result<PathBuf, AppError> {
    let mut buffer = vec![0u16; 512];
    loop {
        let length = unsafe {
            GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0)
        };
        if length == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let length = length as usize;
        if length < buffer.len() {
            buffer.truncate(length);
            let path = String::from_utf16(&buffer)
                .map_err(|error| AppError::Io(format!("invalid Windows path returned: {error}")))?;
            return Ok(PathBuf::from(path));
        }
        if length >= 32_768 {
            return Err(AppError::Validation(
                "server latest.log path exceeds Windows path limits".to_string(),
            ));
        }
        buffer.resize(length + 1, 0);
    }
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct TempPath(PathBuf);

    struct TempDir(PathBuf);

    impl TempPath {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir()
                .join(format!("mc-console-{name}-{}.log", uuid::Uuid::new_v4()));
            Self(path)
        }
    }

    impl Drop for TempPath {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    impl TempDir {
        fn new(name: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("mc-console-{name}-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn test_connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::apply_migrations(&conn).unwrap();
        conn
    }

    fn insert_server(conn: &Connection, id: &str, name: &str, port: i64) {
        conn.execute(
            "INSERT INTO servers (id, name, loader, mc_version, loader_version, modpack_id, \
             port, ram_mb, java_path, eula_accepted, status, created_at) \
             VALUES (?1, ?2, 'Vanilla', '1.20.1', NULL, NULL, ?3, 4096, NULL, 0, \
             'stopped', '2026-10-10T00:00:00Z')",
            params![id, name, port],
        )
        .unwrap();
    }

    fn canonical_temp_root() -> PathBuf {
        fs::canonicalize(std::env::temp_dir()).unwrap()
    }

    #[test]
    fn tails_recent_lines_and_partial_final_line() {
        let temp = TempPath::new("recent");
        fs::write(&temp.0, "one\r\ntwo\r\nthree").unwrap();

        assert_eq!(
            tail_log_file(&canonical_temp_root(), &temp.0, 2).unwrap(),
            ["two", "three"]
        );
    }

    #[test]
    fn tail_uses_a_hard_line_limit() {
        let temp = TempPath::new("limit");
        let contents = (0..MAX_LOG_TAIL_LINES + 5)
            .map(|line| format!("line-{line}\n"))
            .collect::<String>();
        fs::write(&temp.0, contents).unwrap();

        let lines = tail_log_file(&canonical_temp_root(), &temp.0, usize::MAX).unwrap();
        assert_eq!(lines.len(), MAX_LOG_TAIL_LINES);
        assert_eq!(lines.first().map(String::as_str), Some("line-5"));
        assert_eq!(lines.last().map(String::as_str), Some("line-10004"));
    }

    #[test]
    fn tail_can_read_while_the_log_is_open_for_append() {
        let temp = TempPath::new("shared");
        let mut writer = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&temp.0)
            .unwrap();
        writeln!(writer, "ready").unwrap();

        assert_eq!(
            tail_log_file(&canonical_temp_root(), &temp.0, 10).unwrap(),
            ["ready"]
        );
    }

    #[test]
    fn missing_log_is_empty_and_command_validation_is_single_line() {
        let temp = TempPath::new("missing");
        assert!(tail_log_file(&canonical_temp_root(), &temp.0, 10)
            .unwrap()
            .is_empty());
        assert_eq!(validate_command("  say hello  ").unwrap(), "say hello");
        assert!(validate_command("  ").is_err());
        assert!(validate_command("say hello\nstop").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn opened_reparse_log_is_rejected() {
        use std::os::windows::fs::symlink_file;

        let root = TempDir::new("reparse-root");
        let outside = TempPath::new("reparse-target");
        fs::write(&outside.0, "outside\n").unwrap();
        let link = root.0.join("latest.log");
        if symlink_file(&outside.0, &link).is_err() {
            return;
        }

        let canonical_root = fs::canonicalize(&root.0).unwrap();
        assert!(open_log_file(&canonical_root, &link).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn opened_symlink_log_is_rejected() {
        use std::os::unix::fs::symlink;

        let root = TempDir::new("unix-reparse-root");
        let outside = TempPath::new("unix-reparse-target");
        fs::write(&outside.0, "outside\n").unwrap();
        let link = root.0.join("latest.log");
        symlink(&outside.0, &link).unwrap();

        let canonical_root = fs::canonicalize(&root.0).unwrap();
        assert!(open_log_file(&canonical_root, &link).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn directory_replacement_after_root_capture_is_rejected() {
        use std::os::unix::fs::symlink;

        let server_dir = TempDir::new("unix-server-root");
        let outside = TempDir::new("unix-server-outside");
        let logs_dir = server_dir.0.join("logs");
        fs::create_dir(&logs_dir).unwrap();
        fs::write(logs_dir.join("latest.log"), "inside\n").unwrap();
        fs::write(outside.0.join("latest.log"), "outside\n").unwrap();
        let captured_root = fs::canonicalize(&logs_dir).unwrap();

        let old_logs = server_dir.0.join("logs-old");
        fs::rename(&logs_dir, &old_logs).unwrap();
        symlink(&outside.0, &logs_dir).unwrap();

        assert!(open_log_file(&captured_root, &logs_dir.join("latest.log")).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn fifo_log_replacement_is_rejected_without_blocking() {
        use std::sync::mpsc;
        use std::time::Duration;

        let root = TempDir::new("linux-fifo-root");
        let fifo = root.0.join("latest.log");
        let status = std::process::Command::new("mkfifo").arg(&fifo).status();
        if status.as_ref().map_or(true, |status| !status.success()) {
            return;
        }
        let canonical_root = fs::canonicalize(&root.0).unwrap();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let rejected = open_log_file(&canonical_root, &fifo)
                .map(|opened| opened.is_none())
                .unwrap_or(true);
            let _ = sender.send(rejected);
        });

        assert!(receiver.recv_timeout(Duration::from_secs(2)).unwrap());
    }

    #[test]
    fn command_history_is_per_server_bounded_and_cascades() {
        let mut conn = test_connection();
        insert_server(&conn, "server-a", "A", 25565);
        insert_server(&conn, "server-b", "B", 25566);
        for index in 0..MAX_COMMAND_HISTORY + 5 {
            record_command(&mut conn, "server-a", &format!("command-{index}")).unwrap();
        }
        record_command(&mut conn, "server-b", "say private").unwrap();

        let history = command_history(&conn, "server-a", usize::MAX).unwrap();
        assert_eq!(history.len(), MAX_COMMAND_HISTORY);
        assert_eq!(history.first().unwrap().command, "command-104");
        assert_eq!(history.last().unwrap().command, "command-5");
        assert_eq!(
            command_history(&conn, "server-b", 10).unwrap()[0].command,
            "say private"
        );

        conn.execute("DELETE FROM servers WHERE id = ?1", ["server-a"])
            .unwrap();
        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM console_command_history WHERE server_id = ?1",
                ["server-a"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0);
    }
}
