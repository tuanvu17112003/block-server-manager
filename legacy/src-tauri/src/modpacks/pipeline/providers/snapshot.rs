use super::ProviderResolutionError;
use crate::modpacks::pipeline::model::{ArchiveFingerprint, ArchiveVerification, ContentHashes};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

const SNAPSHOT_CHUNK_BYTES: usize = 128 * 1024;
const MAX_CNG_OBJECT_BYTES: usize = 1024 * 1024;
// Allows for filesystem metadata and normal concurrent temp-volume activity.
const SNAPSHOT_HEADROOM_BYTES: u64 = 16 * 1024 * 1024;
#[cfg(windows)]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
#[cfg(windows)]
const FILE_SHARE_READ: u32 = 0x0000_0001;

pub(crate) struct ArchiveSnapshot {
    path: PathBuf,
    directory: PathBuf,
    fingerprint: ArchiveFingerprint,
    read_guard: Option<File>,
}

impl ArchiveSnapshot {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn fingerprint(&self) -> &ArchiveFingerprint {
        &self.fingerprint
    }
}

impl Drop for ArchiveSnapshot {
    fn drop(&mut self) {
        self.read_guard.take();
        let _ = fs::remove_file(&self.path);
        let _ = fs::remove_dir(&self.directory);
    }
}

pub(crate) fn snapshot_archive(
    source_path: &Path,
    maximum_bytes: u64,
) -> Result<ArchiveSnapshot, ProviderResolutionError> {
    snapshot_archive_with_cancel(source_path, maximum_bytes, |_| false)
}

pub(crate) fn snapshot_archive_with_cancel<F>(
    source_path: &Path,
    maximum_bytes: u64,
    is_cancelled: F,
) -> Result<ArchiveSnapshot, ProviderResolutionError>
where
    F: FnMut(&Path) -> bool,
{
    let temporary_root = std::env::temp_dir();
    snapshot_archive_with_probe(
        source_path,
        maximum_bytes,
        &temporary_root,
        |path| crate::java::free_disk_space(path).map_err(|error| error.to_string()),
        is_cancelled,
    )
}

fn snapshot_archive_with_probe<F, S>(
    source_path: &Path,
    maximum_bytes: u64,
    temporary_root: &Path,
    free_space: S,
    mut is_cancelled: F,
) -> Result<ArchiveSnapshot, ProviderResolutionError>
where
    F: FnMut(&Path) -> bool,
    S: FnOnce(&Path) -> Result<u64, String>,
{
    reject_reparse_components(source_path)?;
    let source_metadata = fs::symlink_metadata(source_path).map_err(|error| {
        ProviderResolutionError::Io(format!("{}: {error}", source_path.display()))
    })?;
    if !source_metadata.is_file() || metadata_is_reparse_point(&source_metadata) {
        return Err(ProviderResolutionError::Malformed(
            "archive must be a regular non-reparse file".into(),
        ));
    }
    if source_metadata.len() == 0 || source_metadata.len() > maximum_bytes {
        return Err(ProviderResolutionError::Malformed(format!(
            "archive size must be between 1 and {maximum_bytes} bytes"
        )));
    }

    let mut source = open_source_without_following_reparse_point(source_path).map_err(|error| {
        ProviderResolutionError::Io(format!("{}: {error}", source_path.display()))
    })?;
    let opened_metadata = source
        .metadata()
        .map_err(|error| ProviderResolutionError::Io(error.to_string()))?;
    if !opened_metadata.is_file() || metadata_is_reparse_point(&opened_metadata) {
        return Err(ProviderResolutionError::Malformed(
            "archive handle is not a regular non-reparse file".into(),
        ));
    }
    if opened_metadata.len() != source_metadata.len() {
        return Err(ProviderResolutionError::Malformed(
            "archive changed while it was being opened".into(),
        ));
    }

    reject_reparse_components(temporary_root)?;
    let root_metadata = fs::symlink_metadata(temporary_root)
        .map_err(|error| ProviderResolutionError::Io(error.to_string()))?;
    if !root_metadata.is_dir() || metadata_is_reparse_point(&root_metadata) {
        return Err(ProviderResolutionError::Malformed(
            "temporary snapshot volume path is not a regular directory".into(),
        ));
    }
    let required_bytes = source_metadata
        .len()
        .checked_add(SNAPSHOT_HEADROOM_BYTES)
        .ok_or_else(|| {
            ProviderResolutionError::Malformed("snapshot space requirement overflowed".into())
        })?;
    let available_bytes = free_space(temporary_root).map_err(|error| {
        ProviderResolutionError::Io(format!(
            "could not preflight temporary snapshot volume space: {error}"
        ))
    })?;
    if available_bytes < required_bytes {
        return Err(ProviderResolutionError::InsufficientSpace {
            required_bytes,
            available_bytes,
        });
    }

    let directory = create_private_snapshot_directory(temporary_root)?;
    let path = directory.join("archive.snapshot");
    let mut snapshot_file = ArchiveSnapshotFile::new(path.clone(), directory.clone());
    // Parsers reopen the snapshot for reading; this handle permits reads but excludes writes/deletes.
    let mut output_options = OpenOptions::new();
    output_options.read(true).write(true).create_new(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        output_options
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let mut output = output_options
        .open(&path)
        .map_err(|error| ProviderResolutionError::Io(error.to_string()))?;
    let mut hashers = cng::HashPair::new()
        .map_err(|error| ProviderResolutionError::Io(format!("Windows CNG: {error}")))?;
    let mut buffer = [0u8; SNAPSHOT_CHUNK_BYTES];
    let mut copied = 0u64;

    loop {
        if is_cancelled(&path) {
            return Err(ProviderResolutionError::Cancelled);
        }
        let read = Read::by_ref(&mut source)
            .take(SNAPSHOT_CHUNK_BYTES as u64)
            .read(&mut buffer)
            .map_err(|error| ProviderResolutionError::Io(error.to_string()))?;
        if read == 0 {
            break;
        }
        copied = copied
            .checked_add(read as u64)
            .ok_or_else(|| ProviderResolutionError::Malformed("archive size overflowed".into()))?;
        if copied > maximum_bytes {
            return Err(ProviderResolutionError::Malformed(format!(
                "archive exceeds the {maximum_bytes} byte limit"
            )));
        }

        let chunk = &buffer[..read];
        hashers
            .update(chunk)
            .map_err(|error| ProviderResolutionError::Io(format!("Windows CNG: {error}")))?;
        output
            .write_all(chunk)
            .map_err(|error| ProviderResolutionError::Io(error.to_string()))?;
    }

    let final_size = source
        .metadata()
        .map_err(|error| ProviderResolutionError::Io(error.to_string()))?
        .len();
    if copied != opened_metadata.len() || final_size != opened_metadata.len() {
        return Err(ProviderResolutionError::Malformed(
            "archive changed while its snapshot was being created".into(),
        ));
    }
    output
        .flush()
        .and_then(|_| output.sync_all())
        .map_err(|error| ProviderResolutionError::Io(error.to_string()))?;
    let snapshot_metadata = output
        .metadata()
        .map_err(|error| ProviderResolutionError::Io(error.to_string()))?;
    if !snapshot_metadata.is_file()
        || metadata_is_reparse_point(&snapshot_metadata)
        || snapshot_metadata.len() != copied
    {
        return Err(ProviderResolutionError::Malformed(
            "snapshot handle is not a regular non-reparse file of the expected size".into(),
        ));
    }

    let (sha1, sha512) = hashers
        .finish()
        .map_err(|error| ProviderResolutionError::Io(format!("Windows CNG: {error}")))?;
    let fingerprint = ArchiveFingerprint {
        hashes: ContentHashes { sha1, sha512 },
        size_bytes: copied,
        verification: ArchiveVerification::CalculatedFingerprint,
    };
    fingerprint
        .validate()
        .map_err(ProviderResolutionError::InvalidModel)?;
    snapshot_file.disarm();

    Ok(ArchiveSnapshot {
        path,
        directory,
        fingerprint,
        read_guard: Some(output),
    })
}

struct ArchiveSnapshotFile {
    path: PathBuf,
    directory: PathBuf,
    armed: bool,
}

impl ArchiveSnapshotFile {
    fn new(path: PathBuf, directory: PathBuf) -> Self {
        Self {
            path,
            directory,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ArchiveSnapshotFile {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
            let _ = fs::remove_dir(&self.directory);
        }
    }
}

fn create_private_snapshot_directory(
    temporary_root: &Path,
) -> Result<PathBuf, ProviderResolutionError> {
    reject_reparse_components(&temporary_root)?;
    for _ in 0..8 {
        let directory = temporary_root.join(format!(
            "mc-server-manager-archive-snapshot-{}",
            uuid::Uuid::new_v4()
        ));
        match fs::create_dir(&directory) {
            Ok(()) => {
                let metadata = match fs::symlink_metadata(&directory) {
                    Ok(metadata) => metadata,
                    Err(error) => {
                        let _ = fs::remove_dir(&directory);
                        return Err(ProviderResolutionError::Io(error.to_string()));
                    }
                };
                if !metadata.is_dir() || metadata_is_reparse_point(&metadata) {
                    let _ = fs::remove_dir(&directory);
                    return Err(ProviderResolutionError::Malformed(
                        "private snapshot directory is a reparse point".into(),
                    ));
                }
                return Ok(directory);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(ProviderResolutionError::Io(error.to_string())),
        }
    }
    Err(ProviderResolutionError::Io(
        "could not allocate a unique private snapshot directory".into(),
    ))
}

fn reject_reparse_components(path: &Path) -> Result<(), ProviderResolutionError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| ProviderResolutionError::Io(error.to_string()))?
            .join(path)
    };
    let mut current = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => continue,
            std::path::Component::ParentDir => {
                current.pop();
                continue;
            }
            _ => current.push(component.as_os_str()),
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata_is_reparse_point(&metadata) => {
                return Err(ProviderResolutionError::Malformed(format!(
                    "archive path contains a reparse point: {}",
                    current.display()
                )))
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(ProviderResolutionError::Io(error.to_string())),
        }
    }
    Ok(())
}

fn open_source_without_following_reparse_point(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options.open(path)
}

fn metadata_is_reparse_point(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(windows)]
mod cng {
    use std::{
        alloc::{alloc, dealloc, Layout},
        ffi::c_void,
        io,
        ptr::NonNull,
    };

    #[link(name = "bcrypt")]
    unsafe extern "system" {
        fn BCryptOpenAlgorithmProvider(
            algorithm: *mut *mut c_void,
            algorithm_id: *const u16,
            implementation: *const u16,
            flags: u32,
        ) -> i32;
        fn BCryptGetProperty(
            object: *mut c_void,
            property: *const u16,
            output: *mut u8,
            output_len: u32,
            result_len: *mut u32,
            flags: u32,
        ) -> i32;
        fn BCryptCreateHash(
            algorithm: *mut c_void,
            hash: *mut *mut c_void,
            hash_object: *mut u8,
            hash_object_len: u32,
            secret: *mut u8,
            secret_len: u32,
            flags: u32,
        ) -> i32;
        fn BCryptHashData(hash: *mut c_void, input: *mut u8, input_len: u32, flags: u32) -> i32;
        fn BCryptFinishHash(hash: *mut c_void, output: *mut u8, output_len: u32, flags: u32)
            -> i32;
        fn BCryptDestroyHash(hash: *mut c_void) -> i32;
        fn BCryptCloseAlgorithmProvider(algorithm: *mut c_void, flags: u32) -> i32;
    }

    pub struct HashPair {
        sha1: HashObject,
        sha512: HashObject,
    }

    impl HashPair {
        pub fn new() -> io::Result<Self> {
            Ok(Self {
                sha1: HashObject::new("SHA1", 20)?,
                sha512: HashObject::new("SHA512", 64)?,
            })
        }

        pub fn update(&mut self, bytes: &[u8]) -> io::Result<()> {
            self.sha1.update(bytes)?;
            self.sha512.update(bytes)
        }

        pub fn finish(self) -> io::Result<(String, String)> {
            let Self { sha1, sha512 } = self;
            Ok((sha1.finish()?, sha512.finish()?))
        }
    }

    struct AlgorithmProvider(NonNull<c_void>);

    impl Drop for AlgorithmProvider {
        fn drop(&mut self) {
            unsafe {
                let _ = BCryptCloseAlgorithmProvider(self.0.as_ptr(), 0);
            }
        }
    }

    struct HashObject {
        _algorithm: AlgorithmProvider,
        hash: NonNull<c_void>,
        object: NonNull<u8>,
        object_layout: Layout,
        digest_len: usize,
    }

    impl HashObject {
        fn new(algorithm_name: &str, expected_digest_len: usize) -> io::Result<Self> {
            let algorithm_id = wide(algorithm_name);
            let mut raw_algorithm = std::ptr::null_mut();
            check_status(
                unsafe {
                    BCryptOpenAlgorithmProvider(
                        &mut raw_algorithm,
                        algorithm_id.as_ptr(),
                        std::ptr::null(),
                        0,
                    )
                },
                "BCryptOpenAlgorithmProvider",
            )?;
            let algorithm = AlgorithmProvider(NonNull::new(raw_algorithm).ok_or_else(|| {
                io::Error::other("BCryptOpenAlgorithmProvider returned a null handle")
            })?);

            let object_len = get_u32_property(algorithm.0, "ObjectLength")? as usize;
            let digest_len = get_u32_property(algorithm.0, "HashDigestLength")? as usize;
            if object_len == 0
                || object_len > super::MAX_CNG_OBJECT_BYTES
                || digest_len != expected_digest_len
            {
                return Err(io::Error::other(format!(
                    "CNG reported invalid {algorithm_name} object or digest length"
                )));
            }
            let object_layout = Layout::from_size_align(object_len, 16)
                .map_err(|error| io::Error::other(error.to_string()))?;
            let object = NonNull::new(unsafe { alloc(object_layout) })
                .ok_or_else(|| io::Error::other("could not allocate CNG hash object"))?;
            let mut raw_hash = std::ptr::null_mut();
            let status = unsafe {
                BCryptCreateHash(
                    algorithm.0.as_ptr(),
                    &mut raw_hash,
                    object.as_ptr(),
                    object_len as u32,
                    std::ptr::null_mut(),
                    0,
                    0,
                )
            };
            if let Err(error) = check_status(status, "BCryptCreateHash") {
                unsafe { dealloc(object.as_ptr(), object_layout) };
                return Err(error);
            }
            let hash = match NonNull::new(raw_hash) {
                Some(hash) => hash,
                None => {
                    unsafe { dealloc(object.as_ptr(), object_layout) };
                    return Err(io::Error::other("BCryptCreateHash returned a null handle"));
                }
            };
            Ok(Self {
                _algorithm: algorithm,
                hash,
                object,
                object_layout,
                digest_len,
            })
        }

        fn update(&mut self, bytes: &[u8]) -> io::Result<()> {
            let input_len = u32::try_from(bytes.len())
                .map_err(|_| io::Error::other("CNG hash input chunk exceeds ULONG"))?;
            check_status(
                unsafe {
                    BCryptHashData(self.hash.as_ptr(), bytes.as_ptr() as *mut u8, input_len, 0)
                },
                "BCryptHashData",
            )
        }

        fn finish(self) -> io::Result<String> {
            let mut digest = vec![0u8; self.digest_len];
            check_status(
                unsafe {
                    BCryptFinishHash(
                        self.hash.as_ptr(),
                        digest.as_mut_ptr(),
                        self.digest_len as u32,
                        0,
                    )
                },
                "BCryptFinishHash",
            )?;
            Ok(to_hex(&digest))
        }
    }

    impl Drop for HashObject {
        fn drop(&mut self) {
            unsafe {
                let _ = BCryptDestroyHash(self.hash.as_ptr());
                dealloc(self.object.as_ptr(), self.object_layout);
            }
        }
    }

    fn get_u32_property(object: NonNull<c_void>, name: &str) -> io::Result<u32> {
        let property = wide(name);
        let mut value = 0u32;
        let mut result_len = 0u32;
        check_status(
            unsafe {
                BCryptGetProperty(
                    object.as_ptr(),
                    property.as_ptr(),
                    (&mut value as *mut u32).cast::<u8>(),
                    std::mem::size_of::<u32>() as u32,
                    &mut result_len,
                    0,
                )
            },
            "BCryptGetProperty",
        )?;
        if result_len != std::mem::size_of::<u32>() as u32 {
            return Err(io::Error::other(format!(
                "BCryptGetProperty returned an invalid {name} length"
            )));
        }
        Ok(value)
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn check_status(status: i32, operation: &str) -> io::Result<()> {
        if status >= 0 {
            Ok(())
        } else {
            Err(io::Error::other(format!(
                "{operation} failed with NTSTATUS 0x{:08x}",
                status as u32
            )))
        }
    }

    fn to_hex(bytes: &[u8]) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut output = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            output.push(HEX[(byte >> 4) as usize] as char);
            output.push(HEX[(byte & 0x0f) as usize] as char);
        }
        output
    }
}

#[cfg(not(windows))]
mod cng {
    use std::io;

    pub struct HashPair;

    impl HashPair {
        pub fn new() -> io::Result<Self> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "archive snapshot fingerprinting requires Windows CNG",
            ))
        }

        pub fn update(&mut self, _bytes: &[u8]) -> io::Result<()> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "archive snapshot fingerprinting requires Windows CNG",
            ))
        }

        pub fn finish(self) -> io::Result<(String, String)> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "archive snapshot fingerprinting requires Windows CNG",
            ))
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn source_file(name: &str, bytes: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "pipeline-snapshot-{name}-{}.input",
            uuid::Uuid::new_v4()
        ));
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn hashes_known_sha_vectors_from_the_same_snapshot() {
        let source = source_file("known-vector", b"abc");
        let snapshot = snapshot_archive(&source, 1024).unwrap();
        assert_eq!(snapshot.fingerprint().size_bytes, 3);
        assert_eq!(fs::read(snapshot.path()).unwrap(), b"abc");
        assert_eq!(
            snapshot.fingerprint().hashes.sha1,
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(
            snapshot.fingerprint().hashes.sha512,
            "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
        );
        let snapshot_path = snapshot.path().to_path_buf();
        assert!(snapshot_path.is_file());
        drop(snapshot);
        assert!(!snapshot_path.exists());
        let _ = fs::remove_file(source);
    }

    #[test]
    fn cancellation_cleans_the_partial_snapshot() {
        let source = source_file("cancel", &vec![b'x'; SNAPSHOT_CHUNK_BYTES * 3]);
        let observed_path = RefCell::new(None);
        let mut calls = 0;
        let result = snapshot_archive_with_cancel(&source, 1024 * 1024, |path| {
            calls += 1;
            observed_path.replace(Some(path.to_path_buf()));
            calls > 1
        });
        assert!(matches!(result, Err(ProviderResolutionError::Cancelled)));
        let snapshot_path = observed_path.into_inner().unwrap();
        assert!(!snapshot_path.exists());
        let _ = fs::remove_file(source);
    }

    #[test]
    fn rejects_oversize_archives_before_creating_a_snapshot() {
        let source = source_file("oversize", b"12345");
        assert!(matches!(
            snapshot_archive(&source, 4),
            Err(ProviderResolutionError::Malformed(_))
        ));
        let _ = fs::remove_file(source);
    }

    #[test]
    fn refuses_snapshot_before_copy_when_temp_volume_headroom_is_insufficient() {
        let source = source_file("preflight", b"archive bytes");
        let temporary_root = std::env::temp_dir().join(format!(
            "pipeline-snapshot-preflight-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&temporary_root).unwrap();
        let source_size = fs::metadata(&source).unwrap().len();
        let mut queried = false;
        let result = snapshot_archive_with_probe(
            &source,
            1024,
            &temporary_root,
            |_| {
                queried = true;
                Ok(source_size + SNAPSHOT_HEADROOM_BYTES - 1)
            },
            |_| false,
        );
        assert!(matches!(
            result,
            Err(ProviderResolutionError::InsufficientSpace { .. })
        ));
        assert!(queried);
        assert!(fs::read_dir(&temporary_root).unwrap().next().is_none());
        let _ = fs::remove_dir(&temporary_root);
        let _ = fs::remove_file(source);
    }

    #[test]
    #[cfg(windows)]
    fn read_only_guard_denies_write_delete_until_snapshot_drop() {
        let source = source_file("lock", b"locked archive");
        let snapshot = snapshot_archive(&source, 1024).unwrap();
        let path = snapshot.path().to_path_buf();
        let directory = path.parent().unwrap().to_path_buf();
        assert!(File::open(&path).is_ok());
        assert!(OpenOptions::new().write(true).open(&path).is_err());
        assert!(fs::remove_file(&path).is_err());
        assert!(path.exists());
        drop(snapshot);
        assert!(!path.exists());

        fs::create_dir(&directory).unwrap();
        fs::write(&path, b"released archive").unwrap();
        let mut writer = OpenOptions::new().write(true).open(&path).unwrap();
        writer.write_all(b"written").unwrap();
        drop(writer);
        fs::remove_file(&path).unwrap();
        fs::remove_dir(&directory).unwrap();
        let _ = fs::remove_file(source);
    }
}
