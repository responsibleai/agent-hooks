// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

package agenthooks

// Host declaration loader tests (spec section 7.7), mirroring
// sdk/rust/core/tests/declaration.rs: the construction paths, the
// refusal classes a Go host can reach, sealing, per-point bindings,
// the record stamp and the cross-SDK golden file.

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// fixedCtx builds a context at point with a fixed timestamp so records
// from two emitters compare byte for byte.
func fixedCtx(point InterceptionPoint, seq int64) AgentContext {
	ctx := AgentContext{
		"spec":               SpecVersion,
		"interception_point": string(point),
		"timestamp":          "2026-10-09T00:00:00.000Z",
		"sequence":           seq,
		"agent":              map[string]any{"id": "a1", "framework": "test-host"},
		"session":            map[string]any{"id": "s1"},
	}
	switch point {
	case AgentStartup:
		init := map[string]any{"tools_registered": []any{"http_get"}}
		ctx["target"], ctx["agent_init"] = init, init
	case Input:
		in := map[string]any{"content": "hi", "role": "user"}
		ctx["target"], ctx["input"] = in, in
	case PreToolCall:
		args := map[string]any{"url": "https://x"}
		ctx["target"] = args
		ctx["tool_call"] = map[string]any{"id": "tc-1", "name": "http_get", "args": args}
	case Output:
		out := map[string]any{"content": "done"}
		ctx["target"], ctx["output"] = out, out
	case AgentShutdown:
		sum := map[string]any{"reason": "completed"}
		ctx["target"], ctx["summary"] = sum, sum
	}
	return ctx
}

func sessionRecords(t *testing.T, em *InterceptionEmitter) []string {
	t.Helper()
	points := []InterceptionPoint{AgentStartup, Input, PreToolCall, Output, AgentShutdown}
	var out []string
	for i, p := range points {
		rec, err := em.EmitUnchecked(context.Background(), fixedCtx(p, int64(i)))
		if err != nil {
			t.Fatalf("EmitUnchecked(%s): %v", p, err)
		}
		b, err := json.Marshal(rec)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, string(b))
	}
	return out
}

func testSurface() HostSurface {
	return HostSurfaceFromCapabilities(
		[]string{"model_calls", "tool_calls", "host_declaration"}, PostureContinue)
}

// verdictFrom is the test kind: config.decision selects the verdict.
func verdictFrom(config json.RawMessage, _ BindingContext) (Interceptor, error) {
	var c struct {
		Decision string `json:"decision"`
	}
	if err := json.Unmarshal(config, &c); err != nil || c.Decision == "" {
		return nil, errors.New("config.decision is required")
	}
	switch c.Decision {
	case "allow":
		return scripted{AllowVerdict}, nil
	case "deny":
		return scripted{DenyVerdict("test:deny", "")}, nil
	case "escalate":
		return scripted{Escalate("test:escalate", "")}, nil
	default:
		// Section 7.7.5: a resolver message names nothing from the config.
		return nil, errors.New("unknown decision")
	}
}

func testRegistry(t *testing.T) *HostRegistry {
	t.Helper()
	reg := NewHostRegistry(testSurface())
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(reg.Kind("com.example.scripted", verdictFrom))
	must(reg.Kind("com.example.panics", func(json.RawMessage, BindingContext) (Interceptor, error) {
		panic("resolver bug")
	}))
	must(reg.Kind("com.example.nothing", func(json.RawMessage, BindingContext) (Interceptor, error) {
		return nil, nil
	}))
	must(reg.IdentityProvider("hmac-sha256-k1", func(ctx AgentContext) (string, error) {
		seq, _ := ctx["sequence"].(int64)
		return "mac:" + string(rune('0'+seq)), nil
	}))
	must(reg.ApprovalResolver("operator-queue", approver{Approve, AllowVerdict}))
	must(reg.ApprovalRedactor("strip-secrets", func(ctx AgentContext) AgentContext { return ctx }))
	return reg
}

func testDocument() map[string]any {
	return map[string]any{
		"declaration": DeclarationVersion,
		"id":          "test-doc",
		"configuration": map[string]any{
			"composition":       map[string]any{"profile": "parallel/strictest"},
			"identity_provider": "hmac-sha256-k1",
			"approval":          map[string]any{"resolver": "operator-queue", "redactor": "strip-secrets"},
			"timeouts":          map[string]any{"interceptor_ms": 2500},
			"records":           map[string]any{"max_buffered": 3},
		},
		"bindings": []any{
			map[string]any{"id": "a", "kind": "com.example.scripted", "config": map[string]any{"decision": "allow"}},
			map[string]any{"id": "b", "kind": "com.example.scripted", "config": map[string]any{"decision": "escalate"}, "at": []any{"pre_tool_call"}},
		},
	}
}

func tempFile(t *testing.T, name string, data []byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func declErr(t *testing.T, err error) *DeclarationError {
	t.Helper()
	var de *DeclarationError
	if !errors.As(err, &de) {
		t.Fatalf("want *DeclarationError, got %T: %v", err, err)
	}
	return de
}

func TestDeclarationVersionsMatchTheCore(t *testing.T) {
	current, supported, err := DeclarationVersions()
	if err != nil {
		t.Fatal(err)
	}
	if current != DeclarationVersion {
		t.Errorf("core current %q, Go constant %q", current, DeclarationVersion)
	}
	if !reflect.DeepEqual(supported, SupportedDeclarationVersions) {
		t.Errorf("core supported %v, Go %v", supported, SupportedDeclarationVersions)
	}
}

func TestThreePathsProduceIdenticalRecords(t *testing.T) {
	reg := testRegistry(t)
	doc := testDocument()
	text, _ := json.Marshal(doc)
	path := tempFile(t, "decl.json", text)

	fromPath, err := NewInterceptionEmitterFromDeclarationPath(path, reg)
	if err != nil {
		t.Fatal(err)
	}
	fromJSON, err := NewInterceptionEmitterFromDeclarationJSON(text, reg)
	if err != nil {
		t.Fatal(err)
	}
	fromValue, err := NewInterceptionEmitterFromDeclarationValue(doc, reg)
	if err != nil {
		t.Fatal(err)
	}
	built, err := NewDeclarationBuilder().
		ID("test-doc").
		Composition(StrictestComposition("")).
		IdentityProvider("hmac-sha256-k1").
		ApprovalResolver("operator-queue").
		ApprovalRedactor("strip-secrets").
		InterceptorTimeoutMs(2500).
		MaxBufferedRecords(3).
		Bind("a", "com.example.scripted", map[string]any{"decision": "allow"}).
		Bind("b", "com.example.scripted", map[string]any{"decision": "escalate"}, BindAt(PreToolCall)).
		Build()
	if err != nil {
		t.Fatal(err)
	}
	fromBuilder, err := NewInterceptionEmitterFromDeclaration(built, reg)
	if err != nil {
		t.Fatal(err)
	}

	emitters := map[string]*InterceptionEmitter{
		"path": fromPath, "json": fromJSON, "value": fromValue, "builder": fromBuilder,
	}
	canon := map[string]string{}
	records := map[string][]string{}
	for name, em := range emitters {
		if em.Declaration() == nil || !em.Sealed() {
			t.Fatalf("%s: emitter is not declaration-built", name)
		}
		c, err := em.Declaration().CanonicalJSON()
		if err != nil {
			t.Fatal(err)
		}
		canon[name] = c
		records[name] = sessionRecords(t, em)
	}
	for name := range emitters {
		if canon[name] != canon["path"] {
			t.Errorf("%s canonical form differs from path:\n%s\n%s", name, canon[name], canon["path"])
		}
		if !reflect.DeepEqual(records[name], records["path"]) {
			t.Errorf("%s records differ from path:\n%v\n%v", name, records[name], records["path"])
		}
	}
	// Section 7.7.8: the stamp, the per-point count and the names.
	var startup, preTool InterceptionRecord
	_ = json.Unmarshal([]byte(records["path"][0]), &startup)
	_ = json.Unmarshal([]byte(records["path"][2]), &preTool)
	if startup.Declaration == nil || *startup.Declaration != DeclarationVersion {
		t.Errorf("declaration stamp = %v", startup.Declaration)
	}
	if startup.InterceptorsRegistered != 1 || preTool.InterceptorsRegistered != 2 {
		t.Errorf("interceptors_registered = %d / %d, want 1 / 2", startup.InterceptorsRegistered, preTool.InterceptorsRegistered)
	}
	if len(preTool.Verdicts) != 2 || preTool.Verdicts[0].Name != "a" || preTool.Verdicts[1].Name != "b" {
		t.Errorf("verdict names = %+v", preTool.Verdicts)
	}
	if preTool.ResolvedBy == nil || *preTool.ResolvedBy != ResolvedByApproval {
		t.Errorf("resolved_by = %v, want approval", preTool.ResolvedBy)
	}
	if preTool.IdentityProvider == nil || *preTool.IdentityProvider != "hmac-sha256-k1" {
		t.Errorf("identity_provider = %v", preTool.IdentityProvider)
	}
	// records.max_buffered: 3 bounds the buffer.
	if got := len(fromPath.Records()); got != 3 {
		t.Errorf("buffered records = %d, want 3", got)
	}
	if fromPath.RecordsDropped() != 2 {
		t.Errorf("dropped = %d, want 2", fromPath.RecordsDropped())
	}
	// The resolved form is what the record stamps.
	resolved := fromPath.Declaration()
	if resolved.Configuration.Composition.OnTransformConflict != SynthesizeDeny {
		t.Errorf("resolved on_transform_conflict = %q, want the filled default", resolved.Configuration.Composition.OnTransformConflict)
	}
	if resolved.Configuration.Timeouts.ApprovalResolverMs == nil || *resolved.Configuration.Timeouts.ApprovalResolverMs != 2500 {
		t.Errorf("approval_resolver_ms should default to interceptor_ms")
	}
	if fromPath.Timeout != 2500*time.Millisecond {
		t.Errorf("Timeout = %v", fromPath.Timeout)
	}
	if len(resolved.Bindings) != 2 || len(resolved.Bindings[0].At) != 8 || len(resolved.Bindings[1].At) != 1 {
		t.Errorf("resolved bindings = %+v", resolved.Bindings)
	}
}

func TestCodePathRecordsCarryNoDeclaration(t *testing.T) {
	em := NewInterceptionEmitter(Enforce, nil)
	em.Register(scripted{AllowVerdict})
	if em.Declaration() != nil || em.Sealed() {
		t.Fatal("code-path emitter must not be declaration-built")
	}
	rec := emit(t, em, testCtx())
	if rec.Declaration != nil {
		t.Errorf("declaration must be absent on the code path, got %q", *rec.Declaration)
	}
	b, _ := json.Marshal(rec)
	if strings.Contains(string(b), "declaration") {
		t.Errorf("wire record must not mention declaration: %s", b)
	}
}

func TestRegisterAtFiltersPointsAndNamesVerdicts(t *testing.T) {
	em := NewInterceptionEmitter(Enforce, nil)
	if _, err := em.SetComposition(RunAllComposition()); err != nil {
		t.Fatal(err)
	}
	if err := em.RegisterAt(scripted{DenyVerdict("test:deny", "")}, "guard", []InterceptionPoint{PreToolCall}); err != nil {
		t.Fatal(err)
	}
	em.RegisterNamed(scripted{AllowVerdict}, "audit")
	input := emit(t, em, fixedCtx(Input, 0))
	if input.InterceptorsRegistered != 1 || input.Verdict.Decision != Allow || input.Verdicts[0].Name != "audit" {
		t.Errorf("input record = %+v", input)
	}
	pre := emit(t, em, fixedCtx(PreToolCall, 1))
	if pre.InterceptorsRegistered != 2 || pre.Verdict.Decision != Deny || pre.DecidedBy == nil || *pre.DecidedBy != 0 {
		t.Errorf("pre_tool_call record = %+v", pre)
	}
	if pre.Verdicts[0].Name != "guard" || pre.Verdicts[1].Name != "audit" {
		t.Errorf("names = %+v", pre.Verdicts)
	}
	if err := em.RegisterAt(scripted{AllowVerdict}, "", []InterceptionPoint{"nowhere"}); err == nil {
		t.Error("an unknown point must be refused")
	}
}

func TestPointWithoutBindingDeniesNoInterceptor(t *testing.T) {
	reg := testRegistry(t)
	doc := map[string]any{
		"declaration": DeclarationVersion,
		"bindings": []any{
			map[string]any{"id": "only-tools", "kind": "com.example.scripted",
				"config": map[string]any{"decision": "allow"}, "at": []any{"pre_tool_call"}},
		},
	}
	em, err := NewInterceptionEmitterFromDeclarationValue(doc, reg)
	if err != nil {
		t.Fatal(err)
	}
	rec := emit(t, em, fixedCtx(AgentStartup, 0))
	if rec.Verdict.Reason != string(ErrNoInterceptor) || rec.InterceptorsRegistered != 0 {
		t.Errorf("record = %+v", rec)
	}
	if rec.Declaration == nil {
		t.Error("declaration stamp missing on a synthesized deny")
	}
	hf, err := em.RecordHostFailure(Input, HostFailure{Detail: "TypeError"})
	if err != nil {
		t.Fatal(err)
	}
	if hf.Declaration == nil || hf.InterceptorsRegistered != 0 {
		t.Errorf("host failure record = %+v", hf)
	}
}

func TestSealedEmitterRefusesReconfiguration(t *testing.T) {
	em, err := NewInterceptionEmitterFromDeclarationValue(testDocument(), testRegistry(t))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := em.SetComposition(RunAllComposition()); !errors.Is(err, ErrEmitterSealed) {
		t.Errorf("SetComposition: %v", err)
	}
	if _, err := em.SetIdentityProvider(nil); !errors.Is(err, ErrEmitterSealed) {
		t.Errorf("SetIdentityProvider: %v", err)
	}
	if err := em.RegisterAt(scripted{AllowVerdict}, "", nil); !errors.Is(err, ErrEmitterSealed) {
		t.Errorf("RegisterAt: %v", err)
	}
	for name, f := range map[string]func(){
		"Register":            func() { em.Register(scripted{AllowVerdict}) },
		"SetApprovalRedactor": func() { em.SetApprovalRedactor(func(c AgentContext) AgentContext { return c }) },
		"SetMaxRecords":       func() { em.SetMaxRecords(1) },
	} {
		func() {
			defer func() {
				r := recover()
				if r == nil || !strings.Contains(r.(string), "sealed") {
					t.Errorf("%s: want a sealed panic, got %v", name, r)
				}
			}()
			f()
		}()
	}
	// Delivery stays open: the sink changes where records go, not
	// what they say.
	var seen int
	em.SetRecordSink(func(InterceptionRecord) { seen++ })
	emit(t, em, fixedCtx(Input, 0))
	if seen != 1 || len(em.TakeRecords()) != 1 {
		t.Error("sink and drain must work on a sealed emitter")
	}
}

func TestBindingRejectedByErrorPanicAndNil(t *testing.T) {
	reg := testRegistry(t)
	cases := map[string]map[string]any{
		"error": {"id": "x", "kind": "com.example.scripted", "config": map[string]any{"decision": "bogus"}},
		"panic": {"id": "x", "kind": "com.example.panics"},
		"nil":   {"id": "x", "kind": "com.example.nothing"},
	}
	for name, binding := range cases {
		doc := map[string]any{"declaration": DeclarationVersion, "bindings": []any{binding}}
		_, err := NewInterceptionEmitterFromDeclarationValue(doc, reg)
		de := declErr(t, err)
		if de.Class != DeclarationBindingRejected {
			t.Errorf("%s: class %s", name, de.Class)
		}
		if de.Findings[0].Pointer != "/bindings/0" || !strings.Contains(de.Findings[0].Detail, `binding "x"`) {
			t.Errorf("%s: finding %+v", name, de.Findings[0])
		}
		if strings.Contains(de.Error(), "bogus") {
			t.Errorf("%s: a resolver message may name the id and kind, the loader never echoes the config", name)
		}
	}
}

func TestUnreadableClassesFromPath(t *testing.T) {
	dir := t.TempDir()
	big := make([]byte, MaxDeclarationBytes+1)
	for i := range big {
		big[i] = ' '
	}
	cases := map[string]string{
		"missing":   filepath.Join(dir, "nope.json"),
		"directory": dir,
		"oversize":  tempFile(t, "big.json", big),
		"bom":       tempFile(t, "bom.json", append([]byte{0xEF, 0xBB, 0xBF}, []byte(`{"declaration":"agent-hooks-declaration/1.0","bindings":[]}`)...)),
		"utf8":      tempFile(t, "bad.json", []byte{'{', 0xFF, '}'}),
	}
	for name, path := range cases {
		_, err := LoadDeclarationPath(path)
		de := declErr(t, err)
		if de.Class != DeclarationUnreadable {
			t.Errorf("%s: class %s (%v)", name, de.Class, err)
		}
	}
	if _, err := LoadDeclarationPath(cases["missing"]); !strings.Contains(err.Error(), "NotFound") {
		t.Errorf("missing file detail should carry the error class: %v", err)
	}
}

func TestMalformedClasses(t *testing.T) {
	reg := testRegistry(t)
	deep := strings.Repeat("[", 40) + strings.Repeat("]", 40)
	texts := map[string]string{
		"not-json":   "{not json",
		"duplicate":  `{"declaration":"agent-hooks-declaration/1.0","declaration":"agent-hooks-declaration/1.0","bindings":[]}`,
		"depth":      `{"declaration":"agent-hooks-declaration/1.0","bindings":[],"extensions":{"x":` + deep + `}}`,
		"root-array": `[]`,
		"nul":        "{\x00}",
		"empty":      "",
	}
	for name, text := range texts {
		_, err := NewInterceptionEmitterFromDeclarationJSON([]byte(text), reg)
		de := declErr(t, err)
		if de.Class != DeclarationMalformed {
			t.Errorf("%s: class %s (%v)", name, de.Class, err)
		}
	}
	if _, err := ParseDeclaration([]byte{'{', 0xFF, '}'}); declErr(t, err).Class != DeclarationMalformed {
		t.Error("invalid UTF-8 bytes must be malformed")
	}
	_, err := DeclarationFromValue(map[string]any{"declaration": DeclarationVersion, "bindings": []any{}, "extensions": map[string]any{"x": math.NaN()}})
	if de := declErr(t, err); de.Class != DeclarationMalformed || !strings.Contains(de.Error(), "cannot serialize") {
		t.Errorf("NaN on the value path: %v", err)
	}
}

func TestOneClassPerDocumentInPipelineOrder(t *testing.T) {
	reg := testRegistry(t)
	base := func() map[string]any {
		return map[string]any{
			"declaration": DeclarationVersion,
			"bindings": []any{map[string]any{"id": "a", "kind": "com.example.scripted",
				"config": map[string]any{"decision": "allow"}}},
		}
	}
	type tc struct {
		mutate  func(map[string]any)
		class   DeclarationErrorClass
		pointer string
	}
	cases := map[string]tc{
		"version-reserved": {func(d map[string]any) { d["declaration"] = "agent-hooks-declaration/0.1" }, DeclarationVersionUnsupported, "/declaration"},
		"version-missing":  {func(d map[string]any) { delete(d, "declaration") }, DeclarationVersionUnsupported, "/declaration"},
		"version-higher":   {func(d map[string]any) { d["declaration"] = "agent-hooks-declaration/1.9" }, DeclarationVersionUnsupported, "/declaration"},
		"spec":             {func(d map[string]any) { d["spec"] = "agent-hooks/9.0" }, DeclarationSpecUnsupported, "/spec"},
		"unknown-top":      {func(d map[string]any) { d["policy"] = map[string]any{} }, DeclarationUnknownField, "/policy"},
		"unknown-nested": {func(d map[string]any) {
			d["configuration"] = map[string]any{"composition": map[string]any{"profile": "sequential/run_all", "on_timeout": "x"}}
		}, DeclarationUnknownField, "/configuration/composition/on_timeout"},
		"invalid-enum": {func(d map[string]any) { d["configuration"] = map[string]any{"mode": "audit"} }, DeclarationInvalidField, "/configuration/mode"},
		"unconsulted-knob": {func(d map[string]any) {
			d["configuration"] = map[string]any{"composition": map[string]any{"profile": "sequential/run_all", "on_approval": "resume"}}
		}, DeclarationInconsistent, ""},
		"floor": {func(d map[string]any) {
			d["surface"] = map[string]any{"interception_points": []any{"agent_startup", "input", "pre_tool_call", "post_tool_call", "output"}}
		}, DeclarationInconsistent, "/surface/interception_points"},
		"duplicate-id": {func(d map[string]any) {
			d["bindings"] = append(d["bindings"].([]any), map[string]any{"id": "a", "kind": "com.example.scripted", "config": map[string]any{"decision": "allow"}})
		}, DeclarationInconsistent, "/bindings/1/id"},
		"surface-version": {func(d map[string]any) {
			d["surface"] = map[string]any{"declaration_versions": []any{"agent-hooks-declaration/0.1", DeclarationVersion}}
		}, DeclarationSurfaceUnsupported, ""},
		"surface-capability": {func(d map[string]any) {
			d["surface"] = map[string]any{"capabilities": []any{"model_calls", "tool_calls", "host_declaration", "bigint_json"}}
		}, DeclarationSurfaceUnsupported, "/surface/capabilities"},
		"posture": {func(d map[string]any) {
			d["configuration"] = map[string]any{"posture": map[string]any{"tool_seam_host_error": "terminate"}}
		}, DeclarationSurfaceUnsupported, ""},
		"provider": {func(d map[string]any) { d["configuration"] = map[string]any{"identity_provider": "hmac-sha256-k2"} }, DeclarationReferenceUnresolved, "/configuration/identity_provider"},
		"resolver": {func(d map[string]any) {
			d["configuration"] = map[string]any{"approval": map[string]any{"resolver": "nobody"}}
		}, DeclarationReferenceUnresolved, "/configuration/approval/resolver"},
		"kind":      {func(d map[string]any) { d["bindings"].([]any)[0].(map[string]any)["kind"] = "com.example.none" }, DeclarationKindUnknown, "/bindings/0/kind"},
		"kind-ctk":  {func(d map[string]any) { d["bindings"].([]any)[0].(map[string]any)["kind"] = "ctk.scripted" }, DeclarationKindUnknown, "/bindings/0/kind"},
		"two-steps": {func(d map[string]any) { d["spec"] = "agent-hooks/9.0"; d["policy"] = 1 }, DeclarationSpecUnsupported, "/spec"},
	}
	for name, c := range cases {
		doc := base()
		c.mutate(doc)
		_, err := NewInterceptionEmitterFromDeclarationValue(doc, reg)
		de := declErr(t, err)
		if de.Class != c.class {
			t.Errorf("%s: class %s, want %s (%v)", name, de.Class, c.class, err)
			continue
		}
		if c.pointer != "" && de.Findings[0].Pointer != c.pointer {
			t.Errorf("%s: pointer %q, want %q", name, de.Findings[0].Pointer, c.pointer)
		}
		if de.Class == DeclarationVersionUnsupported {
			if !reflect.DeepEqual(de.Accepted, SupportedDeclarationVersions) {
				t.Errorf("%s: accepted = %v", name, de.Accepted)
			}
			if !strings.Contains(de.Error(), "accepted: "+DeclarationVersion) {
				t.Errorf("%s: message must name the accepted set: %v", name, de)
			}
		}
		if !errors.Is(err, &DeclarationError{Class: c.class}) || !errors.Is(err, &DeclarationError{}) {
			t.Errorf("%s: errors.Is by class failed", name)
		}
		if !strings.HasPrefix(de.Error(), "declaration_error:"+string(c.class)) {
			t.Errorf("%s: Error() = %q", name, de.Error())
		}
	}
}

func TestInvalidHostSurfaceIsAWrapperDefect(t *testing.T) {
	// A surface that breaks the section 3.2 pairs is the host's fault,
	// not the document's: the core reports marshal_error and the Go
	// loader passes that through untouched.
	s := DefaultHostSurface().WithPoints(PreToolCall)
	reg := NewHostRegistry(s)
	_ = reg.Kind("com.example.scripted", verdictFrom)
	_, err := NewInterceptionEmitterFromDeclarationValue(map[string]any{"declaration": DeclarationVersion, "bindings": []any{}}, reg)
	var ce *CoreError
	if !errors.As(err, &ce) || ce.Code != "marshal_error" {
		t.Fatalf("want marshal_error CoreError, got %T %v", err, err)
	}
	var de *DeclarationError
	if errors.As(err, &de) {
		t.Error("a wrapper defect must not look like a refusal of the document")
	}
}

func TestRegistryRefusals(t *testing.T) {
	reg := NewHostRegistry(testSurface())
	ok := func(json.RawMessage, BindingContext) (Interceptor, error) { return scripted{AllowVerdict}, nil }
	for _, kind := range []string{"ctk.scripted", "agent_hooks.allow", "nodot", "Com.Example.X", "com..x", "com.example.x."} {
		if err := reg.Kind(kind, ok); err == nil {
			t.Errorf("kind %q must be refused", kind)
		} else if _, isReg := err.(*HostRegistryError); !isReg {
			t.Errorf("kind %q: want *HostRegistryError, got %T", kind, err)
		}
	}
	if err := reg.Kind("com.example.x", ok); err != nil {
		t.Fatal(err)
	}
	if err := reg.Kind("com.example.x", ok); err == nil {
		t.Error("a kind registered twice must be refused")
	}
	if err := reg.IdentityProvider("jcs-sha256-mine", func(AgentContext) (string, error) { return "", nil }); err == nil {
		t.Error("a jcs-prefixed provider name must be refused")
	}
	if err := reg.ApprovalResolver("Operator", approver{}); err == nil {
		t.Error("an upper-case reference must be refused")
	}
	if err := reg.ApprovalRedactor(strings.Repeat("a", 65), func(c AgentContext) AgentContext { return c }); err == nil {
		t.Error("a 65-character reference must be refused")
	}
	names := reg.Names()
	if !reflect.DeepEqual(names.Kinds, []string{"com.example.x"}) || len(names.IdentityProviders) != 0 {
		t.Errorf("names = %+v", names)
	}
	// The conformance kit may open the ctk segment, and only that one.
	ctk := NewConformanceHostRegistry(testSurface())
	if err := ctk.Kind("ctk.scripted", ok); err != nil {
		t.Errorf("conformance registry must accept ctk kinds: %v", err)
	}
	if err := ctk.Kind("agent_hooks.x", ok); err == nil {
		t.Error("agent_hooks stays reserved for the conformance kit too")
	}
}

type slowInterceptor struct{ d time.Duration }

func (s slowInterceptor) Intercept(ctx context.Context, _ AgentContext) (Verdict, error) {
	select {
	case <-time.After(s.d):
		return AllowVerdict, nil
	case <-ctx.Done():
		return Verdict{}, ctx.Err()
	}
}

type slowResolver struct{ d time.Duration }

func (s slowResolver) Resolve(ctx context.Context, req ApprovalRequest) (ApprovalResolution, error) {
	select {
	case <-time.After(s.d):
		v := AllowVerdict
		return ApprovalResolution{Outcome: Approve, ContextIdentity: req.ContextIdentity, Verdict: &v}, nil
	case <-ctx.Done():
		return ApprovalResolution{}, ctx.Err()
	}
}

func TestDeclaredTimeoutsBoundInterceptorAndResolver(t *testing.T) {
	reg := NewHostRegistry(testSurface())
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(reg.Kind("com.example.slow", func(json.RawMessage, BindingContext) (Interceptor, error) {
		return slowInterceptor{300 * time.Millisecond}, nil
	}))
	must(reg.Kind("com.example.escalate", func(json.RawMessage, BindingContext) (Interceptor, error) {
		return scripted{Escalate("test:escalate", "")}, nil
	}))
	must(reg.ApprovalResolver("slow-queue", slowResolver{300 * time.Millisecond}))

	// A per-binding bound overrides the document-wide one.
	em, err := NewInterceptionEmitterFromDeclarationValue(map[string]any{
		"declaration":   DeclarationVersion,
		"configuration": map[string]any{"timeouts": map[string]any{"interceptor_ms": 60000}},
		"bindings": []any{
			map[string]any{"id": "slow", "kind": "com.example.slow", "timeout_ms": 20},
		},
	}, reg)
	must(err)
	rec := emit(t, em, fixedCtx(Input, 0))
	if rec.Verdict.Reason != string(ErrInterceptorTimeout) {
		t.Errorf("per-binding timeout: reason %q", rec.Verdict.Reason)
	}

	// approval_resolver_ms bounds the resolver on its own.
	em, err = NewInterceptionEmitterFromDeclarationValue(map[string]any{
		"declaration": DeclarationVersion,
		"configuration": map[string]any{
			"approval": map[string]any{"resolver": "slow-queue"},
			"timeouts": map[string]any{"interceptor_ms": 60000, "approval_resolver_ms": 20},
		},
		"bindings": []any{map[string]any{"id": "esc", "kind": "com.example.escalate"}},
	}, reg)
	must(err)
	rec = emit(t, em, fixedCtx(PreToolCall, 0))
	if rec.Verdict.Reason != string(ErrApprovalResolverFailed) || rec.ResolvedBy == nil || *rec.ResolvedBy != ResolvedByRejection {
		t.Errorf("resolver timeout: record %+v", rec)
	}

	// timeout_ms: null is unbounded and written out in the resolved form.
	em, err = NewInterceptionEmitterFromDeclarationValue(map[string]any{
		"declaration":   DeclarationVersion,
		"configuration": map[string]any{"timeouts": map[string]any{"interceptor_ms": nil}},
		"bindings":      []any{map[string]any{"id": "esc", "kind": "com.example.escalate"}},
	}, reg)
	must(err)
	if em.Timeout != 0 || em.Declaration().Configuration.Timeouts.InterceptorMs != nil {
		t.Errorf("null timeout must resolve to unbounded: %v", em.Timeout)
	}
}

func TestResolveDeclarationSurfaceTakesCitedNamesAsRegistered(t *testing.T) {
	decl, err := DeclarationFromValue(map[string]any{
		"declaration":   DeclarationVersion,
		"configuration": map[string]any{"identity_provider": "hmac-sha256-k1", "approval": map[string]any{"resolver": "queue"}},
		"bindings":      []any{map[string]any{"id": "a", "kind": "com.example.anything"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := ResolveDeclarationSurface(decl, testSurface())
	if err != nil {
		t.Fatalf("surface-only resolution must not check names: %v", err)
	}
	if !reflect.DeepEqual(resolved.Surface.Capabilities, []string{"host_declaration", "model_calls", "tool_calls"}) {
		t.Errorf("surface filled from the host: %v", resolved.Surface.Capabilities)
	}
	if resolved.Version() != DeclarationVersion || resolved.Spec != SpecVersion {
		t.Errorf("resolved header = %s %s", resolved.Version(), resolved.Spec)
	}
}

func TestBuilderWritesNullForZeroValues(t *testing.T) {
	v := NewDeclarationBuilder().
		IdentityProvider("").
		ApprovalResolver("").
		InterceptorTimeoutMs(0).
		MaxBufferedRecords(0).
		Bind("a", "com.example.x", nil, BindTimeoutMs(0)).
		Extension("acme", map[string]any{"team": "sec"}).
		Value()
	cfg := v["configuration"].(map[string]any)
	if cfg["identity_provider"] != nil || cfg["approval"].(map[string]any)["resolver"] != nil {
		t.Errorf("empty names must write null: %v", cfg)
	}
	if cfg["timeouts"].(map[string]any)["interceptor_ms"] != nil || cfg["records"].(map[string]any)["max_buffered"] != nil {
		t.Errorf("zero bounds must write null: %v", cfg)
	}
	b := v["bindings"].([]any)[0].(map[string]any)
	if _, has := b["config"]; has || b["timeout_ms"] != nil {
		t.Errorf("binding = %v", b)
	}
	if v["extensions"].(map[string]any)["acme"] == nil {
		t.Error("extension missing")
	}
}

// TestGoldenDeclarationsResolveByteForByte pins the cross-SDK golden
// file conformance/golden/declaration.json: each document resolved
// against the fixture surface and names yields the recorded canonical
// JSON.
func TestGoldenDeclarationsResolveByteForByte(t *testing.T) {
	path := filepath.Join("..", "..", "..", "conformance", "golden", "declaration.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var golden struct {
		Surface  HostSurface   `json:"surface"`
		Names    RegistryNames `json:"names"`
		Fixtures []struct {
			ID       string         `json:"id"`
			Document map[string]any `json:"document"`
			Expect   struct {
				CanonicalJSON string `json:"canonical_json"`
			} `json:"expect"`
		} `json:"fixtures"`
	}
	if err := json.Unmarshal(data, &golden); err != nil {
		t.Fatalf("parse golden: %v", err)
	}
	reg := NewHostRegistry(golden.Surface)
	for _, k := range golden.Names.Kinds {
		if err := reg.Kind(k, func(json.RawMessage, BindingContext) (Interceptor, error) { return scripted{AllowVerdict}, nil }); err != nil {
			t.Fatal(err)
		}
	}
	for _, n := range golden.Names.IdentityProviders {
		if err := reg.IdentityProvider(n, func(AgentContext) (string, error) { return "mac", nil }); err != nil {
			t.Fatal(err)
		}
	}
	for _, n := range golden.Names.ApprovalResolvers {
		if err := reg.ApprovalResolver(n, approver{Approve, AllowVerdict}); err != nil {
			t.Fatal(err)
		}
	}
	for _, n := range golden.Names.ApprovalRedactors {
		if err := reg.ApprovalRedactor(n, func(c AgentContext) AgentContext { return c }); err != nil {
			t.Fatal(err)
		}
	}
	if len(golden.Fixtures) == 0 {
		t.Fatal("no fixtures")
	}
	for _, f := range golden.Fixtures {
		t.Run(f.ID, func(t *testing.T) {
			decl, err := DeclarationFromValue(f.Document)
			if err != nil {
				t.Fatal(err)
			}
			resolved, err := reg.Resolve(decl)
			if err != nil {
				t.Fatalf("resolve: %v", err)
			}
			got, err := resolved.CanonicalJSON()
			if err != nil {
				t.Fatal(err)
			}
			if got != f.Expect.CanonicalJSON {
				t.Errorf("mismatch\n got %s\nwant %s", got, f.Expect.CanonicalJSON)
			}
		})
	}
}

func TestRegisterAtRefusesAnEmptyPointList(t *testing.T) {
	em := NewInterceptionEmitter(Enforce, nil)
	if err := em.RegisterAt(scripted{AllowVerdict}, "", []InterceptionPoint{}); err == nil {
		t.Fatal("an empty non-nil at must be refused")
	}
	if err := em.RegisterAt(scripted{AllowVerdict}, "", nil); err != nil {
		t.Fatalf("nil means every point: %v", err)
	}
	if rec := emit(t, em, fixedCtx(Input, 0)); rec.InterceptorsRegistered != 1 {
		t.Errorf("record = %+v", rec)
	}
}

// TestMaxBufferedAboveMaxIntStaysABound: int(uint64) wraps negative
// above math.MaxInt, which the emitter would read as unbounded.
func TestMaxBufferedAboveMaxIntStaysABound(t *testing.T) {
	reg := testRegistry(t)
	doc := map[string]any{
		"declaration":   DeclarationVersion,
		"configuration": map[string]any{"records": map[string]any{"max_buffered": json.Number("18446744073709551615")}},
		"bindings": []any{
			map[string]any{"id": "a", "kind": "com.example.scripted", "config": map[string]any{"decision": "allow"}},
		},
	}
	em, err := NewInterceptionEmitterFromDeclarationValue(doc, reg)
	if err != nil {
		t.Fatal(err)
	}
	if em.maxRecords != math.MaxInt {
		t.Fatalf("maxRecords = %d, want math.MaxInt", em.maxRecords)
	}
	doc["configuration"] = map[string]any{"records": map[string]any{"max_buffered": json.Number("2")}}
	if em, err = NewInterceptionEmitterFromDeclarationValue(doc, reg); err != nil {
		t.Fatal(err)
	}
	if em.maxRecords != 2 {
		t.Fatalf("maxRecords = %d, want 2", em.maxRecords)
	}
}
