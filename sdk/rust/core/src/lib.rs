// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! agent-hooks: framework-neutral agent control contract.
//!
//! This crate is the **canonical implementation** of
//! [AGENT-HOOKS-0.1](../../../spec/AGENT-HOOKS-0.1.md). The Python,
//! TypeScript, .NET, and Go SDKs bind to it via FFI so that
//! `canonical_json`, `context_identity`, transform application, verdict
//! validation, and verdict combination have exactly one implementation.
//!
//! The FFI surface (`agent-hooks-ffi` crate, plus PyO3/napi bindings in
//! each language SDK) is JSON-string in / JSON-string out over the
//! functions in [`ffi_surface`], because [`AgentContext`] and [`Verdict`]
//! are already wire-shaped JSON.
//!
//! For Rust-native hosts this crate is also a full host SDK:
//! [`InterceptionEmitter`], [`AgentContextBuilder`], and (behind the
//! `ctk` feature) the CTK runner and [`ctk::ReferenceHarness`]. The
//! other languages implement the same per-language pieces over the FFI.
//!
//! # Trust model
//!
//! agent-hooks is a **cooperative contract, not a security boundary**:
//! the host framework is fully trusted (every §6 obligation is a MUST
//! on the host, and nothing detects a host that ignores it),
//! interceptors run in-process with full data access, and no
//! complete-mediation claim is made. Conformance is not a security
//! certification. See
//! [SECURITY.md](https://github.com/responsibleai/agent-hooks/blob/main/SECURITY.md)
//! and [spec §1.4](https://github.com/responsibleai/agent-hooks/blob/main/spec/AGENT-HOOKS-0.1.md#14-trust-model-and-non-goals).
//!
//! # Decision runtimes behind an interceptor
//!
//! A policy engine (or any decision runtime) that sits *behind* an
//! interceptor is neither a host nor the interceptor itself, and its
//! internal failures need a reason namespace:
//!
//! - `host_error:*` is reserved for **host-synthesized** verdicts (§11).
//!   An interceptor — including one that wraps an engine — MUST NOT
//!   emit it; the §5 gate rejects such verdicts as `verdict_invalid`.
//! - An engine therefore reports its own failures under its own
//!   namespace (the convention consumers use is `runtime_error:*`),
//!   returned as an ordinary fail-closed `deny` verdict:
//!   `{"decision": "deny", "reason": "runtime_error:<code>"}`.
//! - Engine failures are the interceptor's to convert. Only if the
//!   interceptor itself raises or times out does the *host* synthesize
//!   `host_error:interceptor_failed` / `host_error:interceptor_timeout`
//!   (§6.3) — at which point the engine's detail is gone, so convert,
//!   don't panic.

#![warn(clippy::all)]

mod builder;
mod canonical;
pub mod composition;
mod emitter;
mod enforce;
mod jcs;
mod path;
mod types;
mod verdict;

#[cfg(feature = "ctk")]
pub mod ctk;

pub mod ctk_engine;
pub mod ffi_surface;

pub use builder::AgentContextBuilder;
pub use canonical::{canonical_json, context_identity, MAX_SAFE_INTEGER};
pub use composition::{
    aggregate_strictest, severity, Aggregate, CompositionConfig, CompositionProfile, OnApproval,
    SynthesisPolicy,
};
pub use emitter::{HostFailure, IdentityProvider, InterceptionBlocked, InterceptionEmitter};
pub use enforce::{apply_transform_to_ctx, finalize, validate_transform, FinalizeMeta};
pub use path::{apply as apply_transform_path, parse as parse_transform_path, resolve, Segment};
pub use types::{
    AgentContext, ApprovalOutcome, ApprovalRequest, ApprovalResolution, ApprovalResolver, Decision,
    EnforcementMode, Evidence, HostError, InterceptionPoint, InterceptionRecord, Interceptor,
    Transform, Verdict, VerdictSummary, Warning, JCS_SHA256, SPEC_VERSION,
};
pub use verdict::from_wire as verdict_from_wire;
