#!/usr/bin/env bash
# Copyright (c) Microsoft. All rights reserved.

# Refresh released Python schema mirrors from the supported spec bundles,
# then fail if the refreshed files differ from the committed mirror.
# Run from the repository root.
set -euo pipefail

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
