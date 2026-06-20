# `REFACTOR_BACKLOG.json` — exact schema

Emit a single valid JSON object in exactly this shape. It is the machine-readable
twin of `REFACTOR_PLAN.md`: every problem, duplicate, phase, and risky area in
the plan should have a corresponding entry here, so an executor can drive the
work from JSON alone.

```json
{
  "summary": {
    "language": "",
    "framework": "",
    "package_manager": "",
    "install_command": "",
    "test_command": "",
    "build_command": "",
    "lint_command": "",
    "typecheck_command": ""
  },
  "target_architecture": {
    "directories": [
      {
        "path": "",
        "responsibility": "",
        "allowed_dependencies": [],
        "forbidden_dependencies": []
      }
    ]
  },
  "tasks": [
    {
      "id": "RF-001",
      "title": "",
      "type": "test | move | rename | delete | merge | replace | architecture | config | docs",
      "severity": "critical | high | medium | low",
      "risk": "high | medium | low",
      "status": "planned",
      "paths": [],
      "symbols": [],
      "description": "",
      "evidence": [],
      "implementation_steps": [],
      "depends_on": [],
      "validation_commands": [],
      "rollback_plan": ""
    }
  ],
  "duplicates": [
    {
      "id": "DUP-001",
      "paths": [],
      "symbols": [],
      "canonical_path": "",
      "action": "delete | merge | replace | keep",
      "reason": "",
      "evidence": []
    }
  ],
  "risky_areas": [
    {
      "path": "",
      "reason": "",
      "required_tests_before_refactor": []
    }
  ]
}
```

## Field rules

- **summary** — mirror Section 1 of the plan. Any command that couldn't be
  determined from the repo is the literal string `"unknown"`, not an empty
  string and not a guess.
- **target_architecture.directories** — mirror Section 7. `allowed_` and
  `forbidden_dependencies` are arrays of directory paths/labels.
- **tasks[]** — one per executable unit of work. IDs are stable and sequential
  (`RF-001`, `RF-002`, …). `status` starts at `"planned"`. `depends_on` holds
  other task IDs and must form a DAG (no cycles). `type`, `severity`, and `risk`
  use only the enumerated values. `evidence` and `implementation_steps` are
  arrays of strings. `validation_commands` are the repo's real commands.
- **duplicates[]** — mirror Section 5. IDs `DUP-001`, `DUP-002`, … `action`
  uses only the enumerated values; `canonical_path` is the survivor.
- **risky_areas[]** — mirror Section 13.

## Validity

The JSON must parse. Validate before finishing:

```bash
python3 -m json.tool REFACTOR_BACKLOG.json > /dev/null && echo "JSON OK"
# or: jq . REFACTOR_BACKLOG.json > /dev/null
# or: node -e "JSON.parse(require('fs').readFileSync('REFACTOR_BACKLOG.json','utf8'))"
```
