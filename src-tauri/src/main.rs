#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mc_server_manager_lib::run();
}
