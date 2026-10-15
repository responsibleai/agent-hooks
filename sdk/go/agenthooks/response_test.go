// Copyright (c) Microsoft. All rights reserved.

package agenthooks

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestSharedInterceptorResponseFixtures(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	bytes, err := os.ReadFile(filepath.Join(
		filepath.Dir(file),
		"..", "..", "..", "conformance", "golden", "interceptor-response.json",
	))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Valid          []map[string]string `json:"valid"`
		Invalid        []map[string]string `json:"invalid"`
		InvalidError   string              `json:"invalid_error"`
		MetadataBounds []struct {
			Name           string `json:"name"`
			Padding        int    `json:"padding"`
			SecondProvider bool   `json:"second_provider"`
			Bytes          int    `json:"bytes"`
			Valid          bool   `json:"valid"`
		} `json:"metadata_bounds"`
	}
	if err := json.Unmarshal(bytes, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, item := range fixture.Valid {
		t.Run(item["name"], func(t *testing.T) {
			response, err := ParseInterceptorResponseJSON([]byte(item["input"]))
			if err != nil {
				t.Fatal(err)
			}
			actual, _ := json.Marshal(map[string]any{
				"verdict":    response.Verdict,
				"extensions": response.Extensions,
			})
			var actualValue, expectedValue any
			_ = json.Unmarshal(actual, &actualValue)
			_ = json.Unmarshal([]byte(item["normalized"]), &expectedValue)
			actualMap := actualValue.(map[string]any)
			if response.Extensions == nil {
				delete(actualMap, "extensions")
			}
			if !reflect.DeepEqual(actualMap, expectedValue) {
				t.Fatalf("actual = %#v, expected = %#v", actualMap, expectedValue)
			}
			wire, err := json.Marshal(response.ToWire())
			if err != nil {
				t.Fatal(err)
			}
			reparsed, err := ParseInterceptorResponseJSON(wire)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(response, reparsed) {
				t.Fatalf("round-trip changed response: %#v -> %#v", response, reparsed)
			}
		})
	}

	for _, item := range fixture.Invalid {
		t.Run(item["name"], func(t *testing.T) {
			_, err := ParseInterceptorResponseJSON([]byte(item["input"]))
			var core *CoreError
			if !errors.As(err, &core) || core.Code != fixture.InvalidError {
				t.Fatalf("expected %s, got %v", fixture.InvalidError, err)
			}
		})
	}
	for _, item := range fixture.MetadataBounds {
		t.Run(item.Name, func(t *testing.T) {
			extensions := map[string]any{"provider": map[string]any{
				"receipt": map[string]any{"p": strings.Repeat("x", item.Padding)},
			}}
			if item.SecondProvider {
				extensions["second"] = map[string]any{}
			}
			value := map[string]any{"verdict": map[string]any{"decision": "allow"}, "extensions": extensions}
			canonical, err := CanonicalJSON(extensions)
			if err != nil {
				t.Fatal(err)
			}
			bytes := len(canonical)
			if bytes != item.Bytes {
				t.Fatalf("canonical bytes = %d, expected %d", bytes, item.Bytes)
			}
			_, err = ParseInterceptorResponse(value)
			if item.Valid {
				if err != nil {
					t.Fatal(err)
				}
			} else {
				var core *CoreError
				if !errors.As(err, &core) || core.Code != fixture.InvalidError {
					t.Fatalf("expected %s, got %v", fixture.InvalidError, err)
				}
			}
		})
	}
}

func TestInterceptorResponsePreservesReceiptNumber(t *testing.T) {
	response, err := ParseInterceptorResponseJSON([]byte(
		`{"verdict":{"decision":"allow"},"extensions":{"provider":{"receipt":{"counter":9007199254740991}}}}`,
	))
	if err != nil {
		t.Fatal(err)
	}
	receipt := response.Extensions["provider"].(map[string]any)["receipt"].(map[string]any)
	number, ok := receipt["counter"].(float64)
	if !ok || number != 9007199254740991 {
		t.Fatalf("receipt number changed: %#v", receipt["counter"])
	}
}

func TestInterceptorResponseToWirePrefersBareVerdict(t *testing.T) {
	response, err := ParseInterceptorResponse(map[string]any{"decision": "allow"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(response.ToWire(), Verdict{Decision: Allow}) {
		t.Fatalf("wire = %#v", response.ToWire())
	}
}
