#!/usr/bin/env bash
# Copyright (c) Microsoft. All rights reserved.

# Run from the repository root.
set -euo pipefail

mirror=sdk/python/python/agent_hooks/ctk/vectors
rm -rf "$mirror"
mkdir -p "$mirror"
cp conformance/0.1/vectors/AH-CTK-*.json "$mirror/"
git add -A -- "$mirror"
git diff --cached --exit-code -- "$mirror"
