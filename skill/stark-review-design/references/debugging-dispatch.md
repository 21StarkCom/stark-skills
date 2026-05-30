# Debugging Dispatch Failures — stark-review-design

If sub-agents return 0 findings or errors, check the dispatch layer:

- **Orchestrator**: `$TOOLS/stark_review_doc.ts` — lead/wing flow. The lead
  (codex, gpt-5.5, `model_reasoning_effort=xhigh`) reviews each domain in
  parallel via `child_process.spawn`; the wing (claude, opus-4-8) emits JSON
  patches that the host applies. There is no Gemini agent in this flow.
- **Prompts dir**: `--prompts-dir design-review` — loads from `global/prompts/design-review/{agent}/`
- **CLI flags per agent**:
  - Lead — Codex: `codex exec -c ... --ephemeral --json -o <tmpfile> -` (prompt via stdin, output from `-o` file)
  - Wing — Claude: `claude -p - --output-format text --model claude-opus-4-8` (prompt via stdin)
- **Error detection**: non-zero exit code → `cli_error`, empty output → `empty_output`. Check stderr in orchestrator output.
- **Smoke test**: `node --experimental-strip-types "$TOOLS/stark_review_doc.ts" --help` verifies the CLI loads + parses its flags
