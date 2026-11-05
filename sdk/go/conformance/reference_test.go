// Copyright (c) Microsoft. All rights reserved.

package conformance

// CTK self-test: the vectors against the in-tree ReferenceHarness.
// Assertion engine and scripted interceptor live in the Rust core; this
// proves the Go emitter/runner wiring end-to-end. The gating run is
// under 0.1, the newest released version: the released set runs and the
// draft-only vectors (introduced_in: draft) are skipped. TestDraftOnly*
// runs those under the draft in the advisory job. Binding tests to a
// draft revision is #188.

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/responsibleai/agent-hooks/sdk/go/agenthooks"
)

// capabilitySkips pins the capability skip set: Go decodes vector JSON
// via json.Number, so the reference harness declares every value-domain
// capability and no value-domain vector may skip. The
// streaming/incremental part (§12.1 exception) skips because the
// reference harness buffers caller-bound output and does not declare
// incremental_output. An unexpected skip fails its subtest; a stale
// manifest (expected-but-not-skipped) fails the aggregate.
var capabilitySkips = map[string]struct{}{
	"AH-CTK-110": {},
	"AH-CTK-111": {},
	"AH-CTK-112": {},
	"AH-CTK-113": {},
}

// draftOnly is the set of draft-only vectors, skipped under 0.1 with
// DraftOnlySkip.
var draftOnly = func() map[string]struct{} {
	out := map[string]struct{}{}
	for n := 144; n <= 160; n++ {
		out[fmt.Sprintf("AH-CTK-%d", n)] = struct{}{}
	}
	return out
}()

func expectedSkip(id string) bool {
	_, capability := capabilitySkips[id]
	_, draft := draftOnly[id]
	return capability || draft
}

func TestReferenceHarnessConformance(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "conformance", "0.1", "vectors")
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
			r, err := RunVector(ctx, NewReferenceHarness(agenthooks.SpecVersion01), v)
			if err != nil {
				t.Fatalf("RunVector: %v", err)
			}
			switch r.Status {
			case "pass":
				// ok
			case "skip":
				skipped[r.ID] = struct{}{}
				if !expectedSkip(r.ID) {
					t.Fatalf("unexpected skip: %s (%s) — update capabilitySkips only with a capability rationale", r.ID, r.Detail)
				}
				if _, draft := draftOnly[r.ID]; draft && r.Detail != DraftOnlySkip {
					t.Fatalf("draft-only vector %s skipped for %q, want %q", r.ID, r.Detail, DraftOnlySkip)
				}
				t.Skipf("%s", r.Detail)
			default:
				t.Fatalf("status=%s\n  - %s", r.Status, strings.Join(r.Failures, "\n  - "))
			}
		})
	}
	for id := range capabilitySkips {
		if _, ok := skipped[id]; !ok {
			t.Fatalf("expected-but-not-skipped vector %s: the capabilitySkips manifest is stale", id)
		}
	}
	for id := range draftOnly {
		if _, ok := skipped[id]; !ok {
			t.Fatalf("draft-only vector %s ran under 0.1", id)
		}
	}
	for _, v := range vectors {
		id, _ := v["id"].(string)
		introduced, _ := v["introduced_in"].(string)
		if _, draft := draftOnly[id]; draft != (introduced == "draft") {
			t.Fatalf("%s: introduced_in %q does not match the draftOnly set", id, introduced)
		}
	}
}

// TestDraftOnlyVectorsPassUnderTheDraft is advisory (the draft-tests
// job): the working test set for the next version passes under the
// draft.
func TestDraftOnlyVectorsPassUnderTheDraft(t *testing.T) {
	vectors, err := LoadVectors(filepath.Join("..", "..", "..", "conformance", "vectors"))
	if err != nil {
		t.Fatalf("LoadVectors: %v", err)
	}
	var ran int
	for _, v := range vectors {
		if introduced, _ := v["introduced_in"].(string); introduced != "draft" {
			continue
		}
		ran++
		r, err := RunVector(context.Background(), NewReferenceHarness(agenthooks.SpecVersionDraft), v)
		if err != nil {
			t.Fatalf("RunVector: %v", err)
		}
		if r.Status != "pass" {
			t.Errorf("%s: %s %s\n  - %s", r.ID, r.Status, r.Detail, strings.Join(r.Failures, "\n  - "))
		}
	}
	if ran != 17 {
		t.Fatalf("draft-only vectors: %d, want 17", ran)
	}
}

type nameless struct{ ReferenceHarness }

func (nameless) Spec() string { return "" }

func TestAHarnessNamesTheVersionItBuildsUnder(t *testing.T) {
	vectors, err := LoadVectors(filepath.Join("..", "..", "..", "conformance", "vectors"))
	if err != nil {
		t.Fatalf("LoadVectors: %v", err)
	}
	_, err = RunVector(context.Background(), &nameless{}, vectors[0])
	if err == nil || !errors.Is(err, agenthooks.ErrSpecVersionUnsupported) {
		t.Fatalf("a harness without a version must be refused, got %v", err)
	}
}

// The SDK runner currently exercises the released 0.1 suite.
func TestAReportNamesAReleasedVersionNeverTheDraft(t *testing.T) {
	vectors, err := LoadVectors(filepath.Join("..", "..", "..", "conformance", "0.1", "vectors"))
	if err != nil {
		t.Fatalf("LoadVectors: %v", err)
	}
	var results []VectorResult
	for _, v := range vectors {
		r, err := RunVector(context.Background(), NewReferenceHarness(agenthooks.SpecVersion01), v)
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
	if report.Spec != agenthooks.SpecVersion01 || report.Failed != 0 || report.Skipped != len(capabilitySkips)+len(draftOnly) {
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
	var streaming *PartReport
	for i := range report.Parts {
		if report.Parts[i].Part == "streaming/incremental" {
			streaming = &report.Parts[i]
		}
	}
	if streaming == nil || streaming.Skipped != 4 {
		t.Fatalf("streaming/incremental part missing or not skipped 4 times: %+v", streaming)
	}
}
