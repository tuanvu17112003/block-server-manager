//! Backend entry point — Phase 0 foundations + Phase 1 persistence +
//! Phase 2 process manager and Phase 3 Java provisioning.
//!
//! Wires: appdirs + file logging, SQLite state, single-instance,
//! live `java` child tracking (`ProcessState`), orphan reaping at startup,
//! stop-all on window close, and the Phase 0+1+2+3 IPC surface
//! (`ping`, `servers_*`, Java discovery/provisioning, and server lifecycle).

mod backups;
mod cmds;
mod content;
mod db;
mod error;
mod installer;
mod java;
mod metrics;
mod modpacks;
mod players;
mod rcon;
mod servers;
mod util;
mod worlds;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch focuses the existing window instead of starting
            // a second backend (which could double-spawn java processes).
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(
            tauri_plugin_mcp_bridge::Builder::new()
                .bind_address("127.0.0.1")
                .build(),
        );
    }

    builder
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            util::paths::ensure_dirs(&app_data)?;
            util::logging::init_file_logging(&app_data);

            let conn = db::open_and_migrate(&util::paths::db_path(&app_data))?;

            // Phase 2: reap PIDs orphaned by an unclean shutdown (stale
            // `server.lock` files) and normalize statuses — nothing is live
            // at boot. Best-effort: never fail startup over this.
            if let Err(e) = servers::process::reap_orphans(&app_data, &conn) {
                tracing::warn!("orphan reaping failed: {e}");
            }
            app.manage(db::DbState(std::sync::Mutex::new(conn)));
            app.manage(servers::process::ProcessState::new());
            app.manage(installer::InstallerState::new());
            app.manage(modpacks::pipeline::commands::PipelineState::new());
            app.manage(std::sync::Arc::new(
                modpacks::curseforge_import::CurseForgeDownloadState::default(),
            ));

            tracing::info!("backend ready (phase 0+1+2+3+4)");
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "curseforge-browser"
                && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                modpacks::curseforge_import::browser_window_closing(window.app_handle());
            }
            // Phase 2: stop-all live processes before the window closes
            // (stdin `stop` + short budget, then kill survivors).
            if window.label() == "main"
                && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                servers::process::stop_all_blocking(window.app_handle());
                tracing::info!("window close requested (servers stopped)");
            }
        })
        .invoke_handler(tauri::generate_handler![
            cmds::ping::ping,
            cmds::servers::servers_list,
            cmds::servers::server_get,
            cmds::servers::servers_create,
            cmds::servers::servers_delete,
            cmds::servers::servers_set_java_path,
            java::java_detect,
            java::java_validate,
            java::java_ensure,
            installer::versions_vanilla,
            installer::versions_paper,
            installer::loaders_resolve,
            installer::server_install,
            installer::server_install_cancel,
            modpacks::pipeline::commands::modpack_pipeline_pick_local_mrpack,
            modpacks::pipeline::commands::modpack_pipeline_preview,
            modpacks::pipeline::commands::modpack_pipeline_install,
            modpacks::pipeline::commands::modpack_pipeline_cancel,
            modpacks::pipeline::commands::modpack_pipeline_discard_preview,
            modpacks::pipeline::commands::modpack_pipeline_release_local_mrpack,
            modpacks::modrinth_search_modpacks,
            modpacks::modrinth_project_versions,
            modpacks::curseforge_import::curseforge_open_browser,
            modpacks::curseforge_import::curseforge_open_external_browser,
            modpacks::curseforge_import::curseforge_list_zips,
            modpacks::curseforge_import::curseforge_pick_zip,
            modpacks::curseforge_import::curseforge_inspect_zip,
            modpacks::curseforge_import::curseforge_cancel_download,
            cmds::process::server_start,
            cmds::process::server_stop,
            cmds::process::server_kill,
            cmds::process::server_restart,
            cmds::process::server_send_command,
            cmds::console::logs_tail,
            cmds::console::server_command_history,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
