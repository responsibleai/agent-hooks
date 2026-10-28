# P-010 prototypes

Throwaway code behind the measurements in `../P-010-model-request-shape.md`.
Nothing here is normative and no SDK builds or imports it.

Run from this directory:

```bash
python3 run.py
```

Standard library only. Run it under an environment that has the
`agent-hooks-sdk` package installed and the output states whether the
canonical bytes match the Rust core.

Files:

- `fixtures.py`: three conversations in four shapes (OpenAI chat
  completions, OpenAI Responses, Anthropic Messages, the shape the
  agent-framework adapter emits today) and three provider responses.
- `neutral.py`: the candidate neutral shape and its projections to and
  from the three provider shapes, with residue kept under `ext`.
- `formats.py`: projections between the neutral shape and three more
  target shapes (Gemini `generateContent`, Bedrock Converse, the AI SDK
  `ModelMessage`).
- `candidates.py`: the four candidate targets, normalization and a diff.
- `paths.py`: a resolver for the section 5.2 path grammar and the three
  edits (redact a user string, drop a tool, replace the system prompt).
- `policies.py`: the three policy tasks (redact the latest user turn,
  deny on a pattern in a tool result, cap the system prompt) written
  against seven target shapes, with path-shape and line-count
  instrumentation.
- `jcs.py`: canonical JSON sizes and digests.
- `run.py`: prints every table.
