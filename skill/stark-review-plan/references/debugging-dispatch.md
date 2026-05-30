# Debugging Dispatch Failures

If sub-agents return 0 findings or errors, check the dispatch layer:

- **Orchestrator**: `$TOOLS/stark_review_doc.ts` -- lead/wing doc-review dispatcher. The codex lead reviews each plan-review domain in parallel via `child_process.spawn`; the claude wing emits JSON patches the host applies. Gemini is not used.
- **CLI flags per agent**:
  - Lead (Codex): `codex exec -c ... --ephemeral --json -o <tmpfile> -` (prompt via stdin, output read from the `-o` file; `model_reasoning_effort=xhigh`)
  - Wing (Claude): `claude -p - --output-format text --model claude-opus-4-8` (prompt via stdin)
- **Error detection**: non-zero exit code -> `cli_error`, empty output -> `empty_output`. Check stderr in orchestrator output.
- **Smoke test**: `node --experimental-strip-types "$TOOLS/stark_review_doc.ts" --help` verifies the CLI loads + parses its flags
