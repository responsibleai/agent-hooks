// Copyright (c) Microsoft. All rights reserved.

//! Shared by the integration tests: the specification bundle SDK
//! development tracks (VERSIONING.md). The unit tests in
//! `src/declaration.rs` carry the same constant, and the CI workflows
//! export it as `SPEC_DEV_DIR`; the three agree by convention.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

/// Repository-relative path of the development specification bundle.
pub const SPEC_DEV_DIR: &str = "spec/draft";

/// Absolute path of a file in the development bundle.
pub fn spec_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(SPEC_DEV_DIR)
        .join(name)
}

/// A file of the development bundle, read at test time.
pub fn spec_file(name: &str) -> String {
    let path = spec_path(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}
