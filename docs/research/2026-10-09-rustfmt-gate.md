# Rustfmt Gate Follow-up

Date: 2026-10-09  
Task: `ui-005` Test-phase formatting follow-up.

## Finding

The offline `cargo fmt --check` gate found formatting differences in `src-tauri/src/installer/mod.rs` near lines 369 and 1583. Rust tests and `cargo check` passed before formatting. This follow-up is limited to the formatter output; it does not change behavior, APIs, dependencies, or feature scope.

## Decision

Format only the owned Rust file with `rustfmt --edition 2021 --config skip_children=true`, then use the Cargo-integrated `cargo fmt --check` to verify the whole crate. This crate uses edition 2021. Avoid direct `rustfmt` without an explicit edition because its default parser edition is 2015. Run `cargo test --lib` and `cargo check --lib` offline after the formatting change.

## Source

- [Rustfmt documentation](https://rust-lang.github.io/rustfmt/) — documents edition selection and the Cargo integration behavior.
