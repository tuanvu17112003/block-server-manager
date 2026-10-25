use std::{fs, path::Path};

use crate::{
    error::AppError,
    modpacks::pipeline::{
        loader::{self, LoaderCompletenessEvidence, LoaderLaunchMode},
        model::{validate_safe_relative_path, LaunchConfig, LaunchConfigSource},
        plan::{InstallPlan, LoaderKind, LoaderPin},
    },
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RuntimeLaunchMode {
    Jar {
        file_name: String,
    },
    ArgumentFiles {
        user_jvm_args: String,
        loader_args: String,
    },
}

const SOURCE_PRECEDENCE: [LaunchConfigSource; 4] = [
    LaunchConfigSource::PackMetadata,
    LaunchConfigSource::LoaderArguments,
    LaunchConfigSource::DetectedConvention,
    LaunchConfigSource::Manual,
];

/// Create the launch audit artifact from the active plan and the exact staged
/// loader evidence. The saved JSON is an output only; publication keeps using
/// the in-memory plan and loader evidence.
pub(crate) fn build_staged_launch_config(
    plan: &InstallPlan,
    loader_evidence: &LoaderCompletenessEvidence,
    staging: &Path,
    canonical_app_data: &Path,
    target_root: &Path,
    ram_mb: i64,
) -> Result<LaunchConfig, String> {
    plan.validate_ready_to_install()
        .map_err(|error| error.to_string())?;
    if !loader_evidence.complete
        || loader_evidence.plan != *plan
        || loader_evidence.coordinate.provider_pin != plan.loader
    {
        return Err("loader completeness evidence does not match the active install plan".into());
    }

    let (verified_mode, verified_files) =
        loader::inspect_prepared_runtime(staging, &loader_evidence.coordinate)
            .map_err(|error| error.to_string())?;
    if loader_evidence.launch_mode != verified_mode
        || verified_files != loader_evidence.required_files
    {
        return Err("loader runtime changed after its completeness evidence was prepared".into());
    }

    let app_root = checked_directory(canonical_app_data, "canonical app-data root")?;
    if app_root != canonical_app_data {
        return Err("launch target app-data root is no longer canonical".into());
    }
    let expected_target = app_root.join("servers").join(&plan.target.server_id);
    if target_root != expected_target {
        return Err("launch target is not bound to the selected server ID".into());
    }
    let canonical_target = checked_directory(target_root, "selected server directory")?;
    if canonical_target != expected_target {
        return Err("launch target resolves outside the selected server directory".into());
    }
    let java_path = checked_regular_file(
        &loader_evidence.selected_java_path,
        "selected Java executable",
    )?;

    let (mode, source) = match &loader_evidence.launch_mode {
        LoaderLaunchMode::ServerJar { file_name } => (
            RuntimeLaunchMode::Jar {
                file_name: file_name.clone(),
            },
            LaunchConfigSource::DetectedConvention,
        ),
        LoaderLaunchMode::LegacyForgeJars { forge_jar, .. } => (
            RuntimeLaunchMode::Jar {
                file_name: forge_jar.clone(),
            },
            LaunchConfigSource::DetectedConvention,
        ),
        LoaderLaunchMode::ArgumentFiles {
            user_jvm_args,
            loader_args,
        } => (
            RuntimeLaunchMode::ArgumentFiles {
                user_jvm_args: user_jvm_args.clone(),
                loader_args: loader_args.clone(),
            },
            LaunchConfigSource::LoaderArguments,
        ),
    };
    let argv = build_argv(&plan.target.server_id, ram_mb, &mode)?;
    let config = LaunchConfig {
        schema_version: crate::modpacks::pipeline::model::PIPELINE_SCHEMA_VERSION,
        server_id: plan.target.server_id.clone(),
        provider_pin: Some(plan.source_pin.clone()),
        loader_pin: Some(plan.loader.clone()),
        java_path: java_path.to_string_lossy().into_owned(),
        argv,
        working_directory: canonical_target.to_string_lossy().into_owned(),
        source,
        source_precedence: SOURCE_PRECEDENCE.to_vec(),
    };
    config.validate().map_err(|error| error.to_string())?;
    Ok(config)
}

/// Rebuild the live command from the database row and current server files.
/// `launch-config.json` is deliberately not consulted as command authority.
pub(crate) fn build_live_launch_config(
    server_id: &str,
    app_data: &Path,
    server_root: &Path,
    loader_name: &str,
    minecraft_version: &str,
    loader_version: Option<&str>,
    java_path: &str,
    ram_mb: i64,
    mode: &RuntimeLaunchMode,
) -> Result<LaunchConfig, AppError> {
    validate_safe_relative_path(server_id)
        .map_err(|error| AppError::Validation(error.to_string()))?;
    if server_id.contains('/') {
        return Err(AppError::Validation(
            "server ID must be one path component".into(),
        ));
    }
    let app_root = checked_directory(app_data, "app-data root").map_err(invalid_launch)?;
    let expected_server_root = app_root.join("servers").join(server_id);
    let canonical_server_root =
        checked_directory(server_root, "server directory").map_err(invalid_launch)?;
    if canonical_server_root != expected_server_root {
        return Err(AppError::Validation(
            "server launch directory resolves outside its bound server root".into(),
        ));
    }
    let java_path = checked_regular_file(Path::new(java_path), "selected Java executable")
        .map_err(invalid_launch)?;

    match mode {
        RuntimeLaunchMode::Jar { file_name } => {
            checked_server_file(server_root, file_name, "server launch JAR")?;
            if loader_name == "Forge" && minecraft_version == "1.12.2" {
                checked_server_file(
                    server_root,
                    &format!("minecraft_server.{minecraft_version}.jar"),
                    "legacy Minecraft JAR",
                )?;
            }
        }
        RuntimeLaunchMode::ArgumentFiles {
            user_jvm_args,
            loader_args,
        } => {
            checked_server_file(server_root, "run.bat", "generated run.bat")?;
            let script_path = server_root.join("run.bat");
            let script_metadata = fs::symlink_metadata(&script_path)
                .map_err(|error| invalid_launch(error.to_string()))?;
            if script_metadata.len() > 256 * 1024 {
                return Err(invalid_launch(
                    "generated run.bat exceeds the supported size".into(),
                ));
            }
            let script = fs::read_to_string(&script_path)
                .map_err(|_| invalid_launch("generated run.bat is not valid UTF-8".into()))?;
            if !loader::references_user_jvm_args(&script) {
                return Err(invalid_launch(
                    "generated run.bat does not reference user_jvm_args.txt".into(),
                ));
            }
            let expected_args = loader_args.replace('\\', "/");
            let validated_args = crate::servers::process::expected_generated_arg_file(
                &script,
                &expected_args,
                loader_name,
            )
            .map_err(|error| invalid_launch(error.to_string()))?;
            if !validated_args.eq_ignore_ascii_case(&expected_args) {
                return Err(invalid_launch(
                    "generated run.bat does not match the selected loader argument file".into(),
                ));
            }
            let expected_payload = expected_server_payload(
                loader_name,
                minecraft_version,
                loader_version,
                loader_args,
            )?;
            loader::verify_start_argument_files(
                server_root,
                user_jvm_args,
                loader_args,
                expected_payload.as_deref(),
            )
            .map_err(|error| invalid_launch(error.to_string()))?;
        }
    }

    let loader_pin = match loader_name {
        "Vanilla" => Some(LoaderPin {
            kind: LoaderKind::Vanilla,
            minecraft_version: minecraft_version.into(),
            loader_version: None,
        }),
        "Fabric" | "Forge" | "NeoForge" => Some(LoaderPin {
            kind: match loader_name {
                "Fabric" => LoaderKind::Fabric,
                "Forge" => LoaderKind::Forge,
                _ => LoaderKind::NeoForge,
            },
            minecraft_version: minecraft_version.into(),
            loader_version: loader_version.map(str::to_string),
        }),
        // Paper and saved Quilt servers remain on their existing Start behavior.
        _ => None,
    };
    let source = match mode {
        RuntimeLaunchMode::ArgumentFiles { .. } => LaunchConfigSource::LoaderArguments,
        RuntimeLaunchMode::Jar { .. } => LaunchConfigSource::DetectedConvention,
    };
    let config = LaunchConfig {
        schema_version: crate::modpacks::pipeline::model::PIPELINE_SCHEMA_VERSION,
        server_id: server_id.into(),
        provider_pin: None,
        loader_pin,
        java_path: java_path.to_string_lossy().into_owned(),
        argv: build_argv(server_id, ram_mb, mode).map_err(invalid_launch)?,
        working_directory: canonical_server_root.to_string_lossy().into_owned(),
        source,
        source_precedence: SOURCE_PRECEDENCE.to_vec(),
    };
    config
        .validate()
        .map_err(|error| invalid_launch(error.to_string()))?;
    Ok(config)
}

fn build_argv(
    server_id: &str,
    ram_mb: i64,
    mode: &RuntimeLaunchMode,
) -> Result<Vec<String>, String> {
    if !(512..=65_536).contains(&ram_mb) {
        return Err("server RAM setting is outside the supported launch bound".into());
    }
    let mut argv = match mode {
        RuntimeLaunchMode::Jar { file_name } => {
            validate_safe_relative_path(file_name).map_err(|error| error.to_string())?;
            vec![
                format!("-Xmx{ram_mb}M"),
                format!("-Xms{ram_mb}M"),
                format!("-Dtestmultiai.server.id={server_id}"),
                "-jar".into(),
                file_name.clone(),
                "nogui".into(),
            ]
        }
        RuntimeLaunchMode::ArgumentFiles {
            user_jvm_args,
            loader_args,
        } => {
            validate_safe_relative_path(user_jvm_args).map_err(|error| error.to_string())?;
            validate_safe_relative_path(loader_args).map_err(|error| error.to_string())?;
            vec![
                format!("@{user_jvm_args}"),
                format!("-Xmx{ram_mb}M"),
                format!("-Xms{ram_mb}M"),
                format!("-Dtestmultiai.server.id={server_id}"),
                format!("@{loader_args}"),
                "nogui".into(),
            ]
        }
    };
    if argv.iter().any(|argument| argument.contains('\0')) {
        return Err("launch arguments contain a NUL byte".into());
    }
    argv.shrink_to_fit();
    Ok(argv)
}

fn expected_server_payload(
    loader_name: &str,
    minecraft_version: &str,
    loader_version: Option<&str>,
    loader_args: &str,
) -> Result<Option<String>, AppError> {
    let normalized = loader_args.replace('\\', "/");
    match loader_name {
        "Forge" => {
            let expected_version =
                crate::servers::process::forge_build_version(minecraft_version, loader_version)?;
            let expected_args =
                format!("libraries/net/minecraftforge/forge/{expected_version}/win_args.txt");
            if !normalized.eq_ignore_ascii_case(&expected_args) {
                return Err(invalid_launch(
                    "Forge argument file does not match the database-pinned build".into(),
                ));
            }
            Ok(Some(format!(
                "libraries/net/minecraftforge/forge/{expected_version}/forge-{expected_version}-server.jar"
            )))
        }
        "NeoForge" => {
            let version = loader_version
                .filter(|version| safe_version_segment(version))
                .ok_or_else(|| invalid_launch("NeoForge server version is invalid".into()))?;
            let prefix = match minecraft_version {
                "1.20.1" => "47.",
                "1.20.4" => "20.4.",
                "1.20.6" => "20.6.",
                "1.21" => "21.0.",
                _ => {
                    return Err(invalid_launch(format!(
                    "NeoForge has no supported version mapping for Minecraft {minecraft_version}"
                )))
                }
            };
            if !version.starts_with(prefix) {
                return Err(invalid_launch(
                    "NeoForge pin does not map to the saved Minecraft version".into(),
                ));
            }
            let expected_args = format!("libraries/net/neoforged/neoforge/{version}/win_args.txt");
            if !normalized.eq_ignore_ascii_case(&expected_args) {
                return Err(invalid_launch(
                    "NeoForge argument file does not match the database-pinned build".into(),
                ));
            }
            Ok(Some(format!(
                "libraries/net/neoforged/neoforge/{version}/neoforge-{version}-server.jar"
            )))
        }
        _ => Ok(None),
    }
}

fn checked_directory(path: &Path, label: &str) -> Result<std::path::PathBuf, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| format!("{label}: {error}"))?;
    if !metadata.is_dir() || is_reparse_point(&metadata) {
        return Err(format!("{label} is not a regular non-reparse directory"));
    }
    fs::canonicalize(path).map_err(|error| format!("{label}: {error}"))
}

fn checked_regular_file(path: &Path, label: &str) -> Result<std::path::PathBuf, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| format!("{label}: {error}"))?;
    if !metadata.file_type().is_file() || is_reparse_point(&metadata) || metadata.len() == 0 {
        return Err(format!("{label} is not a nonempty regular file"));
    }
    fs::canonicalize(path).map_err(|error| format!("{label}: {error}"))
}

fn checked_server_file(root: &Path, relative: &str, label: &str) -> Result<(), AppError> {
    validate_safe_relative_path(relative).map_err(|error| invalid_launch(error.to_string()))?;
    let canonical_root =
        fs::canonicalize(root).map_err(|error| invalid_launch(error.to_string()))?;
    let mut current = root.to_path_buf();
    let components = relative.split('/').collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        current.push(component);
        let metadata = fs::symlink_metadata(&current)
            .map_err(|_| invalid_launch(format!("required {label} is missing: {relative}")))?;
        let final_component = index + 1 == components.len();
        if is_reparse_point(&metadata)
            || (final_component && !metadata.file_type().is_file())
            || (!final_component && !metadata.is_dir())
        {
            return Err(invalid_launch(format!(
                "required {label} is not contained in a regular server path: {relative}"
            )));
        }
        let canonical = fs::canonicalize(&current)
            .map_err(|error| invalid_launch(format!("{label} {relative}: {error}")))?;
        if !canonical.starts_with(&canonical_root) || canonical == canonical_root {
            return Err(invalid_launch(format!(
                "required {label} escapes the server directory: {relative}"
            )));
        }
        if final_component && metadata.len() == 0 {
            return Err(invalid_launch(format!(
                "required {label} is empty: {relative}"
            )));
        }
    }
    Ok(())
}

fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x0400 != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn safe_version_segment(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 96
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b'+'))
}

fn invalid_launch(message: String) -> AppError {
    AppError::Validation(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("pipeline-launch-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn launch_config_uses_argument_list_and_never_invokes_generated_scripts() {
        let temp = TempDir::new();
        let app_data = temp.0.join("app-data");
        let server_root = app_data.join("servers/server-fixture");
        let forge_version = "1.20.1-47.2.0";
        let loader_args = format!(
            "libraries/example/bootstrap.jar;libraries/net/minecraftforge/forge/{forge_version}/forge-{forge_version}-server.jar"
        );
        let loader_args_path =
            format!("libraries/net/minecraftforge/forge/{forge_version}/win_args.txt");
        write_file(&temp.0.join("java.exe"), b"fixture java executable");
        write_file(&server_root.join("user_jvm_args.txt"), b"-Xmx2G\n");
        write_file(
            &server_root.join(&loader_args_path),
            format!("-p\n{loader_args}\n").as_bytes(),
        );
        write_file(
            &server_root.join("libraries/example/bootstrap.jar"),
            b"bootstrap jar",
        );
        write_file(
            &server_root.join(format!(
                "libraries/net/minecraftforge/forge/{forge_version}/forge-{forge_version}-server.jar"
            )),
            b"forge server payload",
        );
        write_file(
            &server_root.join("run.bat"),
            format!("@echo off\r\njava @user_jvm_args.txt @{loader_args_path} %*\r\necho should-not-run\r\n").as_bytes(),
        );

        let mode = RuntimeLaunchMode::ArgumentFiles {
            user_jvm_args: "user_jvm_args.txt".into(),
            loader_args: loader_args_path.clone(),
        };
        let java_path = temp.0.join("java.exe");
        let config = build_live_launch_config(
            "server-fixture",
            &app_data,
            &server_root,
            "Forge",
            "1.20.1",
            Some("specific:1.20.1-47.2.0"),
            java_path.to_string_lossy().as_ref(),
            4096,
            &mode,
        )
        .unwrap();

        assert_eq!(config.server_id, "server-fixture");
        assert_eq!(config.source, LaunchConfigSource::LoaderArguments);
        assert_eq!(
            config
                .loader_pin
                .as_ref()
                .unwrap()
                .loader_version
                .as_deref(),
            Some("specific:1.20.1-47.2.0")
        );
        assert_eq!(config.argv[0], "@user_jvm_args.txt");
        assert!(config
            .argv
            .iter()
            .any(|arg| arg == "@libraries/net/minecraftforge/forge/1.20.1-47.2.0/win_args.txt"));
        assert!(!config
            .argv
            .iter()
            .any(|arg| arg.to_ascii_lowercase().ends_with(".bat")));
        assert!(!server_root.join("should-not-run").exists());

        write_file(
            &server_root.join("run.bat"),
            b"@echo off\r\njava @user_jvm_args.txt @libraries/other/win_args.txt %*\r\n",
        );
        assert!(build_live_launch_config(
            "server-fixture",
            &app_data,
            &server_root,
            "Forge",
            "1.20.1",
            Some("specific:1.20.1-47.2.0"),
            java_path.to_string_lossy().as_ref(),
            4096,
            &mode,
        )
        .is_err());

        write_file(
            &server_root.join("run.bat"),
            format!("@echo off\r\njava @user_jvm_args.txt @{loader_args_path} %*\r\necho should-not-run\r\n").as_bytes(),
        );
        fs::remove_file(server_root.join("libraries/example/bootstrap.jar")).unwrap();
        assert!(build_live_launch_config(
            "server-fixture",
            &app_data,
            &server_root,
            "Forge",
            "1.20.1",
            Some("specific:1.20.1-47.2.0"),
            java_path.to_string_lossy().as_ref(),
            4096,
            &mode,
        )
        .is_err());

        let malformed_mode = RuntimeLaunchMode::ArgumentFiles {
            user_jvm_args: "user_jvm_args.txt".into(),
            loader_args: "../outside/win_args.txt".into(),
        };
        assert!(build_live_launch_config(
            "server-fixture",
            &app_data,
            &server_root,
            "Forge",
            "1.20.1",
            Some("specific:1.20.1-47.2.0"),
            java_path.to_string_lossy().as_ref(),
            4096,
            &malformed_mode,
        )
        .is_err());
    }

    #[test]
    fn direct_jar_config_contains_only_java_arguments_and_relative_server_jar() {
        let argv = build_argv(
            "server-fixture",
            4096,
            &RuntimeLaunchMode::Jar {
                file_name: "server.jar".into(),
            },
        )
        .unwrap();
        assert_eq!(
            argv,
            [
                "-Xmx4096M",
                "-Xms4096M",
                "-Dtestmultiai.server.id=server-fixture",
                "-jar",
                "server.jar",
                "nogui",
            ]
        );
        assert!(argv
            .iter()
            .all(|argument| !argument.to_ascii_lowercase().contains("cmd.exe")));
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
}
