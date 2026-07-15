// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//! Latency benchmarks for the per-emission critical path (NEXT-19).
//! Budget published in ARCHITECTURE.md; run with `cargo bench -p
//! agent-hooks-sdk`.

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use serde_json::{json, Value};

fn ctx_of(payload_bytes: usize) -> agent_hooks::AgentContext {
    let blob = "x".repeat(payload_bytes);
    json!({
        "spec": "agent-hooks/0.1",
        "interception_point": "pre_tool_call",
        "timestamp": "2026-01-01T00:00:00Z",
        "sequence": 1,
        "agent": {"id": "a", "framework": "bench"},
        "session": {"id": "s"},
        "tool_call": {"id": "tc", "name": "t", "args": {"blob": blob}},
        "target": {"blob": blob}
    })
    .as_object()
    .unwrap()
    .clone()
}

fn bench_identity(c: &mut Criterion) {
    let mut g = c.benchmark_group("context_identity");
    for kb in [1usize, 100, 1024] {
        let ctx = ctx_of(kb * 1024);
        g.bench_with_input(
            BenchmarkId::from_parameter(format!("{kb}KiB")),
            &ctx,
            |b, ctx| b.iter(|| agent_hooks::context_identity(std::hint::black_box(ctx)).unwrap()),
        );
    }
    g.finish();
}

fn bench_compose(c: &mut Criterion) {
    let mut g = c.benchmark_group("compose_aggregate");
    for n in [1usize, 5, 10] {
        let verdicts: Vec<Value> = (0..n).map(|_| json!({"decision": "allow"})).collect();
        let composition = json!({"profile": "parallel/strictest"}).to_string();
        let verdicts_json = Value::Array(verdicts).to_string();
        g.bench_with_input(
            BenchmarkId::from_parameter(format!("{n}-interceptors")),
            &(composition, verdicts_json),
            |b, (comp, verd)| {
                b.iter(|| {
                    agent_hooks::ffi_surface::compose_aggregate(
                        std::hint::black_box(comp),
                        std::hint::black_box(verd),
                    )
                    .unwrap()
                })
            },
        );
    }
    g.finish();
}

fn bench_emit(c: &mut Criterion) {
    use agent_hooks::{AgentContext, EnforcementMode, InterceptionEmitter, Interceptor, Verdict};
    struct Allow;
    #[async_trait::async_trait]
    impl Interceptor for Allow {
        async fn intercept(&self, _ctx: &AgentContext) -> Verdict {
            Verdict::allow()
        }
    }
    let rt = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let mut g = c.benchmark_group("emit_allow_path");
    for (kb, n) in [(1usize, 1usize), (100, 5), (1024, 10)] {
        g.bench_function(BenchmarkId::from_parameter(format!("{kb}KiB-{n}i")), |b| {
            b.iter(|| {
                rt.block_on(async {
                    let mut e = InterceptionEmitter::new(EnforcementMode::Enforce, None);
                    for _ in 0..n {
                        e.register(Box::new(Allow));
                    }
                    let mut ctx = ctx_of(kb * 1024);
                    e.emit_unchecked(std::hint::black_box(&mut ctx)).await
                })
            })
        });
    }
    g.finish();
}

criterion_group!(benches, bench_identity, bench_compose, bench_emit);
criterion_main!(benches);
