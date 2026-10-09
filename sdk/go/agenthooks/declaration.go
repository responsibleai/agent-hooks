// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

package agenthooks

// Host declaration document (spec section 7.7): the loader, the host
// registry it resolves against and the resolved form.
//
// A declaration is one JSON object that fixes a host's configuration,
// its declared surface and its interceptor bindings. It is a versioned
// contract of its own (agent-hooks-declaration/<major>.<minor>),
// separate from the wire version SpecVersion and from the module
// version.
//
// Loading is a pipeline (section 7.7.6). Steps 1 (read a file) and 11
// (run the host's kind resolvers) are Go code here, because they touch
// the file system and host callables. Steps 2 to 10 run in the Rust
// core through one call (ah_declaration_resolve), so every construction
// path is checked by one function and a given document yields the same
// refusal class on every SDK. Refusals are construction errors
// (*DeclarationError), never verdicts: no emitter exists yet, so there
// is no record to carry a section 11 reason.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// DeclarationVersion is the host declaration contract version this
// module writes and accepts (section 7.7.2). Independent of
// SpecVersion and of the module version.
const DeclarationVersion = "agent-hooks-declaration/1.0"

// SupportedDeclarationVersions lists every contract version the loader
// accepts (section 7.7.2). A document carrying any other `declaration`
// value is refused with declaration_error:version_unsupported.
var SupportedDeclarationVersions = []string{DeclarationVersion}

// MaxDeclarationBytes is the largest document the text paths accept.
const MaxDeclarationBytes = 1 << 20

// maxDeclarationDetailLen bounds a refusal detail (section 7.7.3).
const maxDeclarationDetailLen = 512

// DeclarationErrorClass is one of the eleven refusal classes of
// section 7.7.6, in its bare form (`unknown_field`). Code() gives the
// namespaced form that crosses the FFI.
type DeclarationErrorClass string

const (
	DeclarationUnreadable          DeclarationErrorClass = "unreadable"
	DeclarationMalformed           DeclarationErrorClass = "malformed"
	DeclarationVersionUnsupported  DeclarationErrorClass = "version_unsupported"
	DeclarationSpecUnsupported     DeclarationErrorClass = "spec_unsupported"
	DeclarationUnknownField        DeclarationErrorClass = "unknown_field"
	DeclarationInvalidField        DeclarationErrorClass = "invalid_field"
	DeclarationInconsistent        DeclarationErrorClass = "inconsistent"
	DeclarationSurfaceUnsupported  DeclarationErrorClass = "surface_unsupported"
	DeclarationReferenceUnresolved DeclarationErrorClass = "reference_unresolved"
	DeclarationKindUnknown         DeclarationErrorClass = "kind_unknown"
	DeclarationBindingRejected     DeclarationErrorClass = "binding_rejected"
)

// declarationErrorPrefix is the namespace of the refusal classes.
const declarationErrorPrefix = "declaration_error:"

// Code returns the namespaced class, e.g. declaration_error:unknown_field.
func (c DeclarationErrorClass) Code() string { return declarationErrorPrefix + string(c) }

// DeclarationFinding is one problem a load step found: a JSON pointer
// into the document (`/bindings/1/kind`; the empty string is the root)
// and a detail that names members, kinds and ids but never binding
// configuration.
type DeclarationFinding struct {
	Pointer string `json:"pointer"`
	Detail  string `json:"detail"`
}

// DeclarationError is a refused declaration (section 7.7.6). It
// carries one class, every finding that step produced and, for
// version_unsupported, the accepted version set. Use errors.As to
// recover it from the error a construction function returns.
type DeclarationError struct {
	Class    DeclarationErrorClass
	Findings []DeclarationFinding
	Accepted []string
}

// Code returns the namespaced class (declaration_error:<class>).
func (e *DeclarationError) Code() string { return e.Class.Code() }

// Error renders the code and every finding, the way the Rust core does.
func (e *DeclarationError) Error() string {
	var b strings.Builder
	b.WriteString(e.Code())
	for i, f := range e.Findings {
		if i == 0 {
			b.WriteString(": ")
		} else {
			b.WriteString("; ")
		}
		if f.Pointer != "" {
			b.WriteString(f.Pointer)
			b.WriteString(": ")
		}
		b.WriteString(f.Detail)
	}
	return b.String()
}

// Is lets errors.Is(err, &DeclarationError{Class: c}) match on the
// class alone; an empty Class matches any declaration error.
func (e *DeclarationError) Is(target error) bool {
	var t *DeclarationError
	if errors.As(target, &t) {
		return t.Class == "" || t.Class == e.Class
	}
	return false
}

func newDeclarationError(class DeclarationErrorClass, pointer, detail string) *DeclarationError {
	return &DeclarationError{
		Class:    class,
		Findings: []DeclarationFinding{{Pointer: pointer, Detail: truncateDetail(detail)}},
	}
}

// truncateDetail bounds a detail at maxDeclarationDetailLen characters,
// the ellipsis included, as the core does.
func truncateDetail(s string) string {
	if utf8.RuneCountInString(s) <= maxDeclarationDetailLen {
		return s
	}
	runes := []rune(s)
	return string(runes[:maxDeclarationDetailLen-1]) + "…"
}

// declarationErrorFrom rewraps a core refusal (a CoreError whose code
// is declaration_error:*) as a *DeclarationError. Any other error, a
// marshal_error for a host description the core cannot read included,
// is returned unchanged: it is a wrapper or host defect, not a refusal
// of the document.
func declarationErrorFrom(err error) error {
	var ce *CoreError
	if !errors.As(err, &ce) || !strings.HasPrefix(ce.Code, declarationErrorPrefix) {
		return err
	}
	var detail struct {
		Findings []DeclarationFinding `json:"findings"`
		Accepted []string             `json:"accepted"`
	}
	if jerr := json.Unmarshal([]byte(ce.Detail), &detail); jerr != nil {
		detail.Findings = []DeclarationFinding{{Pointer: "", Detail: ce.Detail}}
	}
	return &DeclarationError{
		Class:    DeclarationErrorClass(strings.TrimPrefix(ce.Code, declarationErrorPrefix)),
		Findings: detail.Findings,
		Accepted: detail.Accepted,
	}
}

// HostRegistryError is a host registry programming error (a duplicate,
// reserved or malformed name). Distinct from DeclarationError: the
// document is not at fault.
type HostRegistryError struct {
	Detail string
}

func (e *HostRegistryError) Error() string { return "host registry: " + e.Detail }

// ErrEmitterSealed is returned (or carried by a panic, for setters
// whose signature has no error) when a declaration-built emitter is
// reconfigured (section 7.7.7).
var ErrEmitterSealed = errors.New("this emitter was built from a host declaration and is sealed (see spec 7.7.7)")

// DeclarationVersions reports the contract versions compiled into the
// Rust core: the current one and the accepted set (section 7.7.2).
func DeclarationVersions() (current string, supported []string, err error) {
	out, err := nativeDeclarationVersions()
	if err != nil {
		return "", nil, err
	}
	var v struct {
		Current   string   `json:"current"`
		Supported []string `json:"supported"`
	}
	if err := json.Unmarshal([]byte(out), &v); err != nil {
		return "", nil, err
	}
	return v.Current, v.Supported, nil
}

// ---- surface (section 7.7.4, 13.1) -----------------------------------------

// ToolSeamPosture is what the host does with the run after a
// host_error:* deny at the tool seam (section 6.2, 13.1).
type ToolSeamPosture string

const (
	PostureContinue  ToolSeamPosture = "continue"
	PostureTerminate ToolSeamPosture = "terminate"
)

// KnobSupport is the knob values a host supports for one profile
// (section 13.1 "profiles and knob values supported"). Only the knobs
// the profile consults are present; an empty set for a consulted knob
// is never valid.
type KnobSupport struct {
	OnApproval          []string `json:"on_approval,omitempty"`
	OnDisagreement      []string `json:"on_disagreement,omitempty"`
	OnTransformConflict []string `json:"on_transform_conflict,omitempty"`
}

// FullKnobSupport is every value of every knob the profile consults.
func FullKnobSupport(profile CompositionProfile) KnobSupport {
	switch profile {
	case SequentialFirstDeny:
		return KnobSupport{OnApproval: []string{"resume", "stop"}}
	case ParallelStrictest:
		return KnobSupport{OnTransformConflict: []string{"approval", "deny"}}
	case ParallelUnanimous:
		return KnobSupport{OnDisagreement: []string{"approval", "deny"}}
	default:
		return KnobSupport{}
	}
}

// allProfiles is the closed section 7.2 set.
var allProfiles = []CompositionProfile{
	SequentialFirstDeny, SequentialRunAll, ParallelStrictest, ParallelUnanimous,
}

// floorPoints is the section 3.2 lifecycle floor.
var floorPoints = []InterceptionPoint{AgentStartup, Input, Output, AgentShutdown}

// allPoints is every interception point in lifecycle order.
var allPoints = []InterceptionPoint{
	AgentStartup, Input, PreModelCall, PostModelCall,
	PreToolCall, PostToolCall, Output, AgentShutdown,
}

// HostSurface is what the host's code can honour (section 7.7.4,
// 13.1): the one value the loader checks a document against and the
// CTK derives the harness surface from. A document may select a subset
// of this, never more. The Go SDK bounds interceptor and resolver
// execution in its own runtime, so every surface it sends to the core
// states bounded timeout support.
type HostSurface struct {
	// InterceptionPoints the host emits. Always includes the floor.
	InterceptionPoints []InterceptionPoint `json:"interception_points"`
	// Capabilities from the closed vocabulary (section 7.7.4).
	Capabilities []string `json:"capabilities"`
	// Profiles and the knob values supported under each.
	Profiles map[CompositionProfile]KnobSupport `json:"profiles"`
	// ToolSeamHostError is the posture the code implements.
	ToolSeamHostError ToolSeamPosture `json:"tool_seam_host_error"`
	// StreamsUnbuffered: the host may declare buffered_output: false.
	StreamsUnbuffered bool `json:"streams_unbuffered"`
	// ExposureBound is the section 12.1a bound an incremental host
	// enforces; required when Capabilities names incremental_output.
	ExposureBound string `json:"exposure_bound,omitempty"`
	// DeclarationVersions the host accepts; a subset of
	// SupportedDeclarationVersions.
	DeclarationVersions []string `json:"declaration_versions"`
}

// DefaultHostSurface is the smallest honest surface for this module:
// the lifecycle floor, host_declaration, every profile with every knob
// value, posture continue, buffered output and every accepted contract
// version. A host adds what its runtime does.
func DefaultHostSurface() HostSurface {
	profiles := make(map[CompositionProfile]KnobSupport, len(allProfiles))
	for _, p := range allProfiles {
		profiles[p] = FullKnobSupport(p)
	}
	return HostSurface{
		InterceptionPoints:  append([]InterceptionPoint(nil), floorPoints...),
		Capabilities:        []string{"host_declaration"},
		Profiles:            profiles,
		ToolSeamHostError:   PostureContinue,
		DeclarationVersions: append([]string(nil), SupportedDeclarationVersions...),
	}
}

// HostSurfaceFromCapabilities derives the surface the CTK uses for a
// harness that declares a capability list and a posture (section
// 7.7.9): the floor plus the model points iff model_calls plus the tool
// points iff tool_calls, every profile with every knob value. A list
// naming incremental_output yields a surface without its exposure
// bound, which the core refuses; such a host adds the bound with
// WithExposureBound.
func HostSurfaceFromCapabilities(caps []string, posture ToolSeamPosture) HostSurface {
	s := DefaultHostSurface()
	s.ToolSeamHostError = posture
	s.Capabilities = nil
	for _, c := range caps {
		switch c {
		case "model_calls":
			s = s.WithPoints(PreModelCall, PostModelCall)
		case "tool_calls":
			s = s.WithPoints(PreToolCall, PostToolCall)
		case "incremental_output":
			s.StreamsUnbuffered = true
		}
		s.Capabilities = append(s.Capabilities, c)
	}
	return s
}

// WithPoints adds interception points (the model points, the tool
// points, or both).
func (s HostSurface) WithPoints(points ...InterceptionPoint) HostSurface {
	for _, p := range points {
		if !containsPoint(s.InterceptionPoints, p) {
			s.InterceptionPoints = append(s.InterceptionPoints, p)
		}
	}
	return s
}

// WithCapabilities adds capabilities.
func (s HostSurface) WithCapabilities(caps ...string) HostSurface {
	for _, c := range caps {
		if !containsString(s.Capabilities, c) {
			s.Capabilities = append(s.Capabilities, c)
		}
	}
	return s
}

// WithExposureBound states the section 12.1a exposure bound an
// incremental host enforces. It also marks the host as able to declare
// buffered_output: false.
func (s HostSurface) WithExposureBound(bound string) HostSurface {
	s.ExposureBound = bound
	s.StreamsUnbuffered = true
	return s
}

// hostDescription is the FFI host_json shape: the surface plus the
// four registry name sets (section 7.7.5). The core's object is closed;
// interceptor_timeout is this runtime's own fact.
func (s HostSurface) hostDescription(names RegistryNames) map[string]any {
	surface := map[string]any{
		"interception_points":  pointNames(s.InterceptionPoints),
		"capabilities":         sortedStrings(s.Capabilities),
		"profiles":             s.Profiles,
		"tool_seam_host_error": s.ToolSeamHostError,
		"streams_unbuffered":   s.StreamsUnbuffered,
		"interceptor_timeout":  "bounded",
		"declaration_versions": sortedStrings(s.DeclarationVersions),
	}
	if s.ExposureBound != "" {
		surface["exposure_bound"] = s.ExposureBound
	}
	if s.Profiles == nil {
		surface["profiles"] = map[CompositionProfile]KnobSupport{}
	}
	return map[string]any{
		"surface":            surface,
		"identity_providers": names.IdentityProviders,
		"approval_resolvers": names.ApprovalResolvers,
		"approval_redactors": names.ApprovalRedactors,
		"kinds":              names.Kinds,
	}
}

func pointNames(points []InterceptionPoint) []string {
	out := make([]string, 0, len(points))
	for _, p := range points {
		out = append(out, string(p))
	}
	return out
}

func sortedStrings(in []string) []string {
	out := append([]string(nil), in...)
	sort.Strings(out)
	if out == nil {
		out = []string{}
	}
	return out
}

func containsPoint(points []InterceptionPoint, p InterceptionPoint) bool {
	for _, q := range points {
		if q == p {
			return true
		}
	}
	return false
}

func containsString(list []string, s string) bool {
	for _, q := range list {
		if q == s {
			return true
		}
	}
	return false
}

// ---- registry (section 7.7.5) ----------------------------------------------

// RegistryNames is what a registry holds, derived from registration and
// never hand-written (section 7.7.5). Steps 9 and 10 check against it.
type RegistryNames struct {
	IdentityProviders []string `json:"identity_providers"`
	ApprovalResolvers []string `json:"approval_resolvers"`
	ApprovalRedactors []string `json:"approval_redactors"`
	Kinds             []string `json:"kinds"`
}

// HostInfo is the informative `host` block of a document.
type HostInfo struct {
	Name    string `json:"name"`
	Version string `json:"version,omitempty"`
}

// BindingContext is what a kind resolver learns about the binding it
// builds (section 7.7.5).
type BindingContext struct {
	ID   string
	Kind string
	// At is the resolved set of points the interceptor runs at, in
	// lifecycle order.
	At []InterceptionPoint
	// Timeout is the resolved per-binding bound; 0 is unbounded.
	Timeout time.Duration
	// Host is the document's informative host block, or nil.
	Host *HostInfo
	// DeclarationVersion is the contract version the document carries.
	DeclarationVersion string
}

// KindResolver is host code that turns one binding's config into one
// interceptor, or refuses it with an error. The error message MUST NOT
// echo the config (section 7.7.5). A nil interceptor is a refusal.
type KindResolver func(config json.RawMessage, ctx BindingContext) (Interceptor, error)

// HostRegistry is everything a host registers in code for a
// declaration to reference (section 7.7.5): the code surface, kind
// resolvers, custom identity providers, approval resolvers and
// approval redactors. Build it before loading; it is not synchronized.
type HostRegistry struct {
	surface           HostSurface
	allowReserved     bool
	kinds             map[string]KindResolver
	identityProviders map[string]func(AgentContext) (string, error)
	approvalResolvers map[string]ApprovalResolver
	approvalRedactors map[string]func(AgentContext) AgentContext
}

// NewHostRegistry returns a registry over the given code surface. Kinds
// under the reserved agent_hooks and ctk segments are refused.
func NewHostRegistry(surface HostSurface) *HostRegistry {
	return &HostRegistry{
		surface:           surface,
		kinds:             map[string]KindResolver{},
		identityProviders: map[string]func(AgentContext) (string, error){},
		approvalResolvers: map[string]ApprovalResolver{},
		approvalRedactors: map[string]func(AgentContext) AgentContext{},
	}
}

// NewConformanceHostRegistry is the conformance kit's registry: as
// NewHostRegistry, but the ctk kind segment may be registered.
func NewConformanceHostRegistry(surface HostSurface) *HostRegistry {
	r := NewHostRegistry(surface)
	r.allowReserved = true
	return r
}

// Surface returns the code surface the registry was built over.
func (r *HostRegistry) Surface() HostSurface { return r.surface }

var (
	// referenceRe is the grammar for binding ids and registered names.
	referenceRe = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)
	// kindSegmentRe is one dot-separated segment of a binding kind.
	kindSegmentRe = regexp.MustCompile(`^[a-z][a-z0-9_-]*$`)
)

const maxKindLen = 128

var reservedKindSegments = []string{"agent_hooks", "ctk"}

// validKind reports whether s matches the section 7.7.5 kind grammar:
// dot-separated lowercase segments, at least two, at most 128 bytes.
func validKind(s string) bool {
	if len(s) > maxKindLen {
		return false
	}
	segs := strings.Split(s, ".")
	if len(segs) < 2 {
		return false
	}
	for _, seg := range segs {
		if !kindSegmentRe.MatchString(seg) {
			return false
		}
	}
	return true
}

// Kind registers a kind resolver.
func (r *HostRegistry) Kind(kind string, f KindResolver) error {
	if !validKind(kind) {
		return &HostRegistryError{Detail: fmt.Sprintf("kind %q does not match the kind grammar (see spec 7.7.5)", kind)}
	}
	head := strings.SplitN(kind, ".", 2)[0]
	if containsString(reservedKindSegments, head) && !(r.allowReserved && head == "ctk") {
		return &HostRegistryError{Detail: fmt.Sprintf("kind %q uses the reserved segment %q (see spec 7.7.5)", kind, head)}
	}
	if _, dup := r.kinds[kind]; dup {
		return &HostRegistryError{Detail: fmt.Sprintf("kind %q registered twice", kind)}
	}
	if f == nil {
		return &HostRegistryError{Detail: fmt.Sprintf("kind %q has no resolver", kind)}
	}
	r.kinds[kind] = f
	return nil
}

// IdentityProvider registers a custom identity provider under a name
// (section 10.1 name rules: ^[a-z][a-z0-9_-]*$, not starting with jcs,
// at most 64 bytes).
func (r *HostRegistry) IdentityProvider(name string, compute func(AgentContext) (string, error)) error {
	if !providerNameRe.MatchString(name) || strings.HasPrefix(name, "jcs") {
		return &HostRegistryError{Detail: "identity provider name must match ^[a-z][a-z0-9_-]*$ and must not begin with 'jcs' (see spec 10.1)"}
	}
	if len(name) > 64 {
		return &HostRegistryError{Detail: fmt.Sprintf("identity provider name %q exceeds 64 characters", name)}
	}
	if _, dup := r.identityProviders[name]; dup {
		return &HostRegistryError{Detail: fmt.Sprintf("identity provider %q registered twice", name)}
	}
	if compute == nil {
		return &HostRegistryError{Detail: fmt.Sprintf("identity provider %q has no Compute function (see spec 10.1)", name)}
	}
	r.identityProviders[name] = compute
	return nil
}

// ApprovalResolver registers an approval resolver under a reference name.
func (r *HostRegistry) ApprovalResolver(name string, resolver ApprovalResolver) error {
	if err := checkReference(name, "approval resolver"); err != nil {
		return err
	}
	if _, dup := r.approvalResolvers[name]; dup {
		return &HostRegistryError{Detail: fmt.Sprintf("approval resolver %q registered twice", name)}
	}
	if resolver == nil {
		return &HostRegistryError{Detail: fmt.Sprintf("approval resolver %q is nil", name)}
	}
	r.approvalResolvers[name] = resolver
	return nil
}

// ApprovalRedactor registers an approval redactor under a reference name.
func (r *HostRegistry) ApprovalRedactor(name string, f func(AgentContext) AgentContext) error {
	if err := checkReference(name, "approval redactor"); err != nil {
		return err
	}
	if _, dup := r.approvalRedactors[name]; dup {
		return &HostRegistryError{Detail: fmt.Sprintf("approval redactor %q registered twice", name)}
	}
	if f == nil {
		return &HostRegistryError{Detail: fmt.Sprintf("approval redactor %q is nil", name)}
	}
	r.approvalRedactors[name] = f
	return nil
}

func checkReference(name, what string) error {
	if referenceRe.MatchString(name) {
		return nil
	}
	return &HostRegistryError{Detail: fmt.Sprintf("%s name %q does not match ^[a-z][a-z0-9_-]{0,63}$", what, name)}
}

// Names returns the registered names, derived (section 7.7.5).
func (r *HostRegistry) Names() RegistryNames {
	return RegistryNames{
		IdentityProviders: sortedKeys(r.identityProviders),
		ApprovalResolvers: sortedKeys(r.approvalResolvers),
		ApprovalRedactors: sortedKeys(r.approvalRedactors),
		Kinds:             sortedKeys(r.kinds),
	}
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Resolve runs steps 2 to 10 of section 7.7.6 against this registry
// and returns the resolved declaration without building an emitter or
// running any kind resolver. Its canonical JSON is the equivalence
// oracle of section 7.7.7. A refusal is a *DeclarationError; a host
// surface the core cannot read is a *CoreError with code marshal_error.
func (r *HostRegistry) Resolve(decl HostDeclaration) (*ResolvedDeclaration, error) {
	return resolveDeclaration(decl, r.surface.hostDescription(r.Names()))
}

// ResolveDeclarationSurface runs steps 2 to 8 of section 7.7.6 against
// a code surface without a registry: the names the document itself
// cites are taken as registered, so only the surface is checked. The
// CTK uses it on a harness's own document to learn the surface a run
// is assessed against (section 7.7.9).
func ResolveDeclarationSurface(decl HostDeclaration, surface HostSurface) (*ResolvedDeclaration, error) {
	return resolveDeclaration(decl, surface.hostDescription(citedNames(decl)))
}

// citedNames collects the kinds and reference names a document names,
// so a surface-only resolution passes steps 9 and 10 trivially. A
// document the core refuses earlier never reaches those steps.
func citedNames(decl HostDeclaration) RegistryNames {
	var doc struct {
		Configuration struct {
			IdentityProvider any `json:"identity_provider"`
			Approval         struct {
				Resolver any `json:"resolver"`
				Redactor any `json:"redactor"`
			} `json:"approval"`
		} `json:"configuration"`
		Bindings []struct {
			Kind any `json:"kind"`
		} `json:"bindings"`
	}
	names := RegistryNames{
		IdentityProviders: []string{}, ApprovalResolvers: []string{},
		ApprovalRedactors: []string{}, Kinds: []string{},
	}
	if err := json.Unmarshal([]byte(decl.text), &doc); err != nil {
		return names
	}
	if s, ok := doc.Configuration.IdentityProvider.(string); ok && s != JCSSHA256 {
		names.IdentityProviders = append(names.IdentityProviders, s)
	}
	if s, ok := doc.Configuration.Approval.Resolver.(string); ok {
		names.ApprovalResolvers = append(names.ApprovalResolvers, s)
	}
	if s, ok := doc.Configuration.Approval.Redactor.(string); ok {
		names.ApprovalRedactors = append(names.ApprovalRedactors, s)
	}
	for _, b := range doc.Bindings {
		if s, ok := b.Kind.(string); ok && !containsString(names.Kinds, s) {
			names.Kinds = append(names.Kinds, s)
		}
	}
	return names
}

func resolveDeclaration(decl HostDeclaration, host map[string]any) (*ResolvedDeclaration, error) {
	if decl.text == "" {
		return nil, newDeclarationError(DeclarationMalformed, "", "not a valid JSON document: the document is empty")
	}
	hostJSON, err := json.Marshal(host)
	if err != nil {
		return nil, err
	}
	out, err := nativeDeclarationResolve(decl.text, string(hostJSON))
	if err != nil {
		return nil, declarationErrorFrom(err)
	}
	var resolved ResolvedDeclaration
	if err := json.Unmarshal([]byte(out), &resolved); err != nil {
		return nil, fmt.Errorf("resolved declaration does not parse: %w", err)
	}
	resolved.raw = out
	return &resolved, nil
}

// ---- document (steps 1 and 2 on this side) ---------------------------------

// HostDeclaration is a host declaration document as text, ready for
// the loader. LoadDeclarationPath runs step 1 of section 7.7.6 (read a
// regular file of at most MaxDeclarationBytes, strict UTF-8, no
// byte-order mark); ParseDeclaration and DeclarationFromValue hold
// text. Steps 2 to 10 run in the Rust core when the document is
// resolved (HostRegistry.Resolve) or an emitter is built from it, so
// every construction path is validated by one function with one set
// of refusal classes.
type HostDeclaration struct {
	text string
}

// JSON returns the document text as the loader will hand it to the core.
func (d HostDeclaration) JSON() string { return d.text }

// LoadDeclarationPath reads a declaration from exactly path (step 1):
// a regular file (a symlink to one is fine) of at most
// MaxDeclarationBytes, strict UTF-8 without a byte-order mark, read
// once. Every failure is declaration_error:unreadable; the detail
// carries the error class, never file contents.
func LoadDeclarationPath(path string) (HostDeclaration, error) {
	unreadable := func(detail string) (HostDeclaration, error) {
		return HostDeclaration{}, newDeclarationError(DeclarationUnreadable, "", detail)
	}
	info, err := os.Stat(path)
	if err != nil {
		return unreadable("cannot stat: " + ioClass(err))
	}
	if !info.Mode().IsRegular() {
		return unreadable("not a regular file")
	}
	if info.Size() > MaxDeclarationBytes {
		return unreadable(fmt.Sprintf("document is %d bytes; the bound is %d", info.Size(), MaxDeclarationBytes))
	}
	f, err := os.Open(path)
	if err != nil {
		return unreadable("cannot read: " + ioClass(err))
	}
	defer f.Close()
	// A file that grows between the stat and the read is still loaded
	// only up to the bound plus one byte, then refused.
	data, err := io.ReadAll(io.LimitReader(f, MaxDeclarationBytes+1))
	if err != nil {
		return unreadable("cannot read: " + ioClass(err))
	}
	if len(data) > MaxDeclarationBytes {
		return unreadable(fmt.Sprintf("document is %d bytes; the bound is %d", len(data), MaxDeclarationBytes))
	}
	if bytes.HasPrefix(data, []byte{0xEF, 0xBB, 0xBF}) {
		return unreadable("document starts with a byte-order mark")
	}
	if !utf8.Valid(data) {
		return unreadable("document is not valid UTF-8")
	}
	return textDeclaration(data)
}

// ioClass names the operating-system error class the way the core's
// io::ErrorKind does, so a log line never carries file contents.
func ioClass(err error) string {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return "NotFound"
	case errors.Is(err, fs.ErrPermission):
		return "PermissionDenied"
	case errors.Is(err, fs.ErrInvalid):
		return "InvalidInput"
	default:
		return "Other"
	}
}

// ParseDeclaration holds JSON text for the loader. The bytes must be
// UTF-8; anything the core cannot parse is refused as
// declaration_error:malformed when the document is resolved.
func ParseDeclaration(text []byte) (HostDeclaration, error) {
	if !utf8.Valid(text) {
		return HostDeclaration{}, newDeclarationError(DeclarationMalformed, "", "document is not valid UTF-8")
	}
	return textDeclaration(text)
}

// textDeclaration is the shared tail of the text paths. A NUL byte
// cannot cross the C string boundary; JSON text never carries one
// outside a string, and a raw control character inside one is not JSON
// either, so the core would refuse it as malformed too.
func textDeclaration(text []byte) (HostDeclaration, error) {
	if bytes.IndexByte(text, 0) >= 0 {
		return HostDeclaration{}, newDeclarationError(DeclarationMalformed, "", "not a valid JSON document: control character (NUL) in the text")
	}
	return HostDeclaration{text: string(text)}, nil
}

// DeclarationFromValue serializes a value built in code (a
// map[string]any, or anything encoding/json can write) and hands it to
// the text path, so size, depth and shape checks are the same code on
// every path. A value encoding/json cannot write (NaN, Inf, a channel)
// is declaration_error:malformed.
func DeclarationFromValue(value any) (HostDeclaration, error) {
	b, err := json.Marshal(value)
	if err != nil {
		return HostDeclaration{}, newDeclarationError(DeclarationMalformed, "", "cannot serialize: "+err.Error())
	}
	return HostDeclaration{text: string(b)}, nil
}

// ---- resolved form (section 7.7.3) -----------------------------------------

// ResolvedDeclaration is the resolved form of section 7.7.3: every
// default filled, composition knobs resolved as the record stamps
// them, surface filled from the host when the document stated none,
// each binding's at and timeout filled, $schema dropped, sets sorted.
type ResolvedDeclaration struct {
	Declaration   string                     `json:"declaration"`
	Spec          string                     `json:"spec"`
	ID            string                     `json:"id,omitempty"`
	Host          *HostInfo                  `json:"host,omitempty"`
	Configuration ResolvedConfiguration      `json:"configuration"`
	Surface       ResolvedSurface            `json:"surface"`
	Bindings      []ResolvedBinding          `json:"bindings"`
	Extensions    map[string]json.RawMessage `json:"extensions"`

	raw string
}

// ResolvedConfiguration is the configuration block with every default
// filled.
type ResolvedConfiguration struct {
	Mode        EnforcementMode   `json:"mode"`
	Composition CompositionConfig `json:"composition"`
	// IdentityProvider is nil for the null (identity-unbound) provider.
	IdentityProvider *string          `json:"identity_provider"`
	Approval         ResolvedApproval `json:"approval"`
	Posture          ResolvedPosture  `json:"posture"`
	Timeouts         ResolvedTimeouts `json:"timeouts"`
	Records          ResolvedRecords  `json:"records"`
}

// ResolvedApproval names the registered resolver and redactor; nil is none.
type ResolvedApproval struct {
	Resolver *string `json:"resolver"`
	Redactor *string `json:"redactor"`
}

// ResolvedPosture is the configured section 13.1 posture.
type ResolvedPosture struct {
	ToolSeamHostError ToolSeamPosture `json:"tool_seam_host_error"`
}

// ResolvedTimeouts are the bounds in milliseconds; nil is unbounded.
type ResolvedTimeouts struct {
	InterceptorMs      *uint64 `json:"interceptor_ms"`
	ApprovalResolverMs *uint64 `json:"approval_resolver_ms"`
}

// ResolvedRecords is the in-memory record buffer bound; nil is unbounded.
type ResolvedRecords struct {
	MaxBuffered *uint64 `json:"max_buffered"`
}

// ResolvedSurface is the document's surface, or the host's when the
// document stated none (section 7.7.4).
type ResolvedSurface struct {
	InterceptionPoints  []InterceptionPoint                `json:"interception_points"`
	Capabilities        []string                           `json:"capabilities"`
	Profiles            map[CompositionProfile]KnobSupport `json:"profiles"`
	BufferedOutput      bool                               `json:"buffered_output"`
	ExposureBound       string                             `json:"exposure_bound,omitempty"`
	DeclarationVersions []string                           `json:"declaration_versions"`
}

// ResolvedBinding is one binding with at and timeout_ms filled.
type ResolvedBinding struct {
	ID     string              `json:"id"`
	Kind   string              `json:"kind"`
	Config json.RawMessage     `json:"config"`
	At     []InterceptionPoint `json:"at"`
	// TimeoutMs is nil for timeout_ms: null (unbounded).
	TimeoutMs *uint64 `json:"timeout_ms"`
}

// CanonicalJSON returns the RFC 8785 canonical JSON of the resolved
// form, computed by the Rust core: the equivalence oracle of section
// 7.7.7.
func (r *ResolvedDeclaration) CanonicalJSON() (string, error) {
	return nativeCanonicalJSON(r.raw)
}

// Version returns the contract version the document carried.
func (r *ResolvedDeclaration) Version() string { return r.Declaration }

// ---- builder (the code path, section 7.7.7) --------------------------------

// DeclarationBuilder builds a declaration document in code, one setter
// per member and one Bind call per binding. Build hands the document to
// DeclarationFromValue, so the code path is validated by the same
// function, with the same classes, as a file. Zero values write JSON
// null where the member allows it: an empty name for IdentityProvider,
// ApprovalResolver and ApprovalRedactor, 0 for the timeouts and the
// record bound.
type DeclarationBuilder struct {
	doc map[string]any
}

// NewDeclarationBuilder returns a builder with `declaration` set to
// DeclarationVersion and `bindings` empty.
func NewDeclarationBuilder() *DeclarationBuilder {
	return &DeclarationBuilder{doc: map[string]any{
		"declaration": DeclarationVersion,
		"bindings":    []any{},
	}}
}

// NewEmptyDeclarationBuilder returns a builder with no member set at
// all, not even `declaration` or `bindings`. For harnesses that must
// express an incomplete document; a host wants NewDeclarationBuilder.
func NewEmptyDeclarationBuilder() *DeclarationBuilder {
	return &DeclarationBuilder{doc: map[string]any{}}
}

func (b *DeclarationBuilder) object(key string) map[string]any {
	if m, ok := b.doc[key].(map[string]any); ok {
		return m
	}
	m := map[string]any{}
	b.doc[key] = m
	return m
}

func (b *DeclarationBuilder) configuration() map[string]any { return b.object("configuration") }

func (b *DeclarationBuilder) configurationSub(key string) map[string]any {
	cfg := b.configuration()
	if m, ok := cfg[key].(map[string]any); ok {
		return m
	}
	m := map[string]any{}
	cfg[key] = m
	return m
}

func (b *DeclarationBuilder) surface() map[string]any { return b.object("surface") }

// Version sets `declaration`.
func (b *DeclarationBuilder) Version(v string) *DeclarationBuilder {
	b.doc["declaration"] = v
	return b
}

// Spec sets `spec`.
func (b *DeclarationBuilder) Spec(v string) *DeclarationBuilder {
	b.doc["spec"] = v
	return b
}

// ID sets the operator label `id`.
func (b *DeclarationBuilder) ID(v string) *DeclarationBuilder {
	b.doc["id"] = v
	return b
}

// Host sets the informative `host` block; an empty version is omitted.
func (b *DeclarationBuilder) Host(name, version string) *DeclarationBuilder {
	h := map[string]any{"name": name}
	if version != "" {
		h["version"] = version
	}
	b.doc["host"] = h
	return b
}

// Mode sets configuration.mode.
func (b *DeclarationBuilder) Mode(mode EnforcementMode) *DeclarationBuilder {
	b.configuration()["mode"] = string(mode)
	return b
}

// Composition sets configuration.composition: the profile and only the
// knobs that are set, as the record's composition block is written.
func (b *DeclarationBuilder) Composition(c CompositionConfig) *DeclarationBuilder {
	comp := map[string]any{}
	if c.Profile != "" {
		comp["profile"] = string(c.Profile)
	}
	if c.OnApproval != "" {
		comp["on_approval"] = string(c.OnApproval)
	}
	if c.OnDisagreement != "" {
		comp["on_disagreement"] = string(c.OnDisagreement)
	}
	if c.OnTransformConflict != "" {
		comp["on_transform_conflict"] = string(c.OnTransformConflict)
	}
	b.configuration()["composition"] = comp
	return b
}

// IdentityProvider sets configuration.identity_provider; an empty
// name writes null (identity-unbound).
func (b *DeclarationBuilder) IdentityProvider(name string) *DeclarationBuilder {
	b.configuration()["identity_provider"] = nullableString(name)
	return b
}

// ApprovalResolver sets configuration.approval.resolver; an empty name
// writes null.
func (b *DeclarationBuilder) ApprovalResolver(name string) *DeclarationBuilder {
	b.configurationSub("approval")["resolver"] = nullableString(name)
	return b
}

// ApprovalRedactor sets configuration.approval.redactor; an empty name
// writes null.
func (b *DeclarationBuilder) ApprovalRedactor(name string) *DeclarationBuilder {
	b.configurationSub("approval")["redactor"] = nullableString(name)
	return b
}

// ToolSeamHostError sets configuration.posture.tool_seam_host_error.
func (b *DeclarationBuilder) ToolSeamHostError(posture ToolSeamPosture) *DeclarationBuilder {
	b.configurationSub("posture")["tool_seam_host_error"] = string(posture)
	return b
}

// InterceptorTimeoutMs sets configuration.timeouts.interceptor_ms; 0
// writes null (unbounded).
func (b *DeclarationBuilder) InterceptorTimeoutMs(ms uint64) *DeclarationBuilder {
	b.configurationSub("timeouts")["interceptor_ms"] = nullableUint(ms)
	return b
}

// ApprovalResolverTimeoutMs sets
// configuration.timeouts.approval_resolver_ms; 0 writes null.
func (b *DeclarationBuilder) ApprovalResolverTimeoutMs(ms uint64) *DeclarationBuilder {
	b.configurationSub("timeouts")["approval_resolver_ms"] = nullableUint(ms)
	return b
}

// MaxBufferedRecords sets configuration.records.max_buffered; 0 writes
// null (unbounded).
func (b *DeclarationBuilder) MaxBufferedRecords(n uint64) *DeclarationBuilder {
	b.configurationSub("records")["max_buffered"] = nullableUint(n)
	return b
}

// SurfacePoints sets surface.interception_points.
func (b *DeclarationBuilder) SurfacePoints(points ...InterceptionPoint) *DeclarationBuilder {
	b.surface()["interception_points"] = pointNames(points)
	return b
}

// SurfaceCapabilities sets surface.capabilities.
func (b *DeclarationBuilder) SurfaceCapabilities(caps ...string) *DeclarationBuilder {
	b.surface()["capabilities"] = append([]string{}, caps...)
	return b
}

// SurfaceProfile sets one entry of surface.profiles.
func (b *DeclarationBuilder) SurfaceProfile(profile CompositionProfile, knobs KnobSupport) *DeclarationBuilder {
	sf := b.surface()
	profiles, ok := sf["profiles"].(map[string]any)
	if !ok {
		profiles = map[string]any{}
		sf["profiles"] = profiles
	}
	profiles[string(profile)] = knobs
	return b
}

// BufferedOutput sets surface.buffered_output and, when false, the
// exposure bound that must accompany it.
func (b *DeclarationBuilder) BufferedOutput(buffered bool, exposureBound string) *DeclarationBuilder {
	sf := b.surface()
	sf["buffered_output"] = buffered
	if exposureBound != "" {
		sf["exposure_bound"] = exposureBound
	} else {
		delete(sf, "exposure_bound")
	}
	return b
}

// SurfaceDeclarationVersions sets surface.declaration_versions.
func (b *DeclarationBuilder) SurfaceDeclarationVersions(versions ...string) *DeclarationBuilder {
	b.surface()["declaration_versions"] = append([]string{}, versions...)
	return b
}

// BindOption refines one Bind call.
type BindOption func(binding map[string]any)

// BindAt restricts the binding to the given points (`at`).
func BindAt(points ...InterceptionPoint) BindOption {
	return func(binding map[string]any) {
		binding["at"] = pointNames(points)
	}
}

// BindTimeoutMs sets the binding's `timeout_ms`; 0 writes null
// (unbounded).
func BindTimeoutMs(ms uint64) BindOption {
	return func(binding map[string]any) {
		binding["timeout_ms"] = nullableUint(ms)
	}
}

// Bind appends one binding envelope. A nil config is omitted (the
// default is an empty object).
func (b *DeclarationBuilder) Bind(id, kind string, config any, opts ...BindOption) *DeclarationBuilder {
	binding := map[string]any{"id": id, "kind": kind}
	if config != nil {
		binding["config"] = config
	}
	for _, o := range opts {
		o(binding)
	}
	list, _ := b.doc["bindings"].([]any)
	b.doc["bindings"] = append(list, binding)
	return b
}

// Extension sets one `extensions` entry, kept verbatim.
func (b *DeclarationBuilder) Extension(key string, value any) *DeclarationBuilder {
	b.object("extensions")[key] = value
	return b
}

// Raw sets a top-level member verbatim, for members this builder has
// no setter for. The result is validated like any other document (an
// unknown member is refused as unknown_field).
func (b *DeclarationBuilder) Raw(key string, value any) *DeclarationBuilder {
	b.doc[key] = value
	return b
}

// Value returns the document as built, before validation.
func (b *DeclarationBuilder) Value() map[string]any {
	return cloneJSON(b.doc)
}

// Build hands the document to DeclarationFromValue.
func (b *DeclarationBuilder) Build() (HostDeclaration, error) {
	return DeclarationFromValue(b.doc)
}

func nullableString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullableUint(n uint64) any {
	if n == 0 {
		return nil
	}
	return n
}

// cloneJSON deep-copies a JSON-shaped value through encoding/json.
func cloneJSON(v map[string]any) map[string]any {
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		return nil
	}
	return out
}

// ---- emitter construction (steps 11 and 12) --------------------------------

// NewInterceptionEmitterFromDeclaration builds an emitter from a
// declaration and the host's registry: steps 2 to 10 of section 7.7.6
// in the core, then every binding's kind resolver in array order (step
// 11). The emitter is sealed (section 7.7.7) and stamps `declaration`
// on every record (section 7.7.8). A refusal is a *DeclarationError
// and leaves no emitter.
func NewInterceptionEmitterFromDeclaration(decl HostDeclaration, reg *HostRegistry) (*InterceptionEmitter, error) {
	if reg == nil {
		return nil, &HostRegistryError{Detail: "nil registry"}
	}
	resolved, err := reg.Resolve(decl)
	if err != nil {
		return nil, err
	}
	return emitterFromResolved(resolved, reg)
}

// NewInterceptionEmitterFromDeclarationPath is LoadDeclarationPath then
// NewInterceptionEmitterFromDeclaration.
func NewInterceptionEmitterFromDeclarationPath(path string, reg *HostRegistry) (*InterceptionEmitter, error) {
	decl, err := LoadDeclarationPath(path)
	if err != nil {
		return nil, err
	}
	return NewInterceptionEmitterFromDeclaration(decl, reg)
}

// NewInterceptionEmitterFromDeclarationJSON is ParseDeclaration then
// NewInterceptionEmitterFromDeclaration.
func NewInterceptionEmitterFromDeclarationJSON(text []byte, reg *HostRegistry) (*InterceptionEmitter, error) {
	decl, err := ParseDeclaration(text)
	if err != nil {
		return nil, err
	}
	return NewInterceptionEmitterFromDeclaration(decl, reg)
}

// NewInterceptionEmitterFromDeclarationValue is DeclarationFromValue
// then NewInterceptionEmitterFromDeclaration.
func NewInterceptionEmitterFromDeclarationValue(value any, reg *HostRegistry) (*InterceptionEmitter, error) {
	decl, err := DeclarationFromValue(value)
	if err != nil {
		return nil, err
	}
	return NewInterceptionEmitterFromDeclaration(decl, reg)
}

// emitterFromResolved is step 11 and construction. Every reference is
// looked up again in the registry's own maps, so bookkeeping drift
// between the names the core checked and what the registry holds
// fails closed.
func emitterFromResolved(resolved *ResolvedDeclaration, reg *HostRegistry) (*InterceptionEmitter, error) {
	cfg := resolved.Configuration

	var resolver ApprovalResolver
	if name := cfg.Approval.Resolver; name != nil {
		r, ok := reg.approvalResolvers[*name]
		if !ok {
			return nil, newDeclarationError(DeclarationReferenceUnresolved,
				"/configuration/approval/resolver",
				fmt.Sprintf("approval resolver %q vanished from the registry", *name))
		}
		resolver = r
	}

	var identity *IdentityProvider
	switch {
	case cfg.IdentityProvider == nil:
		identity = nil
	case *cfg.IdentityProvider == JCSSHA256:
		identity = DefaultIdentityProvider()
	default:
		name := *cfg.IdentityProvider
		f, ok := reg.identityProviders[name]
		if !ok {
			return nil, newDeclarationError(DeclarationReferenceUnresolved,
				"/configuration/identity_provider",
				fmt.Sprintf("identity provider %q vanished from the registry", name))
		}
		identity = &IdentityProvider{Name: name, Compute: f}
	}

	var redactor func(AgentContext) AgentContext
	if name := cfg.Approval.Redactor; name != nil {
		f, ok := reg.approvalRedactors[*name]
		if !ok {
			return nil, newDeclarationError(DeclarationReferenceUnresolved,
				"/configuration/approval/redactor",
				fmt.Sprintf("approval redactor %q vanished from the registry", *name))
		}
		redactor = f
	}

	bounds := make([]*bound, 0, len(resolved.Bindings))
	for i, b := range resolved.Bindings {
		pointer := fmt.Sprintf("/bindings/%d", i)
		resolve, ok := reg.kinds[b.Kind]
		if !ok {
			return nil, newDeclarationError(DeclarationKindUnknown, pointer+"/kind",
				fmt.Sprintf("kind %q vanished from the registry", b.Kind))
		}
		var timeout time.Duration
		if b.TimeoutMs != nil {
			timeout = time.Duration(*b.TimeoutMs) * time.Millisecond
		}
		// The resolver gets copies of the host block and the config,
		// so it cannot rewrite what Declaration() reports as run.
		var host *HostInfo
		if resolved.Host != nil {
			h := *resolved.Host
			host = &h
		}
		bctx := BindingContext{
			ID:                 b.ID,
			Kind:               b.Kind,
			At:                 append([]InterceptionPoint(nil), b.At...),
			Timeout:            timeout,
			Host:               host,
			DeclarationVersion: resolved.Declaration,
		}
		config := json.RawMessage("{}")
		if b.Config != nil {
			config = append(json.RawMessage(nil), b.Config...)
		}
		// Section 7.7.5: a resolver error, panic or non-interceptor
		// return refuses the document; the message is bounded and the
		// loader never echoes the config.
		interceptor, rerr := runKindResolver(resolve, config, bctx)
		if rerr != nil {
			return nil, newDeclarationError(DeclarationBindingRejected, pointer,
				fmt.Sprintf("binding %q (kind %q) rejected: %s", b.ID, b.Kind, rerr.Error()))
		}
		bounds = append(bounds, &bound{
			interceptor: interceptor,
			name:        b.ID,
			at:          append([]InterceptionPoint(nil), b.At...),
			inherit:     false,
			timeout:     timeout,
		})
	}

	em := &InterceptionEmitter{
		bound:            bounds,
		resolver:         resolver,
		mode:             cfg.Mode,
		composition:      cfg.Composition,
		identity:         identity,
		approvalRedactor: redactor,
		sealed:           true,
		declaration:      resolved,
	}
	if cfg.Timeouts.InterceptorMs != nil {
		em.Timeout = time.Duration(*cfg.Timeouts.InterceptorMs) * time.Millisecond
	}
	em.resolverTimeout = new(time.Duration)
	if cfg.Timeouts.ApprovalResolverMs != nil {
		*em.resolverTimeout = time.Duration(*cfg.Timeouts.ApprovalResolverMs) * time.Millisecond
	}
	if cfg.Records.MaxBuffered != nil {
		// A stated bound must never become no bound: int(uint64) wraps
		// above math.MaxInt, and the emitter treats a value below 1 as
		// unbounded, so clamp instead.
		em.maxRecords = math.MaxInt
		if *cfg.Records.MaxBuffered < uint64(math.MaxInt) {
			em.maxRecords = int(*cfg.Records.MaxBuffered)
		}
	}
	return em, nil
}

// runKindResolver runs one resolver with panic recovery. Only the
// panic value's type is reported, never its message, which may embed
// the config.
func runKindResolver(f KindResolver, config json.RawMessage, bctx BindingContext) (out Interceptor, err error) {
	defer func() {
		if r := recover(); r != nil {
			out = nil
			err = fmt.Errorf("resolver panicked: %T", r)
		}
	}()
	out, err = f(config, bctx)
	if err != nil {
		return nil, err
	}
	if out == nil {
		return nil, errors.New("resolver returned no interceptor")
	}
	return out, nil
}
