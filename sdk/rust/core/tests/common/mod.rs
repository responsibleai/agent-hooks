// Copyright (c) Microsoft. All rights reserved.

//! Shared by the integration tests: the specification bundles this
//! build supports, one per [`SpecVersion`] (VERSIONING.md). A test
//! that reads an inventory or a schema runs once per bundle.

#![allow(dead_code)]

use agent_hooks::SpecVersion;
use std::path::{Path, PathBuf};

/// Absolute path of a file in the bundle of `spec`.
pub fn spec_path(spec: SpecVersion, name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(spec.bundle_dir())
        .join(name)
}

/// A file of the bundle of `spec`, read at test time.
pub fn spec_file(spec: SpecVersion, name: &str) -> String {
    let path = spec_path(spec, name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}
