# Debugging Dispatch Failures — stark-review-design

If sub-agents return 0 findings or errors, check the dispatch layer:

- **Orchestrator**: `$SCRIPTS/plan_review_dispatch.py` — dispatches 3 CLI agents in parallel via `subprocess.run`
- **Prompts dir**: `--prompts-dir design-review` — loads from `global/prompts/design-review/{agent}/`
- **CLI flags per agent**:
  - Claude: `claude -p - --output-format text --model claude-opus-4-7` (prompt via stdin)
  - Codex: `codex exec -c ... --ephemeral --json -o <tmpfile> -` (prompt via stdin, output from `-o` file)
  - Gemini: `gemini --model gemini-3.1-pro-preview -p <instruction> -o json` (design content via stdin, response in `{"response": "..."}` envelope; isolated `GEMINI_CLI_HOME` tmpdir whose `settings.json` pins Vertex-AI + global region)
- **Error detection**: non-zero exit code → `cli_error`, empty output → `empty_output`. Check stderr in orchestrator output.
- **Smoke test**: `$PYTHON -m pytest $SCRIPTS/test_plan_review_dispatch.py::TestCLIFlagsSmoke -v` verifies each CLI accepts its flags
