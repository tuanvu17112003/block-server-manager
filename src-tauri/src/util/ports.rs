//! Game-port allocator: auto `25565+`, conflict-checked vs DB + live probe.
//!
//! The game port opens TCP only. RCON (Phase 6/7) binds `127.0.0.1` only
//! on its own port — never derived from or exposed through this allocator.

use rusqlite::Connection;

use crate::error::AppError;

/// First auto-allocated game port.
pub const FIRST_GAME_PORT: u16 = 25565;

/// True when nothing on this machine is currently bound to `port` (TCP).
pub fn is_tcp_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Ports already claimed in the DB.
pub fn used_ports(conn: &Connection) -> Result<Vec<u16>, AppError> {
    let mut stmt = conn.prepare("SELECT port FROM servers")?;
    let rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
    let mut out = Vec::new();
    for r in rows {
        let p = r?;
        if (1..=65535).contains(&p) {
            out.push(p as u16);
        }
    }
    Ok(out)
}

/// First free port ≥ `max(start, 25565)`, skipping DB-claimed and live-bound.
pub fn next_free_port(conn: &Connection, start: u16) -> Result<u16, AppError> {
    let used = used_ports(conn)?;
    let mut port: u32 = start.max(FIRST_GAME_PORT) as u32;
    while port <= 65535 {
        let p = port as u16;
        if !used.contains(&p) && is_tcp_free(p) {
            return Ok(p);
        }
        port += 1;
    }
    Err(AppError::Conflict(
        "no free game port available".to_string(),
    ))
}

/// Validate an explicitly requested port (DB + live probe).
pub fn claim_port(conn: &Connection, port: u16) -> Result<u16, AppError> {
    if !(1024..=65535).contains(&(port as u32)) {
        return Err(AppError::Validation(
            "port must be between 1024 and 65535".to_string(),
        ));
    }
    if used_ports(conn)?.contains(&port) {
        return Err(AppError::Conflict(format!("port {port} is already used")));
    }
    if !is_tcp_free(port) {
        return Err(AppError::Conflict(format!(
            "port {port} is already in use on this machine"
        )));
    }
    Ok(port)
}
