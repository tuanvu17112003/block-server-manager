//! Read-only Modrinth modpack catalog commands.

pub(crate) mod curseforge_import;
pub(crate) mod install;
pub mod pipeline;

use crate::{error::AppError, installer};
use serde::Serialize;
use serde_json::Value;

const API_BASE: &str = "https://api.modrinth.com/v2";
const MAX_QUERY_BYTES: usize = 256;
const MAX_OFFSET: u32 = 1_000_000;
const MAX_PAGE_SIZE: u32 = 100;

const LOADER_TAGS: &[&str] = &[
    "bukkit",
    "bungeecord",
    "canvas",
    "datapack",
    "fabric",
    "folia",
    "forge",
    "liteloader",
    "minecraft",
    "neoforge",
    "ornithe",
    "paper",
    "purpur",
    "quilt",
    "rift",
    "sponge",
    "spongeforge",
    "spongevanilla",
    "spigot",
    "velocity",
    "waterfall",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    results: Vec<ModpackResult>,
    offset: u32,
    limit: u32,
    total_hits: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModpackResult {
    id: String,
    name: String,
    author: String,
    downloads: u64,
    game_versions: Vec<String>,
    loaders: Vec<String>,
    icon_url: Option<String>,
    summary: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectVersion {
    id: String,
    name: String,
    version_number: String,
    game_versions: Vec<String>,
    loaders: Vec<String>,
    changelog: String,
    files: Vec<VersionFile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionFile {
    url: String,
    filename: String,
    size: u64,
    primary: bool,
    hashes: FileHashes,
}

#[derive(Debug, Serialize)]
pub struct FileHashes {
    sha1: String,
    sha512: String,
}

#[tauri::command]
pub async fn modrinth_search_modpacks(
    query: String,
    game_version: Option<String>,
    loader: Option<String>,
    index: String,
    offset: u32,
    limit: u32,
) -> Result<SearchResponse, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        search_modpacks(query, game_version, loader, index, offset, limit)
    })
    .await
    .map_err(|e| AppError::Internal(format!("Modrinth search task failed: {e}")))?
}

#[tauri::command]
pub async fn modrinth_project_versions(
    project_id: String,
    game_version: Option<String>,
    loader: Option<String>,
) -> Result<Vec<ProjectVersion>, AppError> {
    tauri::async_runtime::spawn_blocking(move || project_versions(project_id, game_version, loader))
        .await
        .map_err(|e| AppError::Internal(format!("Modrinth version lookup task failed: {e}")))?
}

fn search_modpacks(
    query: String,
    game_version: Option<String>,
    loader: Option<String>,
    index: String,
    offset: u32,
    limit: u32,
) -> Result<SearchResponse, AppError> {
    let query = validate_query(&query)?;
    let game_version = validate_game_version(game_version.as_deref())?;
    let loader = validate_loader(loader.as_deref())?;
    validate_index(&index)?;
    if offset > MAX_OFFSET {
        return Err(validation("search offset exceeds the supported range"));
    }
    let limit = limit.clamp(1, MAX_PAGE_SIZE);

    let mut facets = vec![vec!["project_type:modpack".to_string()]];
    if let Some(version) = game_version.as_deref() {
        facets.push(vec![format!("versions:{version}")]);
    }
    if let Some(loader) = loader.as_deref() {
        facets.push(vec![format!("categories:{loader}")]);
    }
    let facets = serde_json::to_string(&facets)
        .map_err(|_| AppError::Internal("could not encode Modrinth search filters".into()))?;

    let mut url = format!(
        "{API_BASE}/search?index={}&offset={offset}&limit={limit}&facets={}",
        index,
        encode_component(&facets)
    );
    if !query.is_empty() {
        url.push_str("&query=");
        url.push_str(&encode_component(query));
    }

    let response = installer::fetch_modrinth_json(&url)?;
    let hits = response
        .get("hits")
        .and_then(Value::as_array)
        .ok_or_else(|| malformed("search hits"))?;
    let total_hits = response
        .get("total_hits")
        .and_then(Value::as_u64)
        .ok_or_else(|| malformed("search total_hits"))?;

    let mut results = Vec::with_capacity(hits.len());
    for hit in hits {
        let id = required_string(hit, "project_id")?.to_string();
        if !valid_modrinth_id(&id) {
            return Err(malformed("project ID"));
        }
        let game_versions = string_array(hit, "versions")?;
        let categories = string_array(hit, "categories")?;
        if game_version
            .as_deref()
            .is_some_and(|version| !game_versions.iter().any(|item| item == version))
            || loader
                .as_deref()
                .is_some_and(|value| !categories.iter().any(|item| item == value))
        {
            continue;
        }

        let mut loaders = categories
            .into_iter()
            .filter(|category| LOADER_TAGS.contains(&category.as_str()))
            .collect::<Vec<_>>();
        if let Some(selected) = loader.as_deref() {
            if !loaders.iter().any(|item| item == selected) {
                loaders.push(selected.to_string());
            }
        }
        let icon_url = optional_string(hit, "icon_url")?;
        let icon_url = icon_url.filter(|url| valid_https_url(url));

        results.push(ModpackResult {
            id,
            name: required_string(hit, "title")?.to_string(),
            author: required_string(hit, "author")?.to_string(),
            downloads: required_u64(hit, "downloads")?,
            game_versions,
            loaders,
            icon_url,
            summary: required_string(hit, "description")?.to_string(),
        });
    }

    Ok(SearchResponse {
        results,
        offset,
        limit,
        total_hits,
    })
}

fn project_versions(
    project_id: String,
    game_version: Option<String>,
    loader: Option<String>,
) -> Result<Vec<ProjectVersion>, AppError> {
    if !valid_modrinth_id(&project_id) {
        return Err(validation(
            "project ID must be an eight-character Modrinth ID",
        ));
    }
    let game_version = validate_game_version(game_version.as_deref())?;
    let loader = validate_loader(loader.as_deref())?;

    let mut params = vec!["include_changelog=true".to_string()];
    if let Some(version) = game_version.as_deref() {
        let value = serde_json::to_string(&[version])
            .map_err(|_| AppError::Internal("could not encode Modrinth version filter".into()))?;
        params.push(format!("game_versions={}", encode_component(&value)));
    }
    if let Some(loader) = loader.as_deref() {
        let value = serde_json::to_string(&[loader])
            .map_err(|_| AppError::Internal("could not encode Modrinth loader filter".into()))?;
        params.push(format!("loaders={}", encode_component(&value)));
    }

    let url = format!(
        "{API_BASE}/project/{project_id}/version?{}",
        params.join("&")
    );
    let response = installer::fetch_modrinth_json(&url)?;
    let versions = response
        .as_array()
        .ok_or_else(|| malformed("project versions"))?;
    let mut output = Vec::with_capacity(versions.len());
    for version in versions {
        let game_versions = string_array(version, "game_versions")?;
        let loaders = string_array(version, "loaders")?;
        if game_version
            .as_deref()
            .is_some_and(|selected| !game_versions.iter().any(|item| item == selected))
            || loader
                .as_deref()
                .is_some_and(|selected| !loaders.iter().any(|item| item == selected))
        {
            continue;
        }

        let id = required_string(version, "id")?.to_string();
        if !valid_modrinth_id(&id) {
            return Err(malformed("version ID"));
        }
        let changelog = optional_string(version, "changelog")?.unwrap_or_default();
        let files = version
            .get("files")
            .and_then(Value::as_array)
            .ok_or_else(|| malformed("version files"))?
            .iter()
            .map(parse_file)
            .collect::<Result<Vec<_>, _>>()?;

        output.push(ProjectVersion {
            id,
            name: required_string(version, "name")?.to_string(),
            version_number: required_string(version, "version_number")?.to_string(),
            game_versions,
            loaders,
            changelog,
            files,
        });
    }
    Ok(output)
}

fn parse_file(file: &Value) -> Result<VersionFile, AppError> {
    let url = required_string(file, "url")?.to_string();
    if !valid_https_url(&url) {
        return Err(malformed("file URL"));
    }
    let hashes = file.get("hashes").ok_or_else(|| malformed("file hashes"))?;
    let sha1 = required_string(hashes, "sha1")?.to_string();
    let sha512 = required_string(hashes, "sha512")?.to_string();
    if !valid_hex_hash(&sha1, 40) || !valid_hex_hash(&sha512, 128) {
        return Err(malformed("file hashes"));
    }

    Ok(VersionFile {
        url,
        filename: required_string(file, "filename")?.to_string(),
        size: required_u64(file, "size")?,
        primary: file
            .get("primary")
            .and_then(Value::as_bool)
            .ok_or_else(|| malformed("file primary flag"))?,
        hashes: FileHashes { sha1, sha512 },
    })
}

fn validate_query(query: &str) -> Result<&str, AppError> {
    if query.len() > MAX_QUERY_BYTES || query.chars().any(char::is_control) {
        return Err(validation(
            "search query is too long or contains control characters",
        ));
    }
    Ok(query.trim())
}

fn validate_game_version(value: Option<&str>) -> Result<Option<String>, AppError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let bytes = value.as_bytes();
    let valid = !value.is_empty()
        && value.len() <= 96
        && bytes.first().is_some_and(|byte| byte.is_ascii_digit())
        && bytes.last().is_some_and(|byte| byte.is_ascii_digit())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_digit() || *byte == b'.')
        && !value.contains("..");
    if !valid {
        return Err(validation("game version must be a numeric dotted version"));
    }
    Ok(Some(value.to_string()))
}

fn validate_loader(value: Option<&str>) -> Result<Option<String>, AppError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let valid = !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if !valid {
        return Err(validation("loader must be a lowercase Modrinth loader tag"));
    }
    Ok(Some(value.to_string()))
}

fn validate_index(index: &str) -> Result<(), AppError> {
    if matches!(
        index,
        "relevance" | "downloads" | "follows" | "newest" | "updated"
    ) {
        Ok(())
    } else {
        Err(validation("unsupported Modrinth search index"))
    }
}

fn valid_modrinth_id(value: &str) -> bool {
    value.len() == 8 && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn valid_https_url(value: &str) -> bool {
    let Some(authority) = value.strip_prefix("https://").map(|rest| {
        rest.split(|ch| matches!(ch, '/' | '?' | '#'))
            .next()
            .unwrap_or_default()
    }) else {
        return false;
    };
    value.len() <= 4096
        && authority.contains('.')
        && authority
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
        && !value
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
}

fn valid_hex_hash(value: &str, expected_len: usize) -> bool {
    value.len() == expected_len && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn encode_component(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push(HEX[(byte >> 4) as usize] as char);
            encoded.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    encoded
}

fn required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, AppError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| malformed(field))
}

fn optional_string(value: &Value, field: &str) -> Result<Option<String>, AppError> {
    match value.get(field) {
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(Value::Null) => Ok(None),
        _ => Err(malformed(field)),
    }
}

fn required_u64(value: &Value, field: &str) -> Result<u64, AppError> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| malformed(field))
}

fn string_array(value: &Value, field: &str) -> Result<Vec<String>, AppError> {
    value
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| malformed(field))?
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_string)
                .ok_or_else(|| malformed(field))
        })
        .collect()
}

fn malformed(field: &str) -> AppError {
    AppError::Validation(format!("Modrinth returned malformed {field}"))
}

fn validation(message: &str) -> AppError {
    AppError::Validation(message.to_string())
}
