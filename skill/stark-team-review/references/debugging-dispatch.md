# Debugging Dispatch Failures

If sub-agents return 0 findings or errors, check the dispatch layer:

- **Orchestrator**: `$SCRIPTS/multi_review.py` — dispatches 3 CLI agents in parallel via `subprocess.run`
- **CLI flags per agent**:
  - Claude: `claude -p - --output-format text --model claude-opus-4-6` (prompt via stdin)
  - Codex: `codex exec review -c ... --ephemeral --json -o <tmpfile> --base <ref> -` (prompt via stdin, output from `-o` file)
  - Gemini: `gemini --model gemini-2.5-pro -p <prompt> -o json --approval-mode plan` (response in `{"response": "..."}` envelope, `GEMINI_CLI_HOME` tmpdir for isolation)
- **Error detection**: non-zero exit code → `cli_error`, empty output → `empty_output`. Check stderr in orchestrator output.
- **Smoke test**: `$PYTHON -m pytest $SCRIPTS/test_multi_review.py::TestCLIFlagsSmoke -v` verifies each CLI accepts its flags
