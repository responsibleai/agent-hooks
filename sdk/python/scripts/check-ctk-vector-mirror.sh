#!/usr/bin/env bash
# Copyright (c) Microsoft. All rights reserved.

# Refresh the Python CTK vector mirror from conformance vectors, then fail
# if the refreshed files differ from the committed mirror.
# Run from the repository root.
set -euo pipefail

mirror=sdk/python/python/agent_hooks/ctk/vectors
rm -rf "$mirror"
mkdir -p "$mirror"
cp conformance/0.1/vectors/AH-CTK-*.json "$mirror/"
git add -A -- "$mirror"
git diff --cached --exit-code -- "$mirror"
