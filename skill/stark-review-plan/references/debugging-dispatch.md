# Debugging Dispatch Failures

If sub-agents return 0 findings or errors, check the dispatch layer:

- **Orchestrator**: `$TOOLS/plan_review_dispatch.ts` -- dispatches 3 CLI agents in parallel via `child_process.spawn`
- **CLI flags per agent**:
  - Claude: `claude -p - --output-format text --model claude-opus-4-8` (prompt via stdin)
  - Codex: `codex exec -c ... --ephemeral --json -o <tmpfile> -` (prompt via stdin, output from `-o` file)
  - Gemini: `gemini --model gemini-3.1-pro-preview -p <instruction> -o json` (plan content via stdin, response in `{"response": "..."}` envelope; isolated `GEMINI_CLI_HOME` tmpdir whose `settings.json` pins Vertex-AI + global region)
- **Error detection**: non-zero exit code -> `cli_error`, empty output -> `empty_output`. Check stderr in orchestrator output.
- **Smoke test**: `node --experimental-strip-types --no-warnings "$TOOLS/plan_review_dispatch.ts" --help` verifies the CLI loads + parses its flags
