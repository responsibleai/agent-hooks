// Copyright (c) Microsoft. All rights reserved.

package conformance

// CTK self-test: run all vectors against the in-tree
// ReferenceHarness. Assertion engine and scripted interceptor live in
// the Rust core; this proves the Go emitter/runner wiring end-to-end.

import (
	"context"
	"errors"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/responsibleai/agent-hooks/sdk/go/agenthooks"
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

// Running the working test set is development; the report a claim
// attaches names a released version, and the runner refuses the draft.
func TestAReportNamesAReleasedVersionNeverTheDraft(t *testing.T) {
	vectors, err := LoadVectors(filepath.Join("..", "..", "..", "conformance", "vectors"))
	if err != nil {
		t.Fatalf("LoadVectors: %v", err)
	}
	var results []VectorResult
	for _, v := range vectors {
		r, err := RunVector(context.Background(), NewReferenceHarness(), v)
		if err != nil {
			t.Fatalf("RunVector: %v", err)
		}
		results = append(results, r)
	}
	if _, err := Report(agenthooks.SpecVersionDraft, results); !errors.Is(err, ErrDraftNotClaimable) {
		t.Fatalf("a report under the draft must be refused with ErrDraftNotClaimable, got %v", err)
	}
	if _, err := Report("agent-hooks/9.9", results); !errors.Is(err, agenthooks.ErrSpecVersionUnsupported) {
		t.Fatalf("an unsupported version must be refused, got %v", err)
	}
	report, err := Report(agenthooks.SpecVersion01, results)
	if err != nil {
		t.Fatalf("Report under 0.1: %v", err)
	}
	if report.Spec != agenthooks.SpecVersion01 || report.Failed != 0 || report.Skipped != len(expectedSkips) {
		t.Fatalf("report totals: spec=%s failed=%d skipped=%d", report.Spec, report.Failed, report.Skipped)
	}
	if report.Passed+report.Skipped != len(results) {
		t.Fatalf("passed %d + skipped %d != %d vectors", report.Passed, report.Skipped, len(results))
	}
	var names []string
	for _, part := range report.Parts {
		names = append(names, part.Part)
		if part.Passed+part.Failed+part.Skipped != len(part.Vectors) {
			t.Fatalf("part %q counts do not add up", part.Part)
		}
	}
	if !sort.StringsAreSorted(names) {
		t.Fatalf("parts not in name order: %v", names)
	}
	for _, part := range report.Parts {
		if part.Part == "streaming/incremental" && part.Skipped != 4 {
			t.Fatalf("streaming/incremental skipped %d, want 4", part.Skipped)
		}
	}
}
