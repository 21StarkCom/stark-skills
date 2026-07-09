# Debugging Dispatch Failures

If sub-agents return 0 findings or errors, check the dispatch layer:

- **Orchestrator**: `$TOOLS/stark_review_doc.ts` -- lead/wing doc-review dispatcher. The lead reviews each plan-review domain in parallel via `child_process.spawn`; the wing emits JSON patches the host applies. Default lead is codex (gpt-5.5 at `model_reasoning_effort=xhigh`), default wing is claude (opus-4-8); either is swappable via `--lead-agent`/`--wing-agent` (+ `--lead-model`/`--wing-model`). Gemini is not used.
- **CLI flags per agent** (whichever side each runs on):
  - Codex reviewer/wing: `codex exec --json --skip-git-repo-check [-s read-only for wing] -c model_reasoning_effort="xhigh" -m <model> -` (prompt via stdin, JSONL agent output)
  - Claude reviewer/wing: `claude -p - --output-format json --model <model> --allowedTools Read,Glob,Grep` (prompt via stdin)
- **Error detection**: non-zero exit code -> `cli_error`, empty output -> `empty_output`. Check stderr in orchestrator output.
- **Smoke test**: `node --experimental-strip-types "$TOOLS/stark_review_doc.ts" --help` verifies the CLI loads + parses its flags
