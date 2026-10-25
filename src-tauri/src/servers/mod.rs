//! Phase 1 — servers CRUD over SQLite + per-server folder scaffold.
//!
//! Binding: EULA is NEVER auto-accepted. Create scaffolds `eula.txt=false`
//! and `server_start` (Phase 2) must refuse to launch while it is not `true`,
//! independent of any UI gate.

use std::{fs::OpenOptions, io::Write, path::Path};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::util::{paths, ports};

pub mod console;
pub mod process;

/// Loaders offerable by the Create wizard (backend-plan Phase 4).
pub const ALLOWED_LOADERS: &[&str] = &["Vanilla", "Paper", "Fabric", "Forge", "NeoForge"];

/// Mirrors the `servers` table; `camelCase` matches the frontend DTO.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRecord {
    pub id: String,
    pub name: String,
    pub loader: String,
    pub mc_version: String,
    pub loader_version: Option<String>,
    pub modpack_id: Option<String>,
    pub port: i64,
    pub ram_mb: i64,
    pub java_path: Option<String>,
    pub eula_accepted: bool,
    pub status: String,
    pub created_at: String,
}

/// Create input from the wizard. `port: None` (or 0) = auto-allocate 25565+.
/// `eulaAccepted` is stored as given — the backend never flips it to true
/// on its own; acceptance is an explicit user act recorded later.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateServerInput {
    pub name: String,
    pub loader: String,
    pub mc_version: String,
    pub loader_version: Option<String>,
    pub modpack_id: Option<String>,
    pub port: Option<u16>,
    pub ram_mb: i64,
    pub java_path: Option<String>,
    pub eula_accepted: Option<bool>,
}

fn row_to_record(row: &rusqlite::Row) -> rusqlite::Result<ServerRecord> {
    Ok(ServerRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        loader: row.get(2)?,
        mc_version: row.get(3)?,
        loader_version: row.get(4)?,
        modpack_id: row.get(5)?,
        port: row.get(6)?,
        ram_mb: row.get(7)?,
        java_path: row.get(8)?,
        eula_accepted: row.get::<_, i64>(9)? != 0,
        status: row.get(10)?,
        created_at: row.get(11)?,
    })
}

const COLUMNS: &str = "id, name, loader, mc_version, loader_version, modpack_id, \
     port, ram_mb, java_path, eula_accepted, status, created_at";

/// All servers, oldest first.
pub fn list_servers(conn: &Connection) -> Result<Vec<ServerRecord>, AppError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM servers ORDER BY created_at"
    ))?;
    let rows = stmt.query_map([], row_to_record)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// One server by id.
pub fn get_server(conn: &Connection, id: &str) -> Result<ServerRecord, AppError> {
    paths::validate_id(id)?;
    let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM servers WHERE id = ?1"))?;
    stmt.query_row(params![id], row_to_record)
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                AppError::NotFound(format!("server '{id}' not found"))
            }
            other => AppError::Db(other.to_string()),
        })
}

/// Validate → allocate port → insert → scaffold folder. No partial rows on
/// scaffold failure (row is removed again so failed installs leave nothing).
pub fn create_server(
    conn: &Connection,
    app_data: &Path,
    input: CreateServerInput,
) -> Result<ServerRecord, AppError> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Validation("server name is required".to_string()));
    }
    if name.len() > 64 {
        return Err(AppError::Validation(
            "server name must be 64 characters or fewer".to_string(),
        ));
    }
    // Phase 2 entry fix: the name is interpolated into `server.properties`
    // (`motd=...`), so newlines/`=` would inject arbitrary properties.
    if name.chars().any(|c| c == '\n' || c == '\r' || c == '=') {
        return Err(AppError::Validation(
            "server name must not contain newlines or '='".to_string(),
        ));
    }
    if !ALLOWED_LOADERS.contains(&input.loader.as_str()) {
        return Err(AppError::Validation(format!(
            "unknown loader '{}'",
            input.loader
        )));
    }
    if input.mc_version.trim().is_empty() {
        return Err(AppError::Validation(
            "minecraft version is required".to_string(),
        ));
    }
    if !(512..=65536).contains(&input.ram_mb) {
        return Err(AppError::Validation(
            "ram must be between 512 and 65536 MB".to_string(),
        ));
    }

    // Persist only a verified executable path. `None` keeps the automatic
    // detection path available when the user has not chosen an override.
    let java_path = input
        .java_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .map(|path| crate::java::validate_java_for_version(path, input.mc_version.trim()))
        .transpose()?
        .map(|candidate| candidate.path);

    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM servers WHERE name = ?1",
        params![name],
        |r| r.get(0),
    )?;
    if exists > 0 {
        return Err(AppError::Conflict(format!(
            "a server named '{name}' already exists"
        )));
    }

    let port = match input.port.unwrap_or(0) {
        0 => ports::next_free_port(conn, ports::FIRST_GAME_PORT)?,
        p => ports::claim_port(conn, p)?,
    };

    let id = uuid::Uuid::new_v4().to_string();
    let created_at = chrono::Utc::now().to_rfc3339();
    let record = ServerRecord {
        id: id.clone(),
        name: name.clone(),
        loader: input.loader,
        mc_version: input.mc_version.trim().to_string(),
        loader_version: input.loader_version,
        modpack_id: input.modpack_id,
        port: port as i64,
        ram_mb: input.ram_mb,
        java_path,
        eula_accepted: input.eula_accepted.unwrap_or(false),
        status: "stopped".to_string(),
        created_at,
    };

    conn.execute(
        "INSERT INTO servers (id, name, loader, mc_version, loader_version, modpack_id, \
         port, ram_mb, java_path, eula_accepted, status, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            record.id,
            record.name,
            record.loader,
            record.mc_version,
            record.loader_version,
            record.modpack_id,
            record.port,
            record.ram_mb,
            record.java_path,
            if record.eula_accepted { 1 } else { 0 },
            record.status,
            record.created_at,
        ],
    )?;

    if let Err(e) = scaffold_server_dir(app_data, &record) {
        let _ = conn.execute("DELETE FROM servers WHERE id = ?1", params![id]);
        return Err(e);
    }

    tracing::info!(server = %id, port, "server created");
    Ok(record)
}

/// Check the user-provided name and requested port before a potentially large
/// provider download starts. Publication repeats both checks to handle races.
pub fn validate_install_preflight(
    conn: &Connection,
    input: &CreateServerInput,
) -> Result<(), AppError> {
    let name = input.name.trim();
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM servers WHERE name = ?1",
        params![name],
        |row| row.get(0),
    )?;
    if exists > 0 {
        return Err(AppError::Conflict(format!(
            "a server named '{name}' already exists"
        )));
    }
    match input.port.unwrap_or(0) {
        0 => {
            ports::next_free_port(conn, ports::FIRST_GAME_PORT)?;
        }
        port => {
            ports::claim_port(conn, port)?;
        }
    }
    Ok(())
}

fn append_publication_log(staging: &Path, line: &str) -> Result<(), AppError> {
    let mut installer_log = OpenOptions::new()
        .append(true)
        .open(staging.join("installer.log"))
        .map_err(|error| AppError::Io(format!("could not open the staged install log: {error}")))?;
    writeln!(installer_log, "{line}").map_err(|error| {
        AppError::Io(format!("could not append the staged install log: {error}"))
    })?;
    // Return only after the handle is closed: Windows can deny a directory move
    // while a file inside that directory is still open.
    Ok(())
}

fn move_staged_server(staging: &Path, target: &Path) -> Result<(), AppError> {
    std::fs::rename(staging, target).map_err(|error| {
        AppError::Io(format!(
            "could not move the validated install into the servers folder: {error}"
        ))
    })
}

fn publish_staged_server(
    staging: &Path,
    target: &Path,
    persist: impl FnOnce() -> Result<(), AppError>,
) -> Result<(), AppError> {
    move_staged_server(staging, target)?;
    if let Err(error) = persist() {
        if let Err(cleanup) = std::fs::remove_dir_all(target) {
            tracing::error!(path = %target.display(), %cleanup, "failed to roll back published installer folder");
        }
        return Err(error);
    }
    Ok(())
}

/// Publish an already validated installation. The staged folder is renamed
/// into its final location before the row is inserted, so the server list
/// cannot expose a record without its launcher files. A failed insert removes
/// the renamed folder.
pub fn publish_installed_server(
    conn: &Connection,
    app_data: &Path,
    input: CreateServerInput,
    staging: &Path,
) -> Result<ServerRecord, AppError> {
    let staging_root = app_data.join("installer-staging");
    if !staging.starts_with(&staging_root)
        || !staging.is_dir()
        || !staging.join("installer.log").is_file()
    {
        return Err(AppError::Validation(
            "installer staging folder is missing or invalid".to_string(),
        ));
    }
    crate::modpacks::install::ensure_safe_staging(staging)?;

    let name = input.name.trim().to_string();
    if name.is_empty()
        || name.len() > 64
        || name.chars().any(|c| c == '\n' || c == '\r' || c == '=')
    {
        return Err(AppError::Validation(
            "server name must be 1–64 characters and must not contain newlines or '='".to_string(),
        ));
    }
    if !ALLOWED_LOADERS.contains(&input.loader.as_str()) {
        return Err(AppError::Validation(format!(
            "unknown loader '{}'",
            input.loader
        )));
    }
    if !crate::installer::supported_minecraft_version(&input.mc_version) {
        return Err(AppError::Validation(format!(
            "Minecraft version ID '{}' is invalid",
            input.mc_version
        )));
    }
    if !(512..=65536).contains(&input.ram_mb) {
        return Err(AppError::Validation(
            "ram must be between 512 and 65536 MB".to_string(),
        ));
    }
    let java_path = input
        .java_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .map(|path| crate::java::validate_java_for_version(path, input.mc_version.trim()))
        .transpose()?
        .map(|candidate| candidate.path)
        .ok_or_else(|| AppError::Validation("a compatible Java runtime is required".to_string()))?;

    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM servers WHERE name = ?1",
        params![name],
        |row| row.get(0),
    )?;
    if exists > 0 {
        return Err(AppError::Conflict(format!(
            "a server named '{name}' already exists"
        )));
    }

    let port = match input.port.unwrap_or(0) {
        0 => ports::next_free_port(conn, ports::FIRST_GAME_PORT)?,
        selected => ports::claim_port(conn, selected)?,
    };
    let id = uuid::Uuid::new_v4().to_string();
    let record = ServerRecord {
        id: id.clone(),
        name,
        loader: input.loader,
        mc_version: input.mc_version.trim().to_string(),
        loader_version: input.loader_version,
        modpack_id: input.modpack_id,
        port: port as i64,
        ram_mb: input.ram_mb,
        java_path: Some(java_path),
        eula_accepted: input.eula_accepted.unwrap_or(false),
        status: "stopped".to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };

    for sub in ["mods", "world", "logs", "backups"] {
        std::fs::create_dir_all(staging.join(sub))?;
    }
    ensure_managed_file_path(&staging.join("eula.txt"))?;
    let eula_line = if record.eula_accepted {
        "eula=true"
    } else {
        "eula=false"
    };
    std::fs::write(
        staging.join("eula.txt"),
        format!(
            "# By changing the setting below to TRUE you are indicating your agreement to the Minecraft EULA (https://www.minecraft.net/en-us/eula).\n\
             # NEVER auto-accepted by the launcher — set to true only via the explicit EULA checkbox.\n\
             {eula_line}\n"
        ),
    )?;
    write_server_properties(staging, &record)?;
    append_publication_log(
        staging,
        &format!(
            "{} validated install ready for publication ({} {} port {})",
            record.created_at, record.loader, record.mc_version, record.port
        ),
    )?;

    let target = paths::server_dir(app_data, &record.id)?;
    if target.exists() {
        return Err(AppError::Conflict(
            "could not allocate a unique server folder".to_string(),
        ));
    }
    std::fs::create_dir_all(paths::servers_dir(app_data))?;
    publish_staged_server(staging, &target, || {
        conn.execute(
            "INSERT INTO servers (id, name, loader, mc_version, loader_version, modpack_id, \
             port, ram_mb, java_path, eula_accepted, status, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                record.id,
                record.name,
                record.loader,
                record.mc_version,
                record.loader_version,
                record.modpack_id,
                record.port,
                record.ram_mb,
                record.java_path,
                if record.eula_accepted { 1 } else { 0 },
                record.status,
                record.created_at,
            ],
        )
        .map(|_| ())
        .map_err(AppError::from)
    })?;
    tracing::info!(server = %record.id, port, "installed server published");
    Ok(record)
}

fn write_server_properties(staging: &Path, record: &ServerRecord) -> Result<(), AppError> {
    let path = staging.join("server.properties");
    ensure_managed_file_path(&path)?;
    let existing = match std::fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    const MANAGER_KEYS: &[&str] = &[
        "server-port",
        "motd",
        "max-players",
        "online-mode",
        "difficulty",
        "gamemode",
        "level-name",
        "enable-rcon",
        "enable-status",
    ];
    let mut contents = String::new();
    for line in existing.lines() {
        let manager_owned = line
            .split_once('=')
            .is_some_and(|(key, _)| MANAGER_KEYS.contains(&key.trim()));
        if !manager_owned {
            contents.push_str(line);
            contents.push('\n');
        }
    }
    let manager_values = [
        ("server-port", record.port.to_string()),
        ("motd", record.name.clone()),
        ("max-players", "20".to_string()),
        ("online-mode", "true".to_string()),
        ("difficulty", "normal".to_string()),
        ("gamemode", "survival".to_string()),
        ("level-name", "world".to_string()),
        ("enable-rcon", "false".to_string()),
        ("enable-status", "true".to_string()),
    ];
    for (key, value) in manager_values {
        contents.push_str(key);
        contents.push('=');
        contents.push_str(&value);
        contents.push('\n');
    }
    std::fs::write(path, contents)?;
    Ok(())
}

fn ensure_managed_file_path(path: &Path) -> Result<(), AppError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !is_reparse_point(&metadata) => Ok(()),
        Ok(_) => Err(AppError::Validation(
            "server manager file path is not a regular file".into(),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(windows)]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

/// Persist a validated Java executable for one stopped server.
pub fn set_server_java_path(
    conn: &Connection,
    id: &str,
    java_path: Option<&str>,
) -> Result<ServerRecord, AppError> {
    paths::validate_id(id)?;
    let updated = conn.execute(
        "UPDATE servers SET java_path = ?1 WHERE id = ?2",
        params![java_path, id],
    )?;
    if updated == 0 {
        return Err(AppError::NotFound(format!("server '{id}' not found")));
    }
    get_server(conn, id)
}

/// Delete the DB row (backups/worlds/jobs cascade) and remove the folder.
pub fn delete_server(conn: &Connection, app_data: &Path, id: &str) -> Result<(), AppError> {
    paths::validate_id(id)?;
    let affected = conn.execute("DELETE FROM servers WHERE id = ?1", params![id])?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("server '{id}' not found")));
    }
    if let Ok(dir) = paths::server_dir(app_data, id) {
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
    }
    tracing::info!(server = %id, "server deleted");
    Ok(())
}

/// `<app-data>/servers/<id>/` with `mods/`, `world/`, `logs/`, `backups/`,
/// plus `eula.txt` (from the accepted flag — no DB/file divergence), a minimal
/// `server.properties`, and `installer.log`.
/// RCON stays disabled here (`enable-rcon=false`, no password written) until a
/// supported loopback-only bind mechanism is verified (ADR-0011).
fn scaffold_server_dir(app_data: &Path, record: &ServerRecord) -> Result<(), AppError> {
    let dir = paths::server_dir(app_data, &record.id)?;
    for sub in ["mods", "world", "logs", "backups"] {
        std::fs::create_dir_all(dir.join(sub))?;
    }
    // Phase 2 entry fix: honour the accepted flag so `server_start`'s
    // `eula.txt == true` check agrees with the DB row (never auto-accepted —
    // `true` lands here only via the explicit EULA checkbox).
    let eula_line = if record.eula_accepted {
        "eula=true"
    } else {
        "eula=false"
    };
    std::fs::write(
        dir.join("eula.txt"),
        format!(
            "# By changing the setting below to TRUE you are indicating your agreement to the Minecraft EULA (https://www.minecraft.net/en-us/eula).\n\
             # NEVER auto-accepted by the launcher — set to true only via the explicit EULA checkbox.\n\
             {eula_line}\n"
        ),
    )?;
    std::fs::write(
        dir.join("server.properties"),
        format!(
            "# Minimal properties scaffold (full subset + validation lands in Phase 8).\n\
             server-port={}\n\
             motd={}\n\
             max-players=20\n\
             online-mode=true\n\
             difficulty=normal\n\
             gamemode=survival\n\
             level-name=world\n\
             enable-rcon=false\n\
             enable-status=true\n",
            record.port, record.name,
        ),
    )?;
    std::fs::write(
        dir.join("installer.log"),
        format!(
            "{} scaffold created ({} {} port {})\n",
            record.created_at, record.loader, record.mc_version, record.port
        ),
    )?;
    Ok(())
}

#[cfg(all(test, windows))]
mod publication_tests {
    use super::{
        append_publication_log, move_staged_server, publish_staged_server, write_server_properties,
        ServerRecord,
    };
    use std::{fs, path::PathBuf};

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "mc-server-manager-publication-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn publication_log_handle_is_closed_before_staging_directory_move() {
        let root = TestDir::new();
        let staging = root.0.join("installer-staging").join("job-id");
        let target = root.0.join("servers").join("server-id");
        fs::create_dir_all(&staging).unwrap();
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(staging.join("server.jar"), b"validated jar").unwrap();
        fs::write(staging.join("installer.log"), "download complete\n").unwrap();

        append_publication_log(&staging, "validated install ready").unwrap();
        move_staged_server(&staging, &target).unwrap();

        assert!(!staging.exists());
        assert_eq!(
            fs::read(target.join("server.jar")).unwrap(),
            b"validated jar"
        );
        assert_eq!(
            fs::read_to_string(target.join("installer.log")).unwrap(),
            "download complete\nvalidated install ready\n"
        );
    }

    #[test]
    fn removes_moved_folder_when_persistence_fails() {
        let root = TestDir::new();
        let staging = root.0.join("installer-staging").join("job-id");
        let target = root.0.join("servers").join("server-id");
        fs::create_dir_all(&staging).unwrap();
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(staging.join("installer.log"), "ready\n").unwrap();

        let result = publish_staged_server(&staging, &target, || {
            Err(super::AppError::Conflict("forced database failure".into()))
        });

        assert!(result.is_err());
        assert!(!staging.exists());
        assert!(!target.exists());
    }

    #[test]
    fn preserves_pack_properties_while_overriding_manager_values() {
        let root = TestDir::new();
        fs::write(
            root.0.join("server.properties"),
            "motd=pack title\nserver-port=10000\nmax-players=500\nonline-mode=false\ncustom-settings=true\n",
        )
        .unwrap();
        let record = ServerRecord {
            id: "server-id".into(),
            name: "Managed Server".into(),
            loader: "Fabric".into(),
            mc_version: "1.20.1".into(),
            loader_version: Some("0.15.11".into()),
            modpack_id: Some("modrinth:abcd1234:efgh5678".into()),
            port: 25566,
            ram_mb: 2048,
            java_path: None,
            eula_accepted: false,
            status: "stopped".into(),
            created_at: "test".into(),
        };

        write_server_properties(&root.0, &record).unwrap();
        let properties = fs::read_to_string(root.0.join("server.properties")).unwrap();

        assert!(properties.contains("custom-settings=true"));
        assert!(properties.contains("server-port=25566"));
        assert!(properties.contains("motd=Managed Server"));
        assert!(properties.contains("max-players=20"));
        assert!(properties.contains("online-mode=true"));
        assert!(!properties.contains("server-port=10000"));
        assert!(!properties.contains("motd=pack title"));
    }
}
