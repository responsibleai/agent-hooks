#!/usr/bin/env bash
# Copyright (c) Microsoft. All rights reserved.
set -euo pipefail

case "${1:-}" in
  released)
    mirror=sdk/python/python/agent_hooks/schema
    versions_text=$(python3 scripts/check-version-consistency.py --print-supported)
    mapfile -t versions <<< "$versions_text"
    # Preserve the experimental draft mirror.
    for directory in "$mirror"/*/; do
      [ -d "$directory" ] || continue
      [ "$(basename "$directory")" = draft ] || rm -rf "$directory"
    done
    for version in "${versions[@]}"; do
      [ "$version" != draft ] || continue
      if [[ ! "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
        echo "::error::invalid released specification version: $version"
        exit 1
      fi
      source="spec/$version/schema/generated"
      [ -d "$source" ] || source="spec/$version/schema"
      points="$source/strict-contexts"
      [ -d "$points" ] || points="$source/agent-context"
      mkdir -p "$mirror/$version/agent-context"
      cp "$source"/*.schema.json "$mirror/$version/"
      cp "$points"/*.schema.json "$mirror/$version/agent-context/"
    done
    git add -A -- "$mirror"
    git diff --cached --exit-code -- "$mirror"
    ;;
  vectors)
    mirror=sdk/python/python/agent_hooks/ctk/vectors
    rm -rf "$mirror"
    mkdir -p "$mirror"
    cp conformance/0.1/vectors/AH-CTK-*.json "$mirror/"
    git add -A -- "$mirror"
    git diff --cached --exit-code -- "$mirror"
    ;;
  draft)
    temporary=$(mktemp -d)
    trap 'rm -rf "$temporary"' EXIT
    source=spec/draft/schema/generated
    mkdir -p "$temporary/draft/agent-context"
    cp "$source"/*.schema.json "$temporary/draft/"
    cp "$source"/strict-contexts/*.schema.json "$temporary/draft/agent-context/"
    status=0
    diff -ru sdk/python/python/agent_hooks/schema/draft "$temporary/draft" > "$temporary/diff" || status=$?
    if [ "$status" -gt 1 ]; then
      cat "$temporary/diff"
      echo "::error::could not compare the draft schema mirror"
      exit "$status"
    fi
    {
      echo "## Experimental draft schema mirror"
      if [ "$status" -eq 0 ]; then
        echo "The SDK draft copies match the current draft schemas."
      else
        echo "The SDK draft copies differ from the current specification draft."
        echo "Advisory only: update these copies alongside matching SDK implementation changes."
        echo '```diff'
        cat "$temporary/diff"
        echo '```'
      fi
    } >> "$GITHUB_STEP_SUMMARY"
    if [ "$status" -eq 1 ]; then
      echo "::warning::experimental SDK draft schema copies differ from the latest draft; see the job summary"
    fi
    ;;
  aggregate)
    shift
    if [ "$#" -ne 4 ]; then
      echo "::error::expected four drift check results"
      exit 1
    fi
    for result in "$@"; do
      if [ "$result" != success ]; then
        echo "::error::a drift check did not succeed: $result"
        exit 1
      fi
    done
    ;;
  *)
    echo "::error::expected released, vectors, draft, or aggregate"
    exit 1
    ;;
esac
