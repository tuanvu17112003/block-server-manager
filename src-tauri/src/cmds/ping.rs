//! Phase 0 smoke command: UI→Rust→UI round-trip (`ping` → `"pong"`).

#[tauri::command]
pub fn ping() -> String {
    "pong".to_string()
}
