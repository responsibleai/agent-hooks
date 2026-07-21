// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

package agenthooks

import "testing"

// §5.1 verdict sugar: DenyVerdict is a plain, final deny — no approval
// block, so the approval seam cannot lift it.
func TestDenyVerdictSugarIsFinalDeny(t *testing.T) {
	v := DenyVerdict("policy", "blocked")
	if v.Decision != Deny {
		t.Fatalf("decision = %q, want %q", v.Decision, Deny)
	}
	if v.Reason != "policy" || v.Message != "blocked" {
		t.Fatalf("reason/message = %q/%q, want policy/blocked", v.Reason, v.Message)
	}
	if v.Approval != nil {
		t.Fatalf("approval = %v, want nil", v.Approval)
	}
	if v.IsLiftable() {
		t.Fatal("plain deny must not be liftable")
	}
	if err := v.Validate(); err != nil {
		t.Fatalf("Validate() = %v, want nil", err)
	}
}
