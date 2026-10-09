// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

package conformance

// Host declaration support for the CTK runner (§7.7.9): the registry a
// declaration vector resolves against, the construction-path proof of
// §7.7.7, and the builder path that rebuilds a document member by
// member.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"

	"github.com/responsibleai/agent-hooks/sdk/go/agenthooks"
)

// recorder collects every context the recording interceptor saw.
// Shared by the field-based and the declaration path so the runner can
// read it back after the run.
type recorder struct {
	recorded []agenthooks.AgentContext
}

// scripts is the scripted interceptors and resolver a vector carries.
type scripts struct {
	scripts  []string // pre-marshalled interceptor_scripts[i]
	approval string   // pre-marshalled approval_script, "" when absent
	redact   []string
	rec      *recorder
}

func scriptsOf(vector map[string]any) *scripts {
	var lists []any
	if ss, ok := vector["interceptor_scripts"].([]any); ok {
		lists = ss
	} else {
		lists = []any{vector["interceptor_script"]}
	}
	s := &scripts{rec: &recorder{}}
	for _, l := range lists {
		s.scripts = append(s.scripts, mustJSON(l))
	}
	if approval, ok := vector["approval_script"].([]any); ok && len(approval) > 0 {
		s.approval = mustJSON(approval)
	}
	if raw, ok := vector["redact_for_approval"].([]any); ok {
		for _, p := range raw {
			if sp, ok := p.(string); ok {
				s.redact = append(s.redact, sp)
			}
		}
	}
	return s
}

// interceptor returns scripted interceptor i; only index 0 records
// (expect.interceptions describes each emission as it saw it).
func (s *scripts) interceptor(i int) *scriptedInterceptor {
	si := &scriptedInterceptor{rulesJSON: s.scripts[i]}
	if i == 0 {
		si.rec = s.rec
	}
	return si
}

func (s *scripts) interceptors() []agenthooks.Interceptor {
	out := make([]agenthooks.Interceptor, 0, len(s.scripts))
	for i := range s.scripts {
		out = append(out, s.interceptor(i))
	}
	return out
}

func (s *scripts) resolver() agenthooks.ApprovalResolver {
	if s.approval == "" {
		return nil
	}
	return &scriptedResolver{rulesJSON: s.approval}
}

// registry is the CTK registry for a declaration vector (§7.7.9): kind
// ctk.scripted (config {"script": i}), identity provider ctk-fault,
// approval resolver ctk-scripted and redactor ctk-redact.
func (s *scripts) registry(surface agenthooks.HostSurface) (*agenthooks.HostRegistry, error) {
	reg := agenthooks.NewConformanceHostRegistry(surface)
	scripted := func(config json.RawMessage, ctx agenthooks.BindingContext) (agenthooks.Interceptor, error) {
		// config.script must be a JSON integer; a quoted digit is not
		// one, so the raw token is checked, not a converted value.
		var cfg map[string]json.RawMessage
		if err := json.Unmarshal(config, &cfg); err != nil {
			return nil, errors.New("config must be an object")
		}
		// Bit size 31 bounds the value so the conversion to int cannot
		// overflow on any platform; the range check against the script
		// count still follows.
		i, err := strconv.ParseUint(string(cfg["script"]), 10, 31)
		if err != nil {
			return nil, errors.New("config.script must be an unsigned integer index")
		}
		if int(i) >= len(s.scripts) {
			return nil, fmt.Errorf("config.script %d is out of range for binding %s", i, ctx.ID)
		}
		return s.interceptor(int(i)), nil
	}
	if err := reg.Kind("ctk.scripted", scripted); err != nil {
		return nil, err
	}
	if err := reg.IdentityProvider("ctk-fault", func(agenthooks.AgentContext) (string, error) {
		return "", errors.New("ctk scripted provider fault")
	}); err != nil {
		return nil, err
	}
	approval := s.approval
	if approval == "" {
		approval = "[]"
	}
	if err := reg.ApprovalResolver("ctk-scripted", &scriptedResolver{rulesJSON: approval}); err != nil {
		return nil, err
	}
	redact := append([]string(nil), s.redact...)
	if err := reg.ApprovalRedactor("ctk-redact", func(actx agenthooks.AgentContext) agenthooks.AgentContext {
		return redactPaths(actx, redact)
	}); err != nil {
		return nil, err
	}
	return reg, nil
}

// redactPaths is the §9 redaction seam, CTK convention: each listed
// path is replaced with "[redacted]" via the §5.2/§4.3 transform
// machinery; a path that does not resolve at the escalating point is
// left untouched.
func redactPaths(actx agenthooks.AgentContext, paths []string) agenthooks.AgentContext {
	current := actx
	for _, path := range paths {
		next, err := agenthooks.ApplyTransformToContext(current, path, "[redacted]")
		if err != nil {
			continue
		}
		current = next
	}
	return current
}

// writeTempDocument writes text to a fresh file under os.TempDir()
// with an unpredictable name (O_EXCL, mode 0600), through the returned
// handle, so a planted symlink in a shared temporary directory is
// neither followed nor overwritten.
func writeTempDocument(tag, text string) (string, error) {
	f, err := os.CreateTemp("", "agent-hooks-ctk-"+tag+"-*.json")
	if err != nil {
		return "", err
	}
	path := f.Name()
	if _, err := f.WriteString(text); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return "", err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(path)
		return "", err
	}
	return path, nil
}

// provePaths resolves doc through the four construction paths of
// §7.7.7 (value, JSON text, a temporary file, the builder) and
// compares: equal canonical forms, or equal refusal classes, prove the
// paths equivalent. Returns (equivalent, detail).
func provePaths(doc map[string]any, reg *agenthooks.HostRegistry, tag string) (bool, string) {
	text := mustJSON(doc)
	type outcome struct {
		name string
		key  string
		desc string
	}
	resolve := func(name string, decl agenthooks.HostDeclaration, derr error) outcome {
		if derr == nil {
			var resolved *agenthooks.ResolvedDeclaration
			resolved, derr = reg.Resolve(decl)
			if derr == nil {
				canon, cerr := resolved.CanonicalJSON()
				if cerr != nil {
					return outcome{name, "canon-error:" + cerr.Error(), cerr.Error()}
				}
				return outcome{name, "ok:" + canon, "accepted"}
			}
		}
		var de *agenthooks.DeclarationError
		if errors.As(derr, &de) {
			return outcome{name, "err:" + de.Code(), de.Error()}
		}
		return outcome{name, "err:" + derr.Error(), derr.Error()}
	}

	var outcomes []outcome
	d, err := agenthooks.DeclarationFromValue(doc)
	outcomes = append(outcomes, resolve("value", d, err))
	d, err = agenthooks.ParseDeclaration([]byte(text))
	outcomes = append(outcomes, resolve("json", d, err))

	if path, werr := writeTempDocument(tag, text); werr != nil {
		outcomes = append(outcomes, outcome{"file", "err:write", "cannot write temporary file: " + werr.Error()})
	} else {
		d, err = agenthooks.LoadDeclarationPath(path)
		outcomes = append(outcomes, resolve("file", d, err))
		_ = os.Remove(path)
	}

	d, err = builderFromValue(doc).Build()
	outcomes = append(outcomes, resolve("builder", d, err))

	same := true
	for _, o := range outcomes[1:] {
		if o.key != outcomes[0].key {
			same = false
		}
	}
	if same {
		return true, ""
	}
	var detail strings.Builder
	for _, o := range outcomes {
		fmt.Fprintf(&detail, "%s: %s; ", o.name, o.desc)
	}
	var oks []string
	for _, o := range outcomes {
		if strings.HasPrefix(o.key, "ok:") {
			oks = append(oks, o.key)
		}
	}
	if len(oks) >= 2 && oks[0] != oks[1] {
		pos := 0
		for pos < len(oks[0]) && pos < len(oks[1]) && oks[0][pos] == oks[1][pos] {
			pos++
		}
		fmt.Fprintf(&detail, "first difference at byte %d", pos)
	}
	return false, detail.String()
}

// builderFromValue rebuilds a document through the DeclarationBuilder,
// member by member (§7.7.7, the code path). Members the typed setters
// cannot express exactly (an unknown member, a wrong type) go through
// Raw, so the result is validated like the file it came from.
func builderFromValue(doc map[string]any) *agenthooks.DeclarationBuilder {
	b := agenthooks.NewEmptyDeclarationBuilder()
	for k, v := range doc {
		switch k {
		case "declaration":
			if s, ok := v.(string); ok {
				b.Version(s)
				continue
			}
		case "spec":
			if s, ok := v.(string); ok {
				b.Spec(s)
				continue
			}
		case "id":
			if s, ok := v.(string); ok {
				b.ID(s)
				continue
			}
		case "host":
			if h, ok := v.(map[string]any); ok && typedHost(b, h) {
				continue
			}
		case "configuration":
			if c, ok := v.(map[string]any); ok && typedConfiguration(b, c) {
				continue
			}
		case "surface":
			if sf, ok := v.(map[string]any); ok && typedSurface(b, sf) {
				continue
			}
		case "bindings":
			if items, ok := v.([]any); ok && typedBindings(b, items) {
				continue
			}
		case "extensions":
			if e, ok := v.(map[string]any); ok {
				for ek, ev := range e {
					b.Extension(ek, ev)
				}
				continue
			}
		}
		b.Raw(k, v)
	}
	return b
}

func typedHost(b *agenthooks.DeclarationBuilder, h map[string]any) bool {
	name, ok := h["name"].(string)
	if !ok {
		return false
	}
	version := ""
	for k, v := range h {
		switch k {
		case "name":
		case "version":
			s, ok := v.(string)
			if !ok {
				return false
			}
			version = s
		default:
			return false
		}
	}
	b.Host(name, version)
	return true
}

// uintOrNull reads a JSON integer member for a setter whose 0 writes
// null. A non-integer, negative, fractional or zero value is not
// expressible and falls back to Raw.
func uintOrNull(v any) (uint64, bool) {
	if v == nil {
		return 0, true
	}
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	if strings.ContainsAny(string(n), ".eE") {
		return 0, false
	}
	i, err := n.Int64()
	if err != nil || i <= 0 {
		return 0, false
	}
	return uint64(i), true
}

func typedConfiguration(b *agenthooks.DeclarationBuilder, c map[string]any) bool {
	// Apply only when every member is expressible; a partial typed
	// write would otherwise leave the rest unrepresented.
	type action func()
	var actions []action
	for k, v := range c {
		switch k {
		case "mode":
			s, ok := v.(string)
			if !ok || (s != "enforce" && s != "evaluate_only") {
				return false
			}
			actions = append(actions, func() { b.Mode(agenthooks.EnforcementMode(s)) })
		case "composition":
			comp, ok := v.(map[string]any)
			if !ok {
				return false
			}
			var cfg agenthooks.CompositionConfig
			for kk, vv := range comp {
				s, ok := vv.(string)
				if !ok || s == "" {
					return false
				}
				switch kk {
				case "profile":
					cfg.Profile = agenthooks.CompositionProfile(s)
				case "on_approval":
					cfg.OnApproval = agenthooks.OnApproval(s)
				case "on_disagreement":
					cfg.OnDisagreement = agenthooks.SynthesisPolicy(s)
				case "on_transform_conflict":
					cfg.OnTransformConflict = agenthooks.SynthesisPolicy(s)
				default:
					return false
				}
			}
			actions = append(actions, func() { b.Composition(cfg) })
		case "identity_provider":
			name, ok := stringOrNull(v)
			if !ok {
				return false
			}
			actions = append(actions, func() { b.IdentityProvider(name) })
		case "approval":
			a, ok := v.(map[string]any)
			if !ok {
				return false
			}
			for ak, av := range a {
				name, ok := stringOrNull(av)
				if !ok {
					return false
				}
				switch ak {
				case "resolver":
					actions = append(actions, func() { b.ApprovalResolver(name) })
				case "redactor":
					actions = append(actions, func() { b.ApprovalRedactor(name) })
				default:
					return false
				}
			}
		case "posture":
			p, ok := v.(map[string]any)
			if !ok || len(p) != 1 {
				return false
			}
			s, ok := p["tool_seam_host_error"].(string)
			if !ok || (s != "continue" && s != "terminate") {
				return false
			}
			actions = append(actions, func() { b.ToolSeamHostError(agenthooks.ToolSeamPosture(s)) })
		case "timeouts":
			t, ok := v.(map[string]any)
			if !ok {
				return false
			}
			for tk, tv := range t {
				ms, ok := uintOrNull(tv)
				if !ok {
					return false
				}
				switch tk {
				case "interceptor_ms":
					actions = append(actions, func() { b.InterceptorTimeoutMs(ms) })
				case "approval_resolver_ms":
					actions = append(actions, func() { b.ApprovalResolverTimeoutMs(ms) })
				default:
					return false
				}
			}
		case "records":
			r, ok := v.(map[string]any)
			if !ok || len(r) != 1 {
				return false
			}
			raw, present := r["max_buffered"]
			if !present {
				return false
			}
			n, ok := uintOrNull(raw)
			if !ok {
				return false
			}
			actions = append(actions, func() { b.MaxBufferedRecords(n) })
		default:
			return false
		}
	}
	for _, a := range actions {
		a()
	}
	return true
}

func stringOrNull(v any) (string, bool) {
	if v == nil {
		return "", true
	}
	s, ok := v.(string)
	if !ok || s == "" {
		return "", false
	}
	return s, true
}

func pointsOf(v any) ([]agenthooks.InterceptionPoint, bool) {
	list, ok := v.([]any)
	if !ok {
		return nil, false
	}
	out := make([]agenthooks.InterceptionPoint, 0, len(list))
	for _, p := range list {
		s, ok := p.(string)
		if !ok {
			return nil, false
		}
		out = append(out, agenthooks.InterceptionPoint(s))
	}
	return out, true
}

func stringsOf(v any) ([]string, bool) {
	list, ok := v.([]any)
	if !ok {
		return nil, false
	}
	out := make([]string, 0, len(list))
	for _, p := range list {
		s, ok := p.(string)
		if !ok {
			return nil, false
		}
		out = append(out, s)
	}
	return out, true
}

func typedSurface(b *agenthooks.DeclarationBuilder, sf map[string]any) bool {
	type action func()
	var actions []action
	buffered, hasBuffered := sf["buffered_output"]
	bound, hasBound := sf["exposure_bound"]
	if hasBuffered {
		bb, ok := buffered.(bool)
		if !ok {
			return false
		}
		bs := ""
		if hasBound {
			s, ok := bound.(string)
			if !ok || s == "" {
				return false
			}
			bs = s
		}
		actions = append(actions, func() { b.BufferedOutput(bb, bs) })
	} else if hasBound {
		return false
	}
	for k, v := range sf {
		switch k {
		case "interception_points":
			points, ok := pointsOf(v)
			if !ok {
				return false
			}
			actions = append(actions, func() { b.SurfacePoints(points...) })
		case "capabilities":
			caps, ok := stringsOf(v)
			if !ok {
				return false
			}
			actions = append(actions, func() { b.SurfaceCapabilities(caps...) })
		case "declaration_versions":
			versions, ok := stringsOf(v)
			if !ok {
				return false
			}
			actions = append(actions, func() { b.SurfaceDeclarationVersions(versions...) })
		case "profiles":
			profiles, ok := v.(map[string]any)
			if !ok {
				return false
			}
			for name, knobs := range profiles {
				var support agenthooks.KnobSupport
				if err := json.Unmarshal([]byte(mustJSON(knobs)), &support); err != nil {
					return false
				}
				km, ok := knobs.(map[string]any)
				if !ok || !knobKeysKnown(km) {
					return false
				}
				// KnobSupport drops an empty set (omitempty), which the
				// loader would accept as "default only" while the text
				// path refuses it; such a member goes through Raw.
				for _, values := range km {
					if list, ok := values.([]any); ok && len(list) == 0 {
						return false
					}
				}
				profile := agenthooks.CompositionProfile(name)
				actions = append(actions, func() { b.SurfaceProfile(profile, support) })
			}
		case "buffered_output", "exposure_bound":
		default:
			return false
		}
	}
	for _, a := range actions {
		a()
	}
	return true
}

func knobKeysKnown(m map[string]any) bool {
	for k := range m {
		switch k {
		case "on_approval", "on_disagreement", "on_transform_conflict":
		default:
			return false
		}
	}
	return true
}

func typedBindings(b *agenthooks.DeclarationBuilder, items []any) bool {
	if len(items) == 0 {
		// The written-down empty-deny host (§7.7.5): Bind is never
		// called, so the member is set explicitly.
		b.Raw("bindings", []any{})
		return true
	}
	type binding struct {
		id, kind string
		config   any
		opts     []agenthooks.BindOption
	}
	var bindings []binding
	for _, item := range items {
		o, ok := item.(map[string]any)
		if !ok {
			return false
		}
		id, ok := o["id"].(string)
		if !ok {
			return false
		}
		kind, ok := o["kind"].(string)
		if !ok {
			return false
		}
		bd := binding{id: id, kind: kind}
		for k, v := range o {
			switch k {
			case "id", "kind":
			case "config":
				// Bind omits a nil config; a present `"config": null`
				// must round-trip as null so the builder path equals
				// the text path.
				if v == nil {
					v = json.RawMessage("null")
				}
				bd.config = v
			case "at":
				points, ok := pointsOf(v)
				if !ok {
					return false
				}
				bd.opts = append(bd.opts, agenthooks.BindAt(points...))
			case "timeout_ms":
				ms, ok := uintOrNull(v)
				if !ok {
					return false
				}
				bd.opts = append(bd.opts, agenthooks.BindTimeoutMs(ms))
			default:
				return false
			}
		}
		bindings = append(bindings, bd)
	}
	for _, bd := range bindings {
		b.Bind(bd.id, bd.kind, bd.config, bd.opts...)
	}
	return true
}

// resolvedSurface resolves a harness's own declaration against its
// code surface (§7.7.9) and returns the capabilities and posture the
// run is assessed against.
func resolvedSurface(doc map[string]any, surface agenthooks.HostSurface) ([]string, string, error) {
	decl, err := agenthooks.DeclarationFromValue(doc)
	if err != nil {
		return nil, "", err
	}
	resolved, err := agenthooks.ResolveDeclarationSurface(decl, surface)
	if err != nil {
		return nil, "", err
	}
	return append([]string(nil), resolved.Surface.Capabilities...),
		string(resolved.Configuration.Posture.ToolSeamHostError), nil
}

// harnessSurfaceCache memoises resolvedSurface by document and code
// surface, so a harness's own declaration goes through the core once
// per run rather than once per vector (§7.7.9). The key is the JSON
// text of both inputs; a changed document or surface misses.
var harnessSurfaceCache sync.Map // string -> *harnessSurfaceEntry

type harnessSurfaceEntry struct {
	caps    []string
	posture string
	err     error
}

func cachedResolvedSurface(doc map[string]any, surface agenthooks.HostSurface) ([]string, string, error) {
	key := mustJSON(doc) + "\x00" + mustJSON(surface)
	if v, ok := harnessSurfaceCache.Load(key); ok {
		e := v.(*harnessSurfaceEntry)
		return append([]string(nil), e.caps...), e.posture, e.err
	}
	caps, posture, err := resolvedSurface(doc, surface)
	harnessSurfaceCache.Store(key, &harnessSurfaceEntry{caps: caps, posture: posture, err: err})
	return append([]string(nil), caps...), posture, err
}

// codeSurface is the harness's code surface: its own when it declares
// one, else the surface derived from its capability list and posture.
func codeSurface(h Harness, posture string) agenthooks.HostSurface {
	if d, ok := h.(HostSurfaceDeclarer); ok {
		return d.HostSurface()
	}
	caps := make([]string, 0, len(h.Capabilities()))
	for c := range h.Capabilities() {
		caps = append(caps, string(c))
	}
	return agenthooks.HostSurfaceFromCapabilities(caps, agenthooks.ToolSeamPosture(posture))
}

// runDeclared wires and runs one declaration vector (§7.7.9). It
// returns the RunRecord with Load set, or an error when the harness
// cannot take the vector at all.
func runDeclared(ctx context.Context, h Harness, scenario Scenario, document map[string]any,
	sc *scripts, surface agenthooks.HostSurface, tag string) (RunRecord, error) {
	dh, ok := h.(DeclaredHarness)
	if !ok {
		return RunRecord{}, fmt.Errorf("harness %q declares host_declaration but does not implement DeclaredHarness", h.Name())
	}
	reg, err := sc.registry(surface)
	if err != nil {
		return RunRecord{}, err
	}
	equivalent, pathDetail := provePaths(document, reg, tag)
	load := &LoadRecord{PathsEquivalent: &equivalent}
	if err := dh.SetupDeclared(scenario, document, reg); err != nil {
		h.Teardown()
		var de *agenthooks.DeclarationError
		if !errors.As(err, &de) {
			return RunRecord{}, fmt.Errorf("harness.SetupDeclared returned a non-declaration error: %w", err)
		}
		load.Outcome = "refused"
		load.Class = de.Code()
		load.Detail = de.Error()
		if pathDetail != "" {
			load.Detail += "; paths: " + pathDetail
		}
		return RunRecord{Outcome: Errored, Err: de.Error(), Load: load}, nil
	}
	rr, runErr := h.Run(ctx)
	h.Teardown()
	if runErr != nil {
		return RunRecord{}, runErr
	}
	load.Outcome = "accepted"
	load.Detail = pathDetail
	rr.Load = load
	return rr, nil
}
