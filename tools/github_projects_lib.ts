/**
 * GitHub Projects V2 GraphQL operations — TypeScript port of
 * `scripts/github_projects.py`.
 *
 * Thin function library over GitHub Projects V2 GraphQL. All API calls go
 * through `graphql()` from `github_app_lib.ts`, so per-owner installation
 * routing happens automatically when callers go through the high-level
 * helpers (`findItemForIssue` / `getIssueNodeId` derive owner from `org`
 * via an explicit pass-through — the auto-deriver only kicks in for REST
 * `/repos/...` paths, not GraphQL).
 *
 * Field-id discovery is cached per-project for the lifetime of the
 * process. `resetFieldCache()` is exposed for tests; production callers
 * never touch it.
 */

import fs from "node:fs";
import path from "node:path";

import { graphql } from "./github_app_lib.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Delay between consecutive field-update mutations, milliseconds. */
export const MUTATION_DELAY_MS = 100;

/**
 * Legal Status field transitions. Keys = from-status; values = the set of
 * allowed to-statuses. `Blocked` can leave to almost anything because
 * unblocking is a release operation that shouldn't require routing
 * through the full graph.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  Backlog: new Set(["Needs Spec"]),
  "Needs Spec": new Set(["Ready for Agent", "Human Working", "Blocked"]),
  "Ready for Agent": new Set(["Agent Working", "Blocked"]),
  "Agent Working": new Set(["Human Review", "Needs Clarification", "Blocked"]),
  "Human Working": new Set(["Human Review", "Blocked"]),
  "Needs Clarification": new Set(["Ready for Agent", "Blocked"]),
  "Human Review": new Set([
    "Agent Working",
    "Human Working",
    "Ready to Merge",
    "Blocked",
  ]),
  "Ready to Merge": new Set(["Ready to Release", "Human Review", "Blocked"]),
  "Ready to Release": new Set(["Done", "Human Review", "Blocked"]),
  Blocked: new Set([
    "Backlog",
    "Needs Spec",
    "Ready for Agent",
    "Agent Working",
    "Human Working",
    "Needs Clarification",
    "Human Review",
    "Ready to Merge",
    "Ready to Release",
  ]),
};

// ---------------------------------------------------------------------------
// Field cache (process-lifetime, per-project)
// ---------------------------------------------------------------------------

export interface FieldInfo {
  id: string;
  type: string;
  options: Record<string, string>;
}

const fieldCache = new Map<string, Record<string, FieldInfo>>();

/** Test-only: drop the in-memory field cache. */
export function resetFieldCache(): void {
  fieldCache.clear();
}

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

const FIND_PROJECT_Q = /* GraphQL */ `
query($org: String!, $cursor: String) {
  organization(login: $org) {
    projectsV2(first: 20, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id title number }
    }
  }
}
`;

const ADD_ITEM_M = /* GraphQL */ `
mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
    item { id }
  }
}
`;

const GET_FIELD_IDS_Q = /* GraphQL */ `
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
`;

const SET_FIELD_M = /* GraphQL */ `
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value
  }) {
    projectV2Item { id }
  }
}
`;

const GET_ITEMS_Q = /* GraphQL */ `
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
`;

const GET_SINGLE_ITEM_Q = /* GraphQL */ `
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
`;

const ISSUE_PROJECT_ITEMS_Q = /* GraphQL */ `
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
`;

// ---------------------------------------------------------------------------
// GraphQL response shapes (the slices we touch — not exhaustive)
// ---------------------------------------------------------------------------

interface GqlEnvelope<T> {
  data: T;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface ProjectNode {
  id: string;
  title: string;
  number: number;
}

interface FieldNode {
  id?: string;
  name?: string;
  dataType?: string;
  options?: Array<{ id: string; name: string }>;
  configuration?: {
    iterations?: Array<{ id: string; title: string }>;
    completedIterations?: Array<{ id: string; title: string }>;
  };
}

interface FieldValueNode {
  text?: string;
  number?: number;
  name?: string;
  title?: string;
  date?: string;
  field?: { name?: string };
}

interface ItemNode {
  id: string;
  content?: {
    number?: number;
    title?: string;
    repository?: { nameWithOwner?: string };
    state?: string;
  } | null;
  fieldValues: { nodes: FieldValueNode[] };
}

// ---------------------------------------------------------------------------
// findProject
// ---------------------------------------------------------------------------

export interface ProjectSummary {
  id: string;
  title: string;
  number: number;
}

export async function findProject(
  org: string,
  name: string,
): Promise<ProjectSummary> {
  let cursor: string | null = null;
  for (;;) {
    const variables: Record<string, unknown> = { org };
    if (cursor) variables["cursor"] = cursor;
    const result = (await graphql(FIND_PROJECT_Q, { variables })) as GqlEnvelope<{
      organization: {
        projectsV2: { pageInfo: PageInfo; nodes: ProjectNode[] };
      };
    }>;
    const projects = result.data.organization.projectsV2;
    for (const node of projects.nodes) {
      if (node.title === name) {
        return { id: node.id, title: node.title, number: node.number };
      }
    }
    if (!projects.pageInfo.hasNextPage) break;
    cursor = projects.pageInfo.endCursor;
  }
  throw new Error(`Project '${name}' not found in org '${org}'`);
}

// ---------------------------------------------------------------------------
// addIssueToProject
// ---------------------------------------------------------------------------

export async function addIssueToProject(
  projectId: string,
  issueNodeId: string,
): Promise<string> {
  const result = (await graphql(ADD_ITEM_M, {
    variables: { projectId, contentId: issueNodeId },
  })) as GqlEnvelope<{ addProjectV2ItemById: { item: { id: string } } }>;
  return result.data.addProjectV2ItemById.item.id;
}

// ---------------------------------------------------------------------------
// getFieldIds (with cache)
// ---------------------------------------------------------------------------

export interface GetFieldIdsOpts {
  refresh?: boolean;
}

export async function getFieldIds(
  projectId: string,
  opts: GetFieldIdsOpts = {},
): Promise<Record<string, FieldInfo>> {
  if (!opts.refresh) {
    const cached = fieldCache.get(projectId);
    if (cached) return cached;
  }

  const result = (await graphql(GET_FIELD_IDS_Q, {
    variables: { projectId },
  })) as GqlEnvelope<{ node: { fields: { nodes: FieldNode[] } } }>;

  const fields: Record<string, FieldInfo> = {};
  for (const node of result.data.node.fields.nodes) {
    if (!node.name || !node.id) continue;
    const info: FieldInfo = {
      id: node.id,
      type: node.dataType ?? "UNKNOWN",
      options: {},
    };
    if (node.options) {
      for (const opt of node.options) info.options[opt.name] = opt.id;
    }
    if (node.configuration) {
      for (const it of node.configuration.iterations ?? []) {
        info.options[it.title] = it.id;
      }
      for (const it of node.configuration.completedIterations ?? []) {
        info.options[it.title] = it.id;
      }
    }
    fields[node.name] = info;
  }

  fieldCache.set(projectId, fields);
  return fields;
}

// ---------------------------------------------------------------------------
// setField / setFields
// ---------------------------------------------------------------------------

type GqlFieldValue =
  | { singleSelectOptionId: string }
  | { number: number }
  | { text: string }
  | { iterationId: string };

/** Build the GraphQL `ProjectV2FieldValue` payload for a given field type. */
export function buildFieldValuePayload(
  field: FieldInfo,
  fieldName: string,
  value: unknown,
): GqlFieldValue {
  switch (field.type) {
    case "SINGLE_SELECT": {
      const key = String(value);
      const optionId = field.options[key];
      if (!optionId) {
        throw new Error(
          `Option '${key}' not found for field '${fieldName}'. Available: ${Object.keys(field.options).join(", ")}`,
        );
      }
      return { singleSelectOptionId: optionId };
    }
    case "NUMBER":
      return { number: Number(value) };
    case "TEXT":
      return { text: String(value) };
    case "ITERATION": {
      const key = String(value);
      const iterationId = field.options[key];
      if (!iterationId) {
        throw new Error(
          `Iteration '${key}' not found for field '${fieldName}'. Available: ${Object.keys(field.options).join(", ")}`,
        );
      }
      return { iterationId };
    }
    default:
      throw new Error(
        `Unsupported field type '${field.type}' for field '${fieldName}'`,
      );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function setField(
  projectId: string,
  itemId: string,
  fieldName: string,
  value: unknown,
): Promise<void> {
  const fields = await getFieldIds(projectId);
  const field = fields[fieldName];
  if (!field) throw new Error(`Field '${fieldName}' not found in project`);
  const gqlValue = buildFieldValuePayload(field, fieldName, value);
  await graphql(SET_FIELD_M, {
    variables: { projectId, itemId, fieldId: field.id, value: gqlValue },
  });
  await sleep(MUTATION_DELAY_MS);
}

export async function setFields(
  projectId: string,
  itemId: string,
  fieldsDict: Record<string, unknown>,
): Promise<void> {
  for (const [name, value] of Object.entries(fieldsDict)) {
    await setField(projectId, itemId, name, value);
  }
}

// ---------------------------------------------------------------------------
// Field-value parser (fieldValues nodes → flat dict)
// ---------------------------------------------------------------------------

export type FieldValue = string | number;

/**
 * Flatten GraphQL `fieldValues.nodes` into `{ fieldName: value }`. Each
 * node carries exactly one of `text` / `number` / `name` (single-select) /
 * `title` (iteration) / `date` along with a `field { name }` pointer.
 */
export function parseFieldValues(
  nodes: FieldValueNode[],
): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const fv of nodes) {
    const fname = fv.field?.name;
    if (!fname) continue;
    if (fv.text !== undefined) out[fname] = fv.text;
    else if (fv.number !== undefined) out[fname] = fv.number;
    else if (fv.name !== undefined) out[fname] = fv.name;
    else if (fv.title !== undefined) out[fname] = fv.title;
    else if (fv.date !== undefined) out[fname] = fv.date;
  }
  return out;
}

// ---------------------------------------------------------------------------
// getItemFields (single item)
// ---------------------------------------------------------------------------

export async function getItemFields(
  itemId: string,
): Promise<Record<string, FieldValue>> {
  const result = (await graphql(GET_SINGLE_ITEM_Q, {
    variables: { itemId },
  })) as GqlEnvelope<{ node: ItemNode }>;
  return parseFieldValues(result.data.node.fieldValues.nodes);
}

// ---------------------------------------------------------------------------
// getItems (project, paginated + client-side filter)
// ---------------------------------------------------------------------------

export interface ProjectItem {
  item_id: string;
  issue_number: number | null;
  title: string | null;
  repo: string | null;
  state: string | null;
  fields: Record<string, FieldValue>;
}

/**
 * Decide whether an item matches a flat key/value filter map. Top-level
 * item keys (issue_number, title, repo, state) take precedence over
 * field-bag entries — only one key is consulted per filter, matching the
 * Python's first-match semantics. Unknown keys fail the filter.
 */
export function itemMatchesFilters(
  item: ProjectItem,
  filters: Record<string, unknown>,
): boolean {
  for (const [key, expected] of Object.entries(filters)) {
    if (key in item) {
      const actual = (item as unknown as Record<string, unknown>)[key];
      if (actual !== expected) return false;
    } else if (key in item.fields) {
      if (item.fields[key] !== expected) return false;
    } else {
      return false;
    }
  }
  return true;
}

export async function getItems(
  projectId: string,
  filters: Record<string, unknown> = {},
): Promise<ProjectItem[]> {
  const all: ProjectItem[] = [];
  let cursor: string | null = null;

  for (;;) {
    const variables: Record<string, unknown> = { projectId };
    if (cursor) variables["cursor"] = cursor;
    const result = (await graphql(GET_ITEMS_Q, { variables })) as GqlEnvelope<{
      node: { items: { pageInfo: PageInfo; nodes: ItemNode[] } };
    }>;
    const itemsData = result.data.node.items;
    for (const node of itemsData.nodes) {
      const content = node.content ?? {};
      all.push({
        item_id: node.id,
        issue_number: content.number ?? null,
        title: content.title ?? null,
        repo: content.repository?.nameWithOwner ?? null,
        state: content.state ?? null,
        fields: parseFieldValues(node.fieldValues.nodes),
      });
    }
    if (!itemsData.pageInfo.hasNextPage) break;
    cursor = itemsData.pageInfo.endCursor;
  }

  if (Object.keys(filters).length === 0) return all;
  return all.filter((item) => itemMatchesFilters(item, filters));
}

// ---------------------------------------------------------------------------
// Issue lookups
// ---------------------------------------------------------------------------

interface IssueProjectItemsResp {
  repository: {
    issue: {
      id: string;
      projectItems: {
        nodes: Array<{ id: string; project: { id: string } }>;
      };
    } | null;
  };
}

export async function findItemForIssue(
  org: string,
  repo: string,
  issueNumber: number,
  projectId: string,
): Promise<string | null> {
  const result = (await graphql(ISSUE_PROJECT_ITEMS_Q, {
    variables: { org, repo, number: issueNumber },
  })) as GqlEnvelope<IssueProjectItemsResp>;
  const issue = result.data.repository.issue;
  if (!issue) return null;
  for (const item of issue.projectItems.nodes) {
    if (item.project.id === projectId) return item.id;
  }
  return null;
}

export async function getIssueNodeId(
  org: string,
  repo: string,
  issueNumber: number,
): Promise<string> {
  const result = (await graphql(ISSUE_PROJECT_ITEMS_Q, {
    variables: { org, repo, number: issueNumber },
  })) as GqlEnvelope<IssueProjectItemsResp>;
  const issue = result.data.repository.issue;
  if (!issue) {
    throw new Error(`Issue #${issueNumber} not found in ${org}/${repo}`);
  }
  return issue.id;
}

// ---------------------------------------------------------------------------
// Status transition machine
// ---------------------------------------------------------------------------

export function isLegalTransition(
  fromStatus: string,
  toStatus: string,
): boolean {
  const allowed = LEGAL_TRANSITIONS[fromStatus];
  if (!allowed) return false;
  return allowed.has(toStatus);
}

export interface TransitionOpts {
  validate?: boolean;
}

/**
 * Transition an item's Status field.
 *
 * Returns `false` (idempotent no-op) when the item is already in the
 * target status. Throws `Error` on illegal transition or on missing
 * current Status when validation is requested.
 */
export async function transitionStatus(
  projectId: string,
  itemId: string,
  newStatus: string,
  opts: TransitionOpts = {},
): Promise<boolean> {
  const validate = opts.validate ?? true;
  if (validate) {
    const current = await getItemFields(itemId);
    const currentStatus = current["Status"];
    if (currentStatus === undefined || currentStatus === null) {
      throw new Error(
        "Cannot validate transition: current Status field is missing",
      );
    }
    if (currentStatus === newStatus) return false;
    if (!isLegalTransition(String(currentStatus), newStatus)) {
      const allowed = [
        ...(LEGAL_TRANSITIONS[String(currentStatus)] ?? new Set<string>()),
      ];
      throw new Error(
        `Illegal transition: '${currentStatus}' → '${newStatus}'. Allowed: ${JSON.stringify(allowed)}`,
      );
    }
  }
  await setField(projectId, itemId, "Status", newStatus);
  return true;
}

// ---------------------------------------------------------------------------
// Spec-completeness gate
// ---------------------------------------------------------------------------

export interface SpecCompletenessResult {
  complete: boolean;
  missing: string[];
}

export function checkSpecCompleteness(
  itemFields: Record<string, FieldValue | undefined>,
): SpecCompletenessResult {
  const missing: string[] = [];
  if (!itemFields["Risk"]) missing.push("Risk field is not set");
  if (!itemFields["AI Suitability"]) {
    missing.push("AI Suitability field is not set");
  }
  const risk = itemFields["Risk"];
  if (typeof risk === "string" && risk.toLowerCase() === "high") {
    if (itemFields["Spec Approval"] !== "Approved") {
      missing.push("Spec Approval required for high-risk items");
    }
  }
  return { complete: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Local config loader
// ---------------------------------------------------------------------------

export interface ProjectConfig {
  project_id?: string;
  [key: string]: unknown;
}

export function loadProjectConfig(repoRoot: string = "."): ProjectConfig | null {
  const configPath = path.join(repoRoot, ".github", "project-config.json");
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as ProjectConfig;
}
