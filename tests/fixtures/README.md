# Native session samples

`pi-native.jsonl` and `codex-native.jsonl` were emitted on Windows by Pi 1.4.0 and Codex CLI 0.158.0, respectively. Each client sent “Sample question.” to a local mock endpoint and received “Sample reply.”. Both clients used temporary configuration and session directories. No existing client transcripts or credentials were copied.

Workspace paths were replaced with `C:\fixture\work`. System instructions, tool definitions, environment response items and unrelated Codex state records were omitted. Codex ordinals intentionally retain their original gaps. Subagent cases in tests are derived variants of the normal session header.

`agy-2.0/` is a structural projection of a local Antigravity 2.0 transcript pair (installed desktop 2.34.0.0). Selected step indices, step types, statuses, source labels and truncation fields mirror the records; all question, answer, thinking, metadata and tool argument values are synthetic. The fixtures do not establish Hook runtime behavior or compatibility with the CLI and IDE variants.
