// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

package conformance

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/responsibleai/agent-hooks/sdk/go/agenthooks"
)

// TestProvePathsAgreesOnShapesWithoutATypedForm pins the two document
// shapes the typed builder setters cannot express: a present
// `"config": null` and an empty knob set. Both must still yield the
// same outcome on every construction path.
func TestProvePathsAgreesOnShapesWithoutATypedForm(t *testing.T) {
	sc := scriptsOf(map[string]any{"interceptor_script": []any{}})
	reg, err := sc.registry(NewReferenceHarness().HostSurface())
	if err != nil {
		t.Fatal(err)
	}
	t.Run("config null", func(t *testing.T) {
		doc := map[string]any{
			"declaration": agenthooks.DeclarationVersion,
			"bindings": []any{
				map[string]any{"id": "a", "kind": "ctk.scripted", "config": nil},
			},
		}
		// The text path keeps config as null, so the builder path must
		// not drop it; the CTK resolver then rejects it on every path.
		same, detail := provePaths(doc, reg, "config-null")
		if !same {
			t.Fatalf("paths diverged: %s", detail)
		}
		built := builderFromValue(doc).Value()
		b := built["bindings"].([]any)[0].(map[string]any)
		if _, has := b["config"]; !has {
			t.Fatalf("builder must carry the present null config, got %v", b)
		}
	})
	t.Run("empty knob set", func(t *testing.T) {
		doc := map[string]any{
			"declaration": agenthooks.DeclarationVersion,
			"surface": map[string]any{
				"profiles": map[string]any{
					"sequential/first_deny": map[string]any{"on_approval": []any{}},
				},
			},
			"bindings": []any{
				map[string]any{"id": "a", "kind": "ctk.scripted", "config": map[string]any{"script": 0}},
			},
		}
		same, detail := provePaths(doc, reg, "empty-knob")
		if !same {
			t.Fatalf("paths diverged: %s", detail)
		}
		decl, err := agenthooks.DeclarationFromValue(doc)
		if err == nil {
			_, err = reg.Resolve(decl)
		}
		var de *agenthooks.DeclarationError
		if !errors.As(err, &de) || de.Class != agenthooks.DeclarationInvalidField {
			t.Fatalf("expected invalid_field on every path, got %v", err)
		}
	})
}

// TestReferenceSetupKeysIdentityOnTheName: a custom-named provider
// with no Compute is an error, not a silent jcs-sha256.
func TestReferenceSetupKeysIdentityOnTheName(t *testing.T) {
	h := NewReferenceHarness()
	comp := agenthooks.CompositionConfig{Profile: agenthooks.SequentialFirstDeny, OnApproval: agenthooks.OnApprovalStop}
	err := h.Setup(Scenario{}, nil, nil, agenthooks.Enforce, comp,
		&agenthooks.IdentityProvider{Name: "hmac-sha256-k1"}, nil)
	if err == nil || !strings.Contains(err.Error(), "hmac-sha256-k1") {
		t.Fatalf("custom name with nil Compute must be refused, got %v", err)
	}
	if err := h.Setup(Scenario{}, nil, nil, agenthooks.Enforce, comp, agenthooks.DefaultIdentityProvider(), nil); err != nil {
		t.Fatalf("default provider: %v", err)
	}
	h.Teardown()
}

// TestScriptedConfigIndexBounds: config.script is parsed within the int
// range, so an index past 2^31-1 is refused as an invalid index, never
// converted; an in-range index past the script count is out of range.
func TestScriptedConfigIndexBounds(t *testing.T) {
	sc := scriptsOf(map[string]any{"interceptor_script": []any{[]any{}}})
	reg, err := sc.registry(NewReferenceHarness().HostSurface())
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ script, want string }{
		{"2147483648", "unsigned integer index"},
		{"4294967295", "unsigned integer index"},
		{"18446744073709551616", "unsigned integer index"},
		{"2147483647", "out of range"},
		{"1", "out of range"},
	} {
		doc := map[string]any{
			"declaration": agenthooks.DeclarationVersion,
			"bindings": []any{
				map[string]any{"id": "a", "kind": "ctk.scripted", "config": map[string]any{"script": json.Number(tc.script)}},
			},
		}
		_, err := agenthooks.NewInterceptionEmitterFromDeclarationValue(doc, reg)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("script %s: expected %q, got %v", tc.script, tc.want, err)
		}
	}
}
