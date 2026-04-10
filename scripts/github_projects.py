"""GitHub Projects V2 GraphQL operations.

Module-level function library wrapping GitHub Projects V2 GraphQL API.
Uses github_app.graphql() for all API calls.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import github_app

# ── Constants ────────────────────────────────────────────────────────────

MUTATION_DELAY = 0.1  # 100ms between mutations

LEGAL_TRANSITIONS: dict[str, set[str]] = {
    "Backlog": {"Needs Spec"},
    "Needs Spec": {"Ready for Agent", "Human Working", "Blocked"},
    "Ready for Agent": {"Agent Working", "Blocked"},
    "Agent Working": {"Human Review", "Needs Clarification", "Blocked"},
    "Human Working": {"Human Review", "Blocked"},
    "Needs Clarification": {"Ready for Agent", "Blocked"},
    "Human Review": {"Agent Working", "Human Working", "Ready to Merge", "Blocked"},
    "Ready to Merge": {"Ready to Release", "Human Review", "Blocked"},
    "Ready to Release": {"Done", "Human Review", "Blocked"},
    "Blocked": {
        "Backlog", "Needs Spec", "Ready for Agent", "Agent Working",
        "Human Working", "Needs Clarification", "Human Review",
        "Ready to Merge", "Ready to Release",
    },
}

# ── Field cache ──────────────────────────────────────────────────────────

_field_cache: dict[str, dict[str, Any]] = {}

# ── GraphQL queries ──────────────────────────────────────────────────────

_FIND_PROJECT = """
query($org: String!, $cursor: String) {
  organization(login: $org) {
    projectsV2(first: 20, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id title number }
    }
  }
}
"""

_ADD_ITEM = """
mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
    item { id }
  }
}
"""

_GET_FIELD_IDS = """
query($projectId: ID!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      fields(first: 50) {
        nodes {
          ... on ProjectV2Field {
            id name dataType
          }
          ... on ProjectV2SingleSelectField {
            id name dataType
            options { id name }
          }
          ... on ProjectV2IterationField {
            id name dataType
            configuration {
              iterations { id title startDate duration }
              completedIterations { id title startDate duration }
            }
          }
        }
      }
    }
  }
}
"""

_SET_FIELD = """
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value
  }) {
    projectV2Item { id }
  }
}
"""

_GET_ITEMS = """
query($projectId: ID!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          content {
            ... on Issue {
              number title
              repository { nameWithOwner }
              state
            }
            ... on PullRequest {
              number title
              repository { nameWithOwner }
              state
            }
          }
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { name } } }
              ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { name } } }
              ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
              ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2IterationField { name } } }
              ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2Field { name } } }
            }
          }
        }
      }
    }
  }
}
"""

_GET_SINGLE_ITEM = """
query($itemId: ID!) {
  node(id: $itemId) {
    ... on ProjectV2Item {
      id
      content {
        ... on Issue {
          number title
          repository { nameWithOwner }
          state
        }
      }
      fieldValues(first: 20) {
        nodes {
          ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { name } } }
          ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { name } } }
          ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
          ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2IterationField { name } } }
          ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2Field { name } } }
        }
      }
    }
  }
}
"""

_ISSUE_PROJECT_ITEMS = """
query($org: String!, $repo: String!, $number: Int!) {
  repository(owner: $org, name: $repo) {
    issue(number: $number) {
      id
      projectItems(first: 20) {
        nodes {
          id
          project { id }
        }
      }
    }
  }
}
"""


# ── Public API ───────────────────────────────────────────────────────────


def find_project(org: str, name: str) -> dict[str, Any]:
    """Find a project by name in an organization.

    Returns dict with keys: id, title, number.
    Raises ValueError if not found.
    """
    cursor = None
    while True:
        variables: dict[str, Any] = {"org": org}
        if cursor:
            variables["cursor"] = cursor
        result = github_app.graphql(_FIND_PROJECT, variables=variables)
        projects = result["data"]["organization"]["projectsV2"]
        for node in projects["nodes"]:
            if node["title"] == name:
                return {"id": node["id"], "title": node["title"], "number": node["number"]}
        if not projects["pageInfo"]["hasNextPage"]:
            break
        cursor = projects["pageInfo"]["endCursor"]
    raise ValueError(f"Project '{name}' not found in org '{org}'")


def add_issue_to_project(project_id: str, issue_node_id: str) -> str:
    """Add an issue to a project. Returns the item ID."""
    result = github_app.graphql(
        _ADD_ITEM,
        variables={"projectId": project_id, "contentId": issue_node_id},
    )
    return result["data"]["addProjectV2ItemById"]["item"]["id"]


def get_field_ids(project_id: str, *, refresh: bool = False) -> dict[str, Any]:
    """Get field definitions for a project.

    Returns dict mapping field_name to {id, type, options: {name: id}}.
    Cached per project_id; pass refresh=True to force re-fetch.
    """
    if not refresh and project_id in _field_cache:
        return _field_cache[project_id]

    result = github_app.graphql(_GET_FIELD_IDS, variables={"projectId": project_id})
    fields: dict[str, Any] = {}
    for node in result["data"]["node"]["fields"]["nodes"]:
        if "name" not in node:
            continue
        field_info: dict[str, Any] = {
            "id": node["id"],
            "type": node.get("dataType", "UNKNOWN"),
            "options": {},
        }
        # Single-select options
        if "options" in node:
            for opt in node["options"]:
                field_info["options"][opt["name"]] = opt["id"]
        # Iteration options
        if "configuration" in node:
            config = node["configuration"]
            for it in config.get("iterations", []):
                field_info["options"][it["title"]] = it["id"]
            for it in config.get("completedIterations", []):
                field_info["options"][it["title"]] = it["id"]
        fields[node["name"]] = field_info

    _field_cache[project_id] = fields
    return fields


def set_field(project_id: str, item_id: str, field_name: str, value: Any) -> None:
    """Set a field value on a project item.

    Resolves field/option IDs from cache. Handles SINGLE_SELECT, NUMBER,
    TEXT, and ITERATION field types. Raises ValueError if field or option
    not found.
    """
    fields = get_field_ids(project_id)
    if field_name not in fields:
        raise ValueError(f"Field '{field_name}' not found in project")
    field = fields[field_name]
    field_id = field["id"]
    field_type = field["type"]

    if field_type == "SINGLE_SELECT":
        if value not in field["options"]:
            raise ValueError(
                f"Option '{value}' not found for field '{field_name}'. "
                f"Available: {list(field['options'].keys())}"
            )
        gql_value: dict[str, Any] = {"singleSelectOptionId": field["options"][value]}
    elif field_type == "NUMBER":
        gql_value = {"number": float(value)}
    elif field_type == "TEXT":
        gql_value = {"text": str(value)}
    elif field_type == "ITERATION":
        if value not in field["options"]:
            raise ValueError(
                f"Iteration '{value}' not found for field '{field_name}'. "
                f"Available: {list(field['options'].keys())}"
            )
        gql_value = {"iterationId": field["options"][value]}
    else:
        raise ValueError(f"Unsupported field type '{field_type}' for field '{field_name}'")

    github_app.graphql(
        _SET_FIELD,
        variables={
            "projectId": project_id,
            "itemId": item_id,
            "fieldId": field_id,
            "value": gql_value,
        },
    )
    time.sleep(MUTATION_DELAY)


def set_fields(project_id: str, item_id: str, fields_dict: dict[str, Any]) -> None:
    """Set multiple fields on a project item. Calls set_field for each."""
    for field_name, value in fields_dict.items():
        set_field(project_id, item_id, field_name, value)


def _parse_field_values(field_values_nodes: list[dict]) -> dict[str, Any]:
    """Parse fieldValues nodes into a flat dict."""
    fields: dict[str, Any] = {}
    for fv in field_values_nodes:
        field_ref = fv.get("field")
        if not field_ref or "name" not in field_ref:
            continue
        fname = field_ref["name"]
        if "text" in fv:
            fields[fname] = fv["text"]
        elif "number" in fv:
            fields[fname] = fv["number"]
        elif "name" in fv:
            # SingleSelect — "name" is the selected option value
            fields[fname] = fv["name"]
        elif "title" in fv:
            fields[fname] = fv["title"]
        elif "date" in fv:
            fields[fname] = fv["date"]
    return fields


def get_item_fields(item_id: str) -> dict[str, Any]:
    """Get field values for a single project item."""
    result = github_app.graphql(_GET_SINGLE_ITEM, variables={"itemId": item_id})
    node = result["data"]["node"]
    return _parse_field_values(node["fieldValues"]["nodes"])


def get_items(project_id: str, **filters: Any) -> list[dict[str, Any]]:
    """Get all items from a project with optional client-side filtering.

    Returns list of dicts: {item_id, issue_number, title, repo, state, fields}.
    Paginates through all items (100 per page).
    """
    all_items: list[dict[str, Any]] = []
    cursor = None

    while True:
        variables: dict[str, Any] = {"projectId": project_id}
        if cursor:
            variables["cursor"] = cursor
        result = github_app.graphql(_GET_ITEMS, variables=variables)
        items_data = result["data"]["node"]["items"]

        for node in items_data["nodes"]:
            content = node.get("content") or {}
            item: dict[str, Any] = {
                "item_id": node["id"],
                "issue_number": content.get("number"),
                "title": content.get("title"),
                "repo": content.get("repository", {}).get("nameWithOwner") if content.get("repository") else None,
                "state": content.get("state"),
                "fields": _parse_field_values(node["fieldValues"]["nodes"]),
            }
            all_items.append(item)

        if not items_data["pageInfo"]["hasNextPage"]:
            break
        cursor = items_data["pageInfo"]["endCursor"]

    # Client-side filtering
    if filters:
        filtered = []
        for item in all_items:
            match = True
            for key, val in filters.items():
                # Check top-level keys and fields
                if key in item:
                    if item[key] != val:
                        match = False
                        break
                elif key in item.get("fields", {}):
                    if item["fields"][key] != val:
                        match = False
                        break
                else:
                    match = False
                    break
            if match:
                filtered.append(item)
        return filtered

    return all_items


def find_item_for_issue(org: str, repo: str, issue_number: int, project_id: str) -> str | None:
    """Find the project item ID for an issue. Returns None if not in project."""
    result = github_app.graphql(
        _ISSUE_PROJECT_ITEMS,
        variables={"org": org, "repo": repo, "number": issue_number},
    )
    issue = result["data"]["repository"]["issue"]
    if issue is None:
        return None
    for item in issue["projectItems"]["nodes"]:
        if item["project"]["id"] == project_id:
            return item["id"]
    return None


def get_issue_node_id(org: str, repo: str, issue_number: int) -> str:
    """Get the GraphQL node ID for an issue."""
    result = github_app.graphql(
        _ISSUE_PROJECT_ITEMS,
        variables={"org": org, "repo": repo, "number": issue_number},
    )
    issue = result["data"]["repository"]["issue"]
    if issue is None:
        raise ValueError(
            f"Issue #{issue_number} not found in {org}/{repo}"
        )
    return issue["id"]


def is_legal_transition(from_status: str, to_status: str) -> bool:
    """Check if a status transition is legal."""
    allowed = LEGAL_TRANSITIONS.get(from_status)
    if allowed is None:
        return False
    return to_status in allowed


def transition_status(
    project_id: str,
    item_id: str,
    new_status: str,
    *,
    validate: bool = True,
) -> bool:
    """Transition an item's Status field to a new value.

    If validate is True, reads current status and checks LEGAL_TRANSITIONS.
    Returns False if already in target status (idempotent).
    Raises ValueError on illegal transition.
    Raises RuntimeError on GraphQL failure.
    """
    if validate:
        current_fields = get_item_fields(item_id)
        current_status = current_fields.get("Status")
        if current_status is None:
            raise ValueError("Cannot validate transition: current Status field is missing")
        if current_status == new_status:
            return False
        if not is_legal_transition(current_status, new_status):
            raise ValueError(
                f"Illegal transition: '{current_status}' → '{new_status}'. "
                f"Allowed: {LEGAL_TRANSITIONS.get(current_status, set())}"
            )

    set_field(project_id, item_id, "Status", new_status)
    return True


def check_spec_completeness(item_fields: dict[str, Any]) -> tuple[bool, list[str]]:
    """Check if an item's fields indicate spec completeness.

    Checks:
    - Risk is set
    - AI Suitability is set
    - For high-risk items, Spec Approval must be set

    Does NOT parse issue body.
    Returns (is_complete, list_of_missing_reasons).
    """
    missing: list[str] = []

    if not item_fields.get("Risk"):
        missing.append("Risk field is not set")
    if not item_fields.get("AI Suitability"):
        missing.append("AI Suitability field is not set")

    risk = item_fields.get("Risk", "")
    if risk and risk.lower() == "high":
        if item_fields.get("Spec Approval") != "Approved":
            missing.append("Spec Approval required for high-risk items")

    return (len(missing) == 0, missing)


def load_project_config(repo_root: str = ".") -> dict[str, Any] | None:
    """Load project configuration from .github/project-config.json.

    Returns the parsed dict or None if file doesn't exist.
    """
    config_path = Path(repo_root) / ".github" / "project-config.json"
    if not config_path.exists():
        return None
    return json.loads(config_path.read_text())
