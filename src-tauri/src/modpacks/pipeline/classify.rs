use std::path::Path;

use crate::modpacks::{curseforge_import, install};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CurseForgeArchiveClassification {
    ServerPack {
        minecraft_version: String,
        loader: String,
        loader_version: String,
        server_pack_creator: bool,
    },
    ClientExport {
        reason: String,
    },
    Unsupported {
        reason: String,
    },
    Invalid {
        reason: String,
    },
}

pub fn classify_curseforge_server_zip(path: &Path) -> CurseForgeArchiveClassification {
    match curseforge_import::classify_archive_contents(path) {
        curseforge_import::ArchiveContentClassification::ServerPack(pack) => {
            CurseForgeArchiveClassification::ServerPack {
                minecraft_version: pack.detected.minecraft_version,
                loader: pack.detected.loader,
                loader_version: pack.detected.loader_version,
                server_pack_creator: pack.detected.server_pack_creator,
            }
        }
        curseforge_import::ArchiveContentClassification::ClientExport(reason) => {
            CurseForgeArchiveClassification::ClientExport { reason }
        }
        curseforge_import::ArchiveContentClassification::Unsupported(reason) => {
            CurseForgeArchiveClassification::Unsupported { reason }
        }
        curseforge_import::ArchiveContentClassification::Invalid(reason) => {
            CurseForgeArchiveClassification::Invalid { reason }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MrpackLoader {
    Vanilla,
    Fabric,
    Forge,
    NeoForge,
    Quilt,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalMrpackMetadata {
    pub format_version: u32,
    pub game: String,
    pub name: String,
    /// The pack author's value for display only; it is not a trusted provider pin.
    pub display_version_id: String,
    pub minecraft_version: String,
    pub loader: MrpackLoader,
    pub loader_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalMrpackClassification {
    Supported(LocalMrpackMetadata),
    QuiltPlaceholder(LocalMrpackMetadata),
    Unsupported { reason: String },
    Invalid { reason: String },
}

pub fn inspect_local_mrpack(path: &Path) -> LocalMrpackClassification {
    let metadata = match install::inspect_mrpack_metadata(path) {
        Ok(metadata) => metadata,
        Err(install::MrpackMetadataError::Unsupported(reason)) => {
            return LocalMrpackClassification::Unsupported { reason }
        }
        Err(install::MrpackMetadataError::Invalid(reason)) => {
            return LocalMrpackClassification::Invalid { reason }
        }
    };
    let metadata = LocalMrpackMetadata {
        format_version: metadata.format_version,
        game: metadata.game,
        name: metadata.name,
        display_version_id: metadata.display_version_id,
        minecraft_version: metadata.minecraft_version,
        loader: match metadata.loader {
            install::MrpackLoader::Vanilla => MrpackLoader::Vanilla,
            install::MrpackLoader::Fabric => MrpackLoader::Fabric,
            install::MrpackLoader::Forge => MrpackLoader::Forge,
            install::MrpackLoader::NeoForge => MrpackLoader::NeoForge,
            install::MrpackLoader::Quilt => MrpackLoader::Quilt,
        },
        loader_version: metadata.loader_version,
    };

    if metadata.loader == MrpackLoader::Quilt {
        LocalMrpackClassification::QuiltPlaceholder(metadata)
    } else {
        LocalMrpackClassification::Supported(metadata)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Write, path::PathBuf};
    use zip::{write::SimpleFileOptions, ZipWriter};

    struct TempMrpack(PathBuf);

    impl TempMrpack {
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
                "mc-server-manager-mrpack-metadata-{}.payload",
                uuid::Uuid::new_v4()
            ));
            fs::write(&path, bytes).unwrap();
            Self(path)
        }
    }

    impl Drop for TempMrpack {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    fn index(dependencies: &str, version_id: &str) -> String {
        format!(
            r#"{{"formatVersion":1,"game":"minecraft","name":"Generated fixture","versionId":"{version_id}","files":[],"dependencies":{{{dependencies}}}}}"#
        )
    }

    fn inspect_index(json: &str) -> LocalMrpackClassification {
        let archive = TempMrpack::from_entries(&[("modrinth.index.json", json.as_bytes())]);
        inspect_local_mrpack(&archive.0)
    }

    #[test]
    fn local_mrpack_reads_root_metadata_without_trusting_version_id() {
        let metadata = index(
            r#""minecraft":"1.20.1","fabric-loader":"0.15.11""#,
            "author-version",
        );
        let classification = inspect_index(&metadata);

        let LocalMrpackClassification::Supported(metadata) = classification else {
            panic!("expected a supported local mrpack, got {classification:?}");
        };
        assert_eq!(metadata.format_version, 1);
        assert_eq!(metadata.game, "minecraft");
        assert_eq!(metadata.name, "Generated fixture");
        assert_eq!(metadata.display_version_id, "author-version");
        assert_eq!(metadata.minecraft_version, "1.20.1");
        assert_eq!(metadata.loader, MrpackLoader::Fabric);
        assert_eq!(metadata.loader_version.as_deref(), Some("0.15.11"));
    }

    #[test]
    fn local_mrpack_accepts_exact_supported_loaders_and_vanilla() {
        let cases = [
            (r#""minecraft":"1.20.1""#, MrpackLoader::Vanilla, None),
            (
                r#""minecraft":"1.20.1","fabric-loader":"0.15.11""#,
                MrpackLoader::Fabric,
                Some("0.15.11"),
            ),
            (
                r#""minecraft":"1.20.1","forge":"47.2.0""#,
                MrpackLoader::Forge,
                Some("47.2.0"),
            ),
            (
                r#""minecraft":"1.20.1","neoforge":"20.4.237""#,
                MrpackLoader::NeoForge,
                Some("20.4.237"),
            ),
        ];

        for (dependencies, expected_loader, expected_version) in cases {
            let classification = inspect_index(&index(dependencies, "author-version"));
            let LocalMrpackClassification::Supported(metadata) = classification else {
                panic!("expected supported metadata, got {classification:?}");
            };
            assert_eq!(metadata.loader, expected_loader);
            assert_eq!(metadata.loader_version.as_deref(), expected_version);
            assert_eq!(metadata.display_version_id, "author-version");
        }
    }

    #[test]
    fn local_mrpack_quilt_is_an_explicit_placeholder() {
        let classification = inspect_index(&index(
            r#""minecraft":"1.20.1","quilt-loader":"0.24.0""#,
            "author-version",
        ));
        let LocalMrpackClassification::QuiltPlaceholder(metadata) = classification else {
            panic!("expected Quilt placeholder, got {classification:?}");
        };
        assert_eq!(metadata.loader, MrpackLoader::Quilt);
        assert_eq!(metadata.loader_version.as_deref(), Some("0.24.0"));
    }

    #[test]
    fn local_mrpack_rejects_missing_root_index_and_unsupported_metadata() {
        let nested_index = TempMrpack::from_entries(&[(
            "nested/modrinth.index.json",
            index(r#""minecraft":"1.20.1""#, "author-version").as_bytes(),
        )]);
        assert!(matches!(
            inspect_local_mrpack(&nested_index.0),
            LocalMrpackClassification::Invalid { .. }
        ));

        let unsupported_loader = inspect_index(&index(
            r#""minecraft":"1.20.1","unknown-loader":"2.0""#,
            "author-version",
        ));
        assert!(matches!(
            unsupported_loader,
            LocalMrpackClassification::Unsupported { .. }
        ));

        let unsupported_game = index(r#""minecraft":"1.20.1""#, "author-version")
            .replace("\"game\":\"minecraft\"", "\"game\":\"other\"");
        assert!(matches!(
            inspect_index(&unsupported_game),
            LocalMrpackClassification::Unsupported { .. }
        ));

        let unsupported_format = index(r#""minecraft":"1.20.1""#, "author-version")
            .replace("\"formatVersion\":1", "\"formatVersion\":2");
        assert!(matches!(
            inspect_index(&unsupported_format),
            LocalMrpackClassification::Unsupported { .. }
        ));
    }

    #[test]
    fn local_mrpack_requires_nonempty_name_and_version_id() {
        let valid = index(r#""minecraft":"1.20.1""#, "author-version");
        let cases = [
            valid.replace("\"name\":\"Generated fixture\",", ""),
            valid.replace("\"name\":\"Generated fixture\"", "\"name\":\"\""),
            valid.replace(",\"versionId\":\"author-version\"", ""),
            valid.replace("\"versionId\":\"author-version\"", "\"versionId\":\"\""),
        ];

        for invalid in cases {
            assert!(matches!(
                inspect_index(&invalid),
                LocalMrpackClassification::Invalid { .. }
            ));
        }
    }
}
