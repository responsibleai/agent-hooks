// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

package agenthooks

// Cross-SDK golden vectors for §10 canonical JSON and context identity.
// Loads conformance/golden/identity.json (generated from the Rust core)
// and asserts the Go SDK — which delegates to the same core via cgo —
// produces identical output.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type goldenFixture struct {
	ID     string         `json:"id"`
	Ctx    map[string]any `json:"ctx"`
	Expect struct {
		CanonicalJSON   string `json:"canonical_json"`
		ContextIdentity string `json:"context_identity"`
		Error           string `json:"error"`
	} `json:"expect"`
}

func loadGolden(t *testing.T) []goldenFixture {
	t.Helper()
	// sdk/go/agenthooks/ -> repo root
	path := filepath.Join("..", "..", "..", "conformance", "golden", "identity.json")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var doc struct {
		Fixtures []goldenFixture `json:"fixtures"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatalf("parse golden: %v", err)
	}
	return doc.Fixtures
}

func TestGoldenCanonicalJSON(t *testing.T) {
	for _, f := range loadGolden(t) {
		t.Run(f.ID, func(t *testing.T) {
			if f.Expect.Error != "" {
				t.Skip("negative fixture: asserted via identity")
			}
			got, err := CanonicalJSON(f.Ctx)
			if err != nil {
				t.Fatalf("CanonicalJSON: %v", err)
			}
			if got != f.Expect.CanonicalJSON {
				t.Errorf("mismatch\n got %s\nwant %s", got, f.Expect.CanonicalJSON)
			}
		})
	}
}

func TestGoldenContextIdentity(t *testing.T) {
	for _, f := range loadGolden(t) {
		t.Run(f.ID, func(t *testing.T) {
			got, err := ContextIdentity(AgentContext(f.Ctx))
			if f.Expect.Error != "" {
				// §10.2: out-of-domain contexts fail closed — never a
				// real-looking identity.
				if err == nil {
					t.Fatalf("expected rejection, got identity %s", got)
				}
				if !strings.Contains(err.Error(), "context_invalid") {
					t.Fatalf("expected context_invalid, got: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("ContextIdentity: %v", err)
			}
			if got != f.Expect.ContextIdentity {
				t.Errorf("mismatch: got %s want %s", got, f.Expect.ContextIdentity)
			}
		})
	}
}

func TestGoldenL2L3Stripped(t *testing.T) {
	byID := map[string]goldenFixture{}
	for _, f := range loadGolden(t) {
		byID[f.ID] = f
	}
	if byID["G-05-l2-l3-stripped"].Expect.ContextIdentity !=
		byID["G-05b-l2-l3-baseline"].Expect.ContextIdentity {
		t.Error("L2/L3 fields must not affect context_identity (§10.2)")
	}
}

func TestNativeSpecVersion(t *testing.T) {
	if v := nativeSpecVersion(); v != SpecVersion {
		t.Errorf("core spec version %q != Go SpecVersion %q", v, SpecVersion)
	}
}
