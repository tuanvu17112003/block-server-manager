use super::{
    ensure_not_cancelled, make_plan,
    snapshot::{snapshot_archive_with_cancel, ArchiveSnapshot},
    PlanContext, ProviderResolutionError, ResolutionCheckpoint,
};
use crate::modpacks::{
    curseforge_import::{self, ArchiveContentClassification},
    install,
    pipeline::{
        model::{
            validate_safe_relative_path, ExactPackPin, FileDecision, ProviderPin, ProviderSource,
        },
        plan::{InstallPlan, LoaderKind, LoaderPin},
        selection::{select_file, EnvironmentPolicy, FilePolicyEvidence},
    },
};
use std::{collections::HashSet, path::Path};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedCurseForgeServerZip {
    pub plan: InstallPlan,
    pub server_pack_creator: bool,
    pub included_files: Vec<String>,
    pub warnings: Vec<String>,
}

pub fn resolve_author_server_zip(
    archive_path: &Path,
    context: PlanContext,
) -> Result<ResolvedCurseForgeServerZip, ProviderResolutionError> {
    resolve_author_server_zip_with_cancel(archive_path, context, |_, _| false)
}

pub fn resolve_author_server_zip_with_cancel<F>(
    archive_path: &Path,
    context: PlanContext,
    mut is_cancelled: F,
) -> Result<ResolvedCurseForgeServerZip, ProviderResolutionError>
where
    F: FnMut(ResolutionCheckpoint, &Path) -> bool,
{
    let snapshot = snapshot_archive_with_cancel(archive_path, install::MAX_MRPACK_BYTES, |_| {
        is_cancelled(ResolutionCheckpoint::SnapshotCopy, archive_path)
    })?;
    resolve_author_server_zip_from_snapshot(&snapshot, archive_path, context, is_cancelled)
}

pub(crate) fn resolve_author_server_zip_from_snapshot<F>(
    snapshot: &ArchiveSnapshot,
    archive_path: &Path,
    context: PlanContext,
    mut is_cancelled: F,
) -> Result<ResolvedCurseForgeServerZip, ProviderResolutionError>
where
    F: FnMut(ResolutionCheckpoint, &Path) -> bool,
{
    ensure_not_cancelled(
        &mut is_cancelled,
        ResolutionCheckpoint::SnapshotReady,
        snapshot.path(),
    )?;
    let classification =
        match curseforge_import::classify_archive_contents_with_cancel(snapshot.path(), |_| {
            is_cancelled(ResolutionCheckpoint::NestedArchiveCopy, snapshot.path())
        }) {
            Ok(classified) => classified,
            Err(curseforge_import::PreparedArchiveError::App(error)) => {
                return Err(ProviderResolutionError::Io(error.to_string()))
            }
            Err(curseforge_import::PreparedArchiveError::Cancelled) => {
                return Err(ProviderResolutionError::Cancelled)
            }
        };
    let classified = match classification {
        ArchiveContentClassification::ServerPack(pack) => pack,
        ArchiveContentClassification::ClientExport(reason) => {
            return Err(ProviderResolutionError::Unsupported(format!(
                "CurseForge client exports cannot be installed as servers: {reason}"
            )))
        }
        ArchiveContentClassification::Unsupported(reason) => {
            return Err(ProviderResolutionError::Unsupported(reason))
        }
        ArchiveContentClassification::Invalid(reason) => {
            return Err(ProviderResolutionError::Malformed(reason))
        }
    };
    ensure_not_cancelled(
        &mut is_cancelled,
        ResolutionCheckpoint::ArchiveClassified,
        snapshot.path(),
    )?;
    let file_name = archive_path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty() && !name.chars().any(char::is_control))
        .ok_or_else(|| {
            ProviderResolutionError::Malformed(
                "staged CurseForge archive has no safe display filename".into(),
            )
        })?;
    validate_safe_relative_path(file_name).map_err(ProviderResolutionError::InvalidModel)?;
    let loader = loader_pin(
        &classified.detected.loader,
        &classified.detected.minecraft_version,
        &classified.detected.loader_version,
    )?;
    let source_pin = ProviderPin {
        source: ProviderSource::CurseForge,
        exact: ExactPackPin::CurseForgeServerArchive {
            file_name: file_name.to_string(),
            archive: snapshot.fingerprint().clone(),
        },
    };

    if classified.files.is_empty() {
        return Err(ProviderResolutionError::Malformed(
            "classified CurseForge server archive contains no files".into(),
        ));
    }
    let mut paths = HashSet::with_capacity(classified.files.len());
    let mut decisions = Vec::<FileDecision>::with_capacity(classified.files.len());
    let mut included_files = Vec::with_capacity(classified.files.len());
    let mut warnings = Vec::new();
    for path in classified.files {
        ensure_not_cancelled(
            &mut is_cancelled,
            ResolutionCheckpoint::FilePolicy,
            snapshot.path(),
        )?;
        if !paths.insert(path.to_lowercase()) {
            return Err(ProviderResolutionError::Malformed(format!(
                "CurseForge server archive contains duplicate path {path}"
            )));
        }
        let selected = select_file(FilePolicyEvidence {
            path: path.clone(),
            server: vec![EnvironmentPolicy::Required],
            client: Vec::new(),
            server_metadata_missing: false,
            choice: None,
        })
        .map_err(ProviderResolutionError::InvalidModel)?;
        warnings.extend(selected.warnings);
        included_files.push(path);
        decisions.push(selected.decision);
    }

    ensure_not_cancelled(
        &mut is_cancelled,
        ResolutionCheckpoint::BeforePlan,
        snapshot.path(),
    )?;
    included_files.sort();
    let plan = make_plan(context, source_pin, loader, decisions)?;
    ensure_not_cancelled(
        &mut is_cancelled,
        ResolutionCheckpoint::PlanValidated,
        snapshot.path(),
    )?;
    Ok(ResolvedCurseForgeServerZip {
        plan,
        server_pack_creator: classified.detected.server_pack_creator,
        included_files,
        warnings,
    })
}

fn loader_pin(
    loader: &str,
    minecraft_version: &str,
    loader_version: &str,
) -> Result<LoaderPin, ProviderResolutionError> {
    let kind = match loader {
        "Fabric" => LoaderKind::Fabric,
        "Forge" => LoaderKind::Forge,
        "NeoForge" => LoaderKind::NeoForge,
        "Quilt" => {
            return Err(ProviderResolutionError::Unsupported(
                "Quilt imports remain a disabled placeholder".into(),
            ))
        }
        _ => {
            return Err(ProviderResolutionError::Unsupported(format!(
                "CurseForge server archive loader {loader} is unsupported"
            )))
        }
    };
    Ok(LoaderPin {
        kind,
        minecraft_version: minecraft_version.to_string(),
        loader_version: Some(loader_version.to_string()),
    })
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::modpacks::pipeline::{
        model::{ArchiveVerification, ExactPackPin, FileDecisionAction, FileDecisionReason},
        plan::InstallTarget,
    };
    use std::{fs, io::Write, path::PathBuf};
    use zip::{write::SimpleFileOptions, ZipWriter};

    struct TempZip(PathBuf);

    impl TempZip {
        fn from_entries(entries: &[(&str, &[u8])]) -> Self {
            let mut writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
            for (name, bytes) in entries {
                writer
                    .start_file(*name, SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(bytes).unwrap();
            }
            let bytes = writer.finish().unwrap().into_inner();
            let path = std::env::temp_dir().join(format!(
                "pipeline-curseforge-{}.payload",
                uuid::Uuid::new_v4()
            ));
            fs::write(&path, bytes).unwrap();
            Self(path)
        }
    }

    impl Drop for TempZip {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    fn context() -> PlanContext {
        PlanContext {
            plan_id: "plan-curseforge".into(),
            created_at: "2026-10-11T00:00:00Z".into(),
            target: InstallTarget {
                server_id: "server-1".into(),
                server_name: "Fixture server".into(),
                directory: "servers/server-1".into(),
            },
        }
    }

    fn spsc_fixture() -> TempZip {
        let manifest = br#"{"files":["mods/example.jar"],"minecraftVersion":"1.20.1","modloader":"Fabric","modloaderVersion":"0.19.3","serverPackCreatorVersion":"8.1.2"}"#;
        TempZip::from_entries(&[
            ("manifest.json", manifest),
            ("mods/example.jar", b"fixture mod"),
            ("start.bat", b"not executed"),
        ])
    }

    fn forge_fixture() -> TempZip {
        TempZip::from_entries(&[
            (
                "run.bat",
                b"@echo off\r\njava @user_jvm_args.txt @libraries\\net\\minecraftforge\\forge\\1.20.1-47.2.0\\win_args.txt %*\r\n",
            ),
            ("user_jvm_args.txt", b"-Xmx4G\n"),
            (
                "libraries/net/minecraftforge/forge/1.20.1-47.2.0/win_args.txt",
                b"--launchTarget forgeserver -jar libraries/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-server.jar\n",
            ),
            (
                "libraries/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-server.jar",
                b"fixture server shim",
            ),
            ("libraries/example/runtime.jar", b"fixture jar"),
            ("mods/example.jar", b"fixture mod"),
        ])
    }

    #[test]
    fn resolves_only_content_classified_author_server_archives_keylessly() {
        let zip = spsc_fixture();
        let resolved = resolve_author_server_zip(&zip.0, context()).unwrap();
        assert!(resolved.server_pack_creator);
        assert!(resolved
            .included_files
            .iter()
            .any(|path| path == "mods/example.jar"));
        assert!(resolved.plan.file_decisions.iter().all(|decision| {
            decision.action == FileDecisionAction::Include
                && decision.reason == FileDecisionReason::Required
                && decision.side == Some(crate::modpacks::pipeline::model::FileSide::Server)
        }));
        assert!(resolved.warnings.is_empty());
        let ExactPackPin::CurseForgeServerArchive { archive, .. } = &resolved.plan.source_pin.exact
        else {
            panic!("expected a CurseForge server archive pin");
        };
        assert_eq!(
            archive.verification,
            ArchiveVerification::CalculatedFingerprint
        );
        assert!(resolved.plan.validate().is_ok());

        let forge = forge_fixture();
        let resolved = resolve_author_server_zip(&forge.0, context()).unwrap();
        assert_eq!(resolved.plan.loader.kind, LoaderKind::Forge);
        assert!(resolved.plan.file_decisions.iter().all(|decision| {
            decision.side == Some(crate::modpacks::pipeline::model::FileSide::Server)
                && decision.action == FileDecisionAction::Include
                && decision.reason == FileDecisionReason::Required
        }));
        assert!(resolved.warnings.is_empty());
    }

    #[test]
    fn generic_zip_and_client_exports_are_never_treated_as_server_packs() {
        let generic = TempZip::from_entries(&[("readme.txt", b"not a server pack")]);
        assert!(matches!(
            resolve_author_server_zip(&generic.0, context()),
            Err(ProviderResolutionError::Unsupported(_))
        ));

        let client_export = TempZip::from_entries(&[(
            "manifest.json",
            br#"{"manifestType":"minecraftModpack","manifestVersion":1,"minecraft":{"version":"1.20.1","modLoaders":[]},"files":[]}"#,
        )]);
        assert!(matches!(
            resolve_author_server_zip(&client_export.0, context()),
            Err(ProviderResolutionError::Unsupported(message)) if message.contains("client exports")
        ));

        let malformed_path = std::env::temp_dir().join(format!(
            "pipeline-curseforge-invalid-{}.payload",
            uuid::Uuid::new_v4()
        ));
        fs::write(&malformed_path, b"not a zip archive").unwrap();
        assert!(matches!(
            resolve_author_server_zip(&malformed_path, context()),
            Err(ProviderResolutionError::Malformed(_))
        ));
        let _ = fs::remove_file(malformed_path);
    }
}
