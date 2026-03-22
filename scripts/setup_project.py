#!/usr/bin/env python3
"""One-time setup for a GitHub Projects V2 board with AI-DD custom fields.

Creates (or finds) a project in the given org, ensures all 14 custom fields
exist with the correct types and options, then writes the resolved IDs to
.github/project-config.json so downstream scripts can use them without
additional API calls.

Idempotent: safe to re-run — skips fields that already exist.

Usage:
    setup_project.py [--org ORG] [--name NAME] [--app APP] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

# Ensure sibling modules are importable when run as a script
sys.path.insert(0, str(Path(__file__).resolve().parent))

import github_app
import github_projects

# ── Field definitions ────────────────────────────────────────────────────

FIELDS: list[dict[str, Any]] = [
    {
        "name": "Priority",
        "type": "SINGLE_SELECT",
        "options": [
            {"name": "Critical", "color": "RED"},
            {"name": "High", "color": "ORANGE"},
            {"name": "Medium", "color": "YELLOW"},
            {"name": "Low", "color": "GRAY"},
        ],
    },
    {
        "name": "Risk",
        "type": "SINGLE_SELECT",
        "options": [
            {"name": "High", "color": "RED"},
            {"name": "Medium", "color": "ORANGE"},
            {"name": "Low", "color": "GREEN"},
        ],
    },
    {
        "name": "AI Suitability",
        "type": "SINGLE_SELECT",
        "options": [
            {"name": "Autonomous", "color": "BLUE"},
            {"name": "Assisted", "color": "PURPLE"},
            {"name": "Human-led", "color": "YELLOW"},
        ],
    },
    {
        "name": "Spec Approval",
        "type": "SINGLE_SELECT",
        "options": [
            {"name": "Not Required", "color": "GRAY"},
            {"name": "Pending", "color": "YELLOW"},
            {"name": "Approved", "color": "GREEN"},
            {"name": "Rejected", "color": "RED"},
        ],
    },
    {
        "name": "Release Approval",
        "type": "SINGLE_SELECT",
        "options": [
            {"name": "Not Required", "color": "GRAY"},
            {"name": "Pending", "color": "YELLOW"},
            {"name": "Approved", "color": "GREEN"},
            {"name": "Rejected", "color": "RED"},
        ],
    },
    {
        "name": "Documentation State",
        "type": "SINGLE_SELECT",
        "options": [
            {"name": "Not Started", "color": "GRAY"},
            {"name": "Drafted", "color": "YELLOW"},
            {"name": "Reviewed", "color": "PURPLE"},
            {"name": "Complete", "color": "GREEN"},
        ],
    },
    {
        "name": "Agent",
        "type": "SINGLE_SELECT",
        "options": [
            {"name": "Claude", "color": "ORANGE"},
            {"name": "Codex", "color": "BLUE"},
            {"name": "Gemini", "color": "GREEN"},
            {"name": "None", "color": "GRAY"},
        ],
    },
    {"name": "Story Points", "type": "NUMBER"},
    {"name": "Review Rounds", "type": "NUMBER"},
    {"name": "Phase", "type": "TEXT"},
    {"name": "Blocked Reason", "type": "TEXT"},
    {"name": "Owner", "type": "TEXT"},
    {"name": "Iteration", "type": "ITERATION"},
]

# ── GraphQL mutations for field creation ─────────────────────────────────

_CREATE_FIELD = """
mutation($projectId: ID!, $name: String!, $dataType: ProjectV2CustomFieldType!) {
  createProjectV2Field(input: {projectId: $projectId, name: $name, dataType: $dataType}) {
    projectV2Field {
      ... on ProjectV2Field { id name dataType }
      ... on ProjectV2SingleSelectField { id name dataType }
      ... on ProjectV2IterationField { id name dataType }
    }
  }
}
"""

_CREATE_SELECT_OPTION = """
mutation($projectId: ID!, $fieldId: ID!, $name: String!, $color: ProjectV2SingleSelectFieldOptionColor!) {
  createProjectV2FieldOption(input: {projectId: $projectId, fieldId: $fieldId, name: $name, color: $color}) {
    projectV2SingleSelectField {
      id
      options { id name }
    }
  }
}
"""

_CREATE_PROJECT = """
mutation($ownerId: ID!, $title: String!) {
  createProjectV2(input: {ownerId: $ownerId, title: $title}) {
    projectV2 { id title number }
  }
}
"""

_GET_ORG_ID = """
query($org: String!) {
  organization(login: $org) { id }
}
"""


# ── Helpers ──────────────────────────────────────────────────────────────


def _detect_org() -> str:
    """Extract org name from git remote (e.g. 'GetEvinced')."""
    repo = github_app._detect_repo()
    if not repo or "/" not in repo:
        print("Could not detect org from git remote. Use --org.", file=sys.stderr)
        sys.exit(1)
    return repo.split("/")[0]


def _find_or_create_project(org: str, name: str, *, dry_run: bool) -> dict[str, Any]:
    """Find existing project or create a new one."""
    try:
        project = github_projects.find_project(org, name)
        print(f"Found existing project: {name} (#{project['number']})")
        return project
    except ValueError:
        pass

    if dry_run:
        print(f"[dry-run] Would create project '{name}' in org '{org}'")
        return {"id": "PVT_dry_run", "title": name, "number": 0}

    # Need org node ID for createProjectV2
    result = github_app.graphql(_GET_ORG_ID, variables={"org": org})
    org_id = result["data"]["organization"]["id"]

    result = github_app.graphql(
        _CREATE_PROJECT,
        variables={"ownerId": org_id, "title": name},
    )
    project = result["data"]["createProjectV2"]["projectV2"]
    print(f"Created project: {name} (#{project['number']})")
    return {"id": project["id"], "title": project["title"], "number": project["number"]}


def _create_field(
    project_id: str, field_def: dict[str, Any], *, dry_run: bool
) -> str | None:
    """Create a single custom field. Returns the new field ID, or None on dry-run."""
    name = field_def["name"]
    field_type = field_def["type"]

    if dry_run:
        print(f"  [dry-run] Would create field: {name} ({field_type})")
        if field_def.get("options"):
            for opt in field_def["options"]:
                print(f"    [dry-run] Would create option: {opt['name']} ({opt['color']})")
        return None

    # Map spec types to GraphQL enum values
    gql_type = field_type  # SINGLE_SELECT, NUMBER, TEXT, ITERATION match directly

    result = github_app.graphql(
        _CREATE_FIELD,
        variables={"projectId": project_id, "name": name, "dataType": gql_type},
    )
    field_data = result["data"]["createProjectV2Field"]["projectV2Field"]
    field_id = field_data["id"]
    print(f"  Created field: {name} ({field_type}) -> {field_id}")
    time.sleep(github_projects.MUTATION_DELAY)

    # Add options for single-select fields
    if field_type == "SINGLE_SELECT" and field_def.get("options"):
        for opt in field_def["options"]:
            github_app.graphql(
                _CREATE_SELECT_OPTION,
                variables={
                    "projectId": project_id,
                    "fieldId": field_id,
                    "name": opt["name"],
                    "color": opt["color"],
                },
            )
            print(f"    Added option: {opt['name']} ({opt['color']})")
            time.sleep(github_projects.MUTATION_DELAY)

    return field_id


def _write_config(
    project: dict[str, Any],
    org: str,
    fields: dict[str, Any],
    *,
    dry_run: bool,
) -> Path:
    """Write .github/project-config.json."""
    config = {
        "project_id": project["id"],
        "project_number": project["number"],
        "org": org,
        "fields": fields,
    }

    config_dir = Path(".github")
    config_path = config_dir / "project-config.json"

    if dry_run:
        print(f"\n[dry-run] Would write {config_path}:")
        print(json.dumps(config, indent=2))
        return config_path

    config_dir.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    print(f"\nWrote {config_path}")
    return config_path


# ── Main ─────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Set up a GitHub Projects V2 board with AI-DD custom fields."
    )
    parser.add_argument("--org", help="GitHub org (default: from git remote)")
    parser.add_argument("--name", default="AI-DD Tracker", help="Project name (default: AI-DD Tracker)")
    parser.add_argument(
        "--app",
        default="stark-claude",
        choices=list(github_app.APPS.keys()),
        help="GitHub App for auth (default: stark-claude)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Show what would be created, no API calls")
    args = parser.parse_args()

    org = args.org or _detect_org()
    github_app.select_app(args.app)

    print(f"Org: {org}")
    print(f"Project: {args.name}")
    print(f"App: {args.app}")
    if args.dry_run:
        print("Mode: DRY RUN\n")
    else:
        print()

    # 1. Find or create project
    project = _find_or_create_project(org, args.name, dry_run=args.dry_run)
    project_id = project["id"]

    # 2. Get existing fields
    if not args.dry_run:
        existing_fields = github_projects.get_field_ids(project_id)
    else:
        existing_fields = {}

    # 3. Create missing fields
    created = 0
    skipped = 0
    for field_def in FIELDS:
        name = field_def["name"]
        if name in existing_fields:
            print(f"  Skipping (exists): {name}")
            skipped += 1
            continue
        _create_field(project_id, field_def, dry_run=args.dry_run)
        created += 1

    print(f"\nFields: {created} created, {skipped} skipped (already existed)")

    # 4. Refresh field IDs and build config
    if not args.dry_run:
        all_fields = github_projects.get_field_ids(project_id, refresh=True)
    else:
        # Build a synthetic field map for dry-run output
        all_fields = {}
        for field_def in FIELDS:
            name = field_def["name"]
            info: dict[str, Any] = {
                "id": f"PVTF_dry_run_{name.replace(' ', '_').lower()}",
                "type": field_def["type"],
            }
            if field_def.get("options"):
                info["options"] = {
                    opt["name"]: f"opt_dry_{opt['name'].replace(' ', '_').lower()}"
                    for opt in field_def["options"]
                }
            all_fields[name] = info

    # Build config-friendly field map (include options only for select/iteration)
    config_fields: dict[str, Any] = {}
    for name, info in all_fields.items():
        entry: dict[str, Any] = {"id": info["id"], "type": info["type"]}
        if info.get("options"):
            entry["options"] = info["options"]
        config_fields[name] = entry

    # 5. Write config
    _write_config(project, org, config_fields, dry_run=args.dry_run)

    print("\nDone.")


if __name__ == "__main__":
    main()
