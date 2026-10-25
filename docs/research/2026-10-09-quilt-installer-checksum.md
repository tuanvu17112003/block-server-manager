# Quilt Installer Checksum Mismatch

Date: 2026-10-09

## Observed behavior

- The user’s native Tauri screenshot shows Quilt installation failing with `server artifact SHA256 mismatch` while downloading an 8,734,533-byte artifact. The user reports Vanilla, Paper, Fabric, Forge/other server installs and Java provisioning work.
- The code selects the first object from Quilt Meta `/v3/versions/installer`, then uses its `url`, `file_size`, and `hashes.sha256` to verify the downloaded installer JAR.

## Provider comparison

- Quilt Meta currently lists installer 0.15.1 at `https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/0.15.1/quilt-installer-0.15.1.jar`, size 8,734,533 bytes, SHA-256 `2bd88a1429eaeb3ce3f5e9c49c591c551012937b35bf332ca277b4d93d70408d`, and SHA-1 `a6ea7a9e08e6f5ca399ea12101fbe56195a445e3`.
- A fresh HTTPS download from the official Maven artifact URL was exactly 8,734,533 bytes, but its SHA-256 was `0a229138caa1b87fd8f5622038410696f98bb85871a279640e7002404c4d0dc2`.
- The official Maven `.sha256` sidecar returned the same `0a229...` value as the downloaded bytes. The `.sha1` sidecar returned `e4c4e80c91c94d999ffe3468ec2043792b841051`, also different from Quilt Meta’s SHA-1.

## Conclusion and policy

The evidence points to an upstream metadata/artifact inconsistency: the app is rejecting the bytes because it correctly enforces the independent Quilt Meta hash. Sidecars for versions 0.15.0, 0.14.1, and 0.14.0 also differed from their Quilt Meta hashes, so selecting an older release is not a verified workaround.

The Maven `.sha256` sidecar matches the 0.15.1 artifact, but it comes from the same host as that artifact. Apache Maven documents sidecars as integrity checks, not an independent authenticity guarantee. The user approved using the exact artifact's Maven sidecar with a visible warning when it differs from Quilt Meta. Review also found that disabling redirect following alone is insufficient: curl can return a 3xx response, and arbitrary body text must not be searched for a hash. The implementation therefore requires HTTP 200 and accepts only a bare digest or a digest followed by the exact expected filename; missing/malformed sidecars and artifact-byte mismatches still fail closed.

## Sources

- [Quilt Meta installer API](https://meta.quiltmc.org/v3/versions/installer) — published installer versions, sizes, URLs, and hashes.
- [Quilt Maven 0.15.1 installer JAR](https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/0.15.1/quilt-installer-0.15.1.jar) — official artifact URL.
- [Quilt Maven 0.15.1 SHA-256 sidecar](https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/0.15.1/quilt-installer-0.15.1.jar.sha256) — repository checksum used by the implementation plan.
- [Apache Maven checksum guidance](https://maven.apache.org/resolver/about-checksums.html) — sidecar checksums provide integrity validation but do not establish authenticity.
