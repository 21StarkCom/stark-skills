# Debugging Dispatch Failures

If sub-agents return 0 findings or errors, check the dispatch layer:

- **Orchestrator**: `$SCRIPTS/multi_review.py` — dispatches 3 CLI agents in parallel via `subprocess.run`
- **CLI flags per agent**:
  - Claude: `claude -p - --output-format text --model claude-opus-4-7` (prompt via stdin)
  - Codex: `codex exec review -c ... --ephemeral --json -o <tmpfile> --base <ref> -` (prompt via stdin, output from `-o` file)
  - Gemini: `gemini --model gemini-3.1-pro-preview -p <prompt> -o json` (response in `{"response": "..."}` envelope; isolated `GEMINI_CLI_HOME` tmpdir whose `settings.json` pins Vertex-AI + global region and sets `defaultApprovalMode` — `--approval-mode` is not a valid CLI flag in Gemini CLI v0.34+)
- **Error detection**: non-zero exit code → `cli_error`, empty output → `empty_output`. Check stderr in orchestrator output.
- **Smoke test**: `$PYTHON -m pytest $SCRIPTS/test_multi_review.py::TestCLIFlagsSmoke -v` verifies each CLI accepts its flags
