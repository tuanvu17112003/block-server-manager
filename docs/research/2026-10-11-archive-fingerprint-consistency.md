# Stable archive fingerprinting

## Finding

The current archive fingerprint helper invokes `certutil.exe` separately for SHA-1 and SHA-512. Separate path-based reads can observe different bytes if the file changes between invocations, and launching the executable by name does not bind the call to the Windows system copy.

Microsoft's CNG API supports incremental hashing: open the SHA-1 and SHA-512 algorithm providers, create hash objects, feed the same byte chunks with `BCryptHashData`, and finalize with `BCryptFinishHash`. The provider exposes its required object-buffer length through `BCRYPT_OBJECT_LENGTH`. This avoids an external executable and allows both digests to cover one byte stream.

For a reproducible source pin, preflight free space on the temporary volume, then create the bounded snapshot with a handle whose sharing mode denies other handles write/delete access. Copy a regular source archive while feeding both CNG hash objects from the same stream, keep that original handle alive through parsing, and perform no writes after the copy is finished. This closes the gap between finishing the copy and acquiring a separate guard. Classify and parse that snapshot. For remote Modrinth archives, compare the calculated snapshot hashes and size with provider metadata before continuing. For local packs and CurseForge server ZIPs, record the hashes only as a calculated fingerprint, not an authenticity claim. Check cancellation during copying and at parser/selection stage boundaries; drop the temporary snapshot on every exit path.

## Sources

- [Microsoft Learn: Creating a Hash with CNG](https://learn.microsoft.com/en-us/windows/win32/seccng/creating-a-hash-with-cng)
- [Microsoft Learn: CNG Algorithm Identifiers](https://learn.microsoft.com/en-us/windows/win32/seccng/cng-algorithm-identifiers)
- [Microsoft Learn: BCryptHashData](https://learn.microsoft.com/en-us/windows/win32/api/bcrypt/nf-bcrypt-bcrypthashdata)
- [Microsoft Learn: BCryptFinishHash](https://learn.microsoft.com/en-us/windows/win32/api/bcrypt/nf-bcrypt-bcryptfinishhash)
- [Microsoft Learn: BCRYPT_OBJECT_LENGTH](https://learn.microsoft.com/en-us/windows/desktop/SecCNG/cng-property-identifiers)
- [Microsoft Learn: CreateFile sharing modes](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea)
