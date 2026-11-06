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

func expectedSkip(id string) bool {
	_, capability := capabilitySkips[id]
	return capability
}

func TestReferenceDeclarationUsesReleasedSpecification(t *testing.T) {
	doc := referenceDocument()
	if doc["spec"] != agenthooks.SpecVersion01 || doc["declaration"] != "agent-hooks-declaration/1.0" {
		t.Fatalf("reference declaration must target 0.1 / declaration 1.0: %v", doc)
	}
	surface := doc["surface"].(map[string]any)
	versions := surface["declaration_versions"].([]any)
	if len(versions) != 1 || versions[0] != "agent-hooks-declaration/1.0" {
		t.Fatalf("reference declaration versions: %v", versions)
	}
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
	for _, v := range vectors {
		id, _ := v["id"].(string)
		introduced, _ := v["introduced_in"].(string)
		if introduced == "draft" {
			t.Fatalf("%s: draft-only vector in released suite", id)
		}
	}
}

// TestDraftOnlyVectorsPassUnderTheDraft is advisory (the draft-tests
// job): the working test set for the next version passes under the
// draft.
func TestDraftOnlyVectorsPassUnderTheDraft(t *testing.T) {
	vectors, err := LoadVectors(filepath.Join("..", "..", "..", "conformance", "draft", "vectors"))
	if err != nil {
		t.Fatalf("LoadVectors: %v", err)
	}
	released, err := LoadVectors(filepath.Join("..", "..", "..", "conformance", "0.1", "vectors"))
	if err != nil {
		t.Fatalf("released LoadVectors: %v", err)
	}
	releasedIDs := map[string]bool{}
	for _, v := range released {
		releasedIDs[v["id"].(string)] = true
	}
	var ran int
	for _, v := range vectors {
		if releasedIDs[v["id"].(string)] {
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
	if ran != 14 {
		t.Fatalf("draft-only vectors: %d, want 14", ran)
	}
}

type nameless struct{ ReferenceHarness }

func (nameless) Spec() string { return "" }

func TestAHarnessNamesTheVersionItBuildsUnder(t *testing.T) {
	vectors, err := LoadVectors(filepath.Join("..", "..", "..", "conformance", "0.1", "vectors"))
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
	if report.Spec != agenthooks.SpecVersion01 || report.Failed != 0 || report.Skipped != len(capabilitySkips) {
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
