# Copilot instructions

Follow [AGENTS.md](../AGENTS.md). The rules that matter most in review:

- Normative changes go in `spec/draft/`. Released folders such as `spec/0.1/` and `conformance/0.1/` never change.
- Generated output is never edited by hand. Change the TypeSpec or the emitter, then run `pnpm generate`.
- A contract change covers all five SDKs, with conformance vectors for behavior that crosses languages.
- Code fails closed and never normalizes values.
- Every source file starts with `Copyright (c) Microsoft. All rights reserved.` in its comment style, then a blank line.
