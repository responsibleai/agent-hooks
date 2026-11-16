#!/usr/bin/env bash
# Copyright (c) Microsoft. All rights reserved.

# Compare the experimental Python draft schema mirror with generated draft
# schemas and report differences as an advisory warning.
# Run from the repository root.
set -euo pipefail

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
