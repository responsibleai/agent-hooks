// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

package conformance

// CTK self-test: run all vectors against the in-tree
// ReferenceHarness. Assertion engine and scripted interceptor live in
// the Rust core; this proves the Go emitter/runner wiring end-to-end.

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

// expectedSkips pins the skip set: Go decodes vector JSON via
// json.Number, so the reference harness declares every value-domain
// capability and no value-domain vector may skip. The
// streaming/incremental part (§12.1 exception) skips because the
// reference harness buffers caller-bound output and does not declare
// incremental_output. An unexpected skip fails its subtest; a stale
// manifest (expected-but-not-skipped) fails the aggregate.
var expectedSkips = map[string]struct{}{
	"AH-CTK-110": {},
	"AH-CTK-111": {},
	"AH-CTK-112": {},
	"AH-CTK-113": {},
}

func TestReferenceHarnessConformance(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "conformance", "vectors")
	vectors, err := LoadVectors(dir)
	if err != nil {
		t.Fatalf("LoadVectors: %v", err)
	}
	if len(vectors) == 0 {
		t.Fatalf("no vectors found under %s", dir)
	}
	ctx := context.Background()
	skipped := map[string]struct{}{}
	for _, v := range vectors {
		id, _ := v["id"].(string)
		t.Run(id, func(t *testing.T) {
			r, err := RunVector(ctx, NewReferenceHarness(), v)
			if err != nil {
				t.Fatalf("RunVector: %v", err)
			}
			switch r.Status {
			case "pass":
				// ok
			case "skip":
				skipped[r.ID] = struct{}{}
				if _, ok := expectedSkips[r.ID]; !ok {
					t.Fatalf("unexpected skip: %s (%s) — update expectedSkips only with a capability rationale", r.ID, r.Detail)
				}
				t.Skipf("%s", r.Detail)
			default:
				t.Fatalf("status=%s\n  - %s", r.Status, strings.Join(r.Failures, "\n  - "))
			}
		})
	}
	for id := range expectedSkips {
		if _, ok := skipped[id]; !ok {
			t.Fatalf("expected-but-not-skipped vector %s: the expectedSkips manifest is stale", id)
		}
	}
}
