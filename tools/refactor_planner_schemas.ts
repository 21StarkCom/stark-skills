// Types, enums, and runtime validators for the refactor-planner dispatcher.
//
// No external validation library (the repo ships none — `stark_config_lib.ts`
// validates by hand, and we follow that). Every subagent output and the two
// final artifacts have a typed contract plus a `validate*` function returning a
// `ValidationResult`, so malformed LLM output is rejected loudly instead of
// silently flowing into the plan.

// ── Enums (single source of truth) ───────────────────────────────────────────

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const RISKS = ["high", "medium", "low"] as const;
export type Risk = (typeof RISKS)[number];

export const TASK_TYPES = [
  "test", "move", "rename", "delete", "merge", "replace", "architecture", "config", "docs",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

// The plan's duplicate table allows movement verbs; the backlog's duplicate
// block is intentionally narrower (it records the canonical-collapse decision).
export const DUP_TABLE_ACTIONS = ["delete", "merge", "rename", "move", "replace", "keep"] as const;
export type DupTableAction = (typeof DUP_TABLE_ACTIONS)[number];

export const DUP_BACKLOG_ACTIONS = ["delete", "merge", "replace", "keep"] as const;
export type DupBacklogAction = (typeof DUP_BACKLOG_ACTIONS)[number];

export const TASK_STATUSES = ["planned"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

// ── Validation primitives ────────────────────────────────────────────────────

/**
 * Discriminated union so a successful `ok` soundly narrows `value` to `T` — a
 * caller that checks `result.ok` no longer has to cast or guard against
 * `undefined` (finding #11).
 */
export type ValidationResult<T> =
  | { ok: true; value: T; errors: string[]; warnings: string[] }
  | { ok: false; value?: undefined; errors: string[]; warnings: string[] };

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isString(v: unknown): v is string {
  return typeof v === "string";
}

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function oneOf<T extends readonly string[]>(
  v: unknown,
  allowed: T,
): v is T[number] {
  return typeof v === "string" && (allowed as readonly string[]).includes(v);
}

/** Small accumulator that records a problem under a JSON-pointer-ish path. */
class Checker {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];

  str(obj: Record<string, unknown>, key: string, at: string): string {
    const v = obj[key];
    if (!isString(v)) {
      this.errors.push(`${at}.${key} must be a string`);
      return "";
    }
    return v;
  }

  strArr(obj: Record<string, unknown>, key: string, at: string): string[] {
    const v = obj[key];
    if (!isStringArray(v)) {
      this.errors.push(`${at}.${key} must be a string[]`);
      return [];
    }
    return v;
  }

  enum<T extends readonly string[]>(
    obj: Record<string, unknown>,
    key: string,
    allowed: T,
    at: string,
  ): T[number] {
    const v = obj[key];
    if (!oneOf(v, allowed)) {
      this.errors.push(`${at}.${key} must be one of ${allowed.join(" | ")} (got ${JSON.stringify(v)})`);
      return allowed[0];
    }
    return v;
  }

  array(obj: Record<string, unknown>, key: string, at: string): unknown[] {
    const v = obj[key];
    if (!Array.isArray(v)) {
      this.errors.push(`${at}.${key} must be an array`);
      return [];
    }
    return v;
  }
}

// ── Repository discovery (deterministic, host-produced) ──────────────────────

export interface CommandSet {
  install_command: string;
  test_command: string;
  lint_command: string;
  typecheck_command: string;
  build_command: string;
  format_command: string;
}

export interface FileFact {
  path: string;
  loc: number;
  ext: string;
}

export interface ImportEdge {
  from: string;
  to: string;
}

export interface TodoMarker {
  path: string;
  line: number;
  marker: string;
  text: string;
}

export interface RepoInventory {
  root: string;
  git: { isRepo: boolean; head: string | null; dirty: string[] };
  languages: string[];
  package_managers: string[];
  frameworks: string[];
  entry_points: string[];
  build_files: string[];
  config_files: string[];
  test_files: string[];
  ci_files: string[];
  docs: string[];
  generated_or_vendored_paths: string[];
  largest_files: FileFact[];
  todo_markers: TodoMarker[];
  import_edges: ImportEdge[];
  /** Best-effort, deterministically derived; the command-discovery agent refines. */
  commands: CommandSet;
  file_count: number;
  /** Every non-excluded repo-relative file path (sorted). Backs the path-existence gate. */
  all_paths: string[];
  directory_tree: string;
}

// ── Context packs ────────────────────────────────────────────────────────────

export interface ContextFile {
  path: string;
  purpose?: string;
  content?: string;
  excerpt?: string;
  summary?: string;
}

export interface CommandOutput {
  command: string;
  output: string;
  truncated?: boolean;
}

export interface ContextPack {
  id: string;
  agentName: AgentName;
  task: string;
  files: ContextFile[];
  commandOutputs: CommandOutput[];
  constraints: string[];
  /** Name of the expected output schema (keys of OUTPUT_VALIDATORS). */
  expectedSchema: AgentName;
  expectedOutput: "json" | "markdown";
}

// ── Subagent identity ────────────────────────────────────────────────────────

export const AGENT_NAMES = [
  "repository-inventory",
  "command-discovery",
  "architecture",
  "dependency-health",
  "duplication",
  "dead-code",
  "test-risk",
  "target-architecture",
  "phase-planner",
  "artifact-synthesis",
] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

// ── Subagent output contracts ────────────────────────────────────────────────

export interface InventoryOutput {
  language: string;
  frameworks: string[];
  package_manager: string;
  entry_points: string[];
  build_files: string[];
  test_files: string[];
  config_files: string[];
  ci_files: string[];
  docs: string[];
  generated_or_vendored_paths: string[];
  summary: string;
}

export interface CommandDiscoveryOutput {
  install_command: string;
  test_command: string;
  lint_command: string;
  typecheck_command: string;
  build_command: string;
  format_command: string;
  evidence: string[];
}

export interface ArchitectureOutput {
  current_architecture: string;
  runtime_flow: string[];
  dependency_flow: string[];
  main_modules: string[];
  api_or_interface_layers: string[];
  domain_modules: string[];
  infrastructure_modules: string[];
  shared_utilities: string[];
  external_integrations: string[];
  configuration_flow: string[];
  test_organization: string[];
  architecture_risks: string[];
}

export interface DependencyIssue {
  id: string;
  severity: Severity;
  paths: string[];
  problem: string;
  evidence: string[];
  recommended_fix: string;
}
export interface DependencyHealthOutput {
  dependency_issues: DependencyIssue[];
}

export interface DuplicateFinding {
  id: string;
  paths: string[];
  symbols: string[];
  duplicate_or_overlap: string;
  canonical_replacement: string;
  action: DupTableAction;
  call_sites_to_update: string[];
  evidence: string[];
}
export interface DuplicationOutput {
  duplicates: DuplicateFinding[];
}

export interface DeadCodeFinding {
  id: string;
  path: string;
  symbol_or_file: string;
  evidence: string[];
  recommended_action: string;
  risk: Risk;
}
export interface DeadCodeOutput {
  dead_or_suspicious_code: DeadCodeFinding[];
}

export interface TestGap {
  path: string;
  gap: string;
  recommended_test: string;
  risk: Risk;
}
export interface RiskyArea {
  path: string;
  reason: string;
  required_tests_before_refactor: string[];
}
export interface TestRiskOutput {
  test_gaps: TestGap[];
  risky_areas: RiskyArea[];
  safety_baseline: string[];
}

export interface TargetDirectory {
  path: string;
  responsibility: string;
  belongs_here: string[];
  does_not_belong_here: string[];
  allowed_dependencies: string[];
  forbidden_dependencies: string[];
}
export interface TargetArchitectureOutput {
  target_directories: TargetDirectory[];
  target_tree: string;
  rationale: string[];
}

export interface RefactorPhase {
  number: number;
  name: string;
  goal: string;
  actions: string[];
  affected_paths: string[];
  validation_commands: string[];
  rollback: string;
  risk: Risk;
}
export interface PhasePlannerOutput {
  phases: RefactorPhase[];
}

/**
 * Aggregate of every subagent's validated output. Each slot is optional: an
 * agent that fails validation or dies leaves its slot undefined, and the
 * synthesizer degrades gracefully rather than aborting the whole plan.
 */
export interface AnalysisFindings {
  inventory?: InventoryOutput;
  commands?: CommandDiscoveryOutput;
  architecture?: ArchitectureOutput;
  dependencyHealth?: DependencyHealthOutput;
  duplication?: DuplicationOutput;
  deadCode?: DeadCodeOutput;
  testRisk?: TestRiskOutput;
  targetArchitecture?: TargetArchitectureOutput;
  phases?: PhasePlannerOutput;
}

// ── Final artifacts ──────────────────────────────────────────────────────────

export interface BacklogSummary {
  language: string;
  framework: string;
  package_manager: string;
  install_command: string;
  test_command: string;
  build_command: string;
  lint_command: string;
  typecheck_command: string;
}
export interface BacklogTargetDirectory {
  path: string;
  responsibility: string;
  allowed_dependencies: string[];
  forbidden_dependencies: string[];
}
export interface BacklogTask {
  id: string;
  title: string;
  type: TaskType;
  severity: Severity;
  risk: Risk;
  status: TaskStatus;
  paths: string[];
  symbols: string[];
  description: string;
  evidence: string[];
  implementation_steps: string[];
  depends_on: string[];
  validation_commands: string[];
  rollback_plan: string;
}
export interface BacklogDuplicate {
  id: string;
  paths: string[];
  symbols: string[];
  canonical_path: string;
  action: DupBacklogAction;
  reason: string;
  evidence: string[];
}
export interface BacklogRiskyArea {
  path: string;
  reason: string;
  required_tests_before_refactor: string[];
}
export interface RefactorBacklog {
  summary: BacklogSummary;
  target_architecture: { directories: BacklogTargetDirectory[] };
  tasks: BacklogTask[];
  duplicates: BacklogDuplicate[];
  risky_areas: BacklogRiskyArea[];
}

// ── Host-assembled plan model (source of truth for both artifacts) ───────────

export interface ProblemRow {
  id: string;
  severity: Severity;
  area: string;
  paths: string[];
  problem: string;
  evidence: string[];
  why_it_matters: string;
  recommended_fix: string;
}

export interface Conflict {
  kind: string;
  detail: string;
  resolution: string;
}

export interface FirstPr {
  title: string;
  goal: string;
  files: string[];
  steps: string[];
  validation: string[];
  why_low_risk: string;
}

/**
 * The deterministic assembly the host builds from validated agent findings.
 * Both REFACTOR_PLAN.md and REFACTOR_BACKLOG.json render from this single model,
 * so the two artifacts can never drift. Structured fields are host-owned (and
 * gate-validated); prose fields are filled from the synthesis agent when present.
 */
export interface PlanModel {
  summary: BacklogSummary;
  architectural_style: string;
  main_risk_areas: string[];
  inventory: RepoInventory;
  architecture?: ArchitectureOutput;
  current_architecture_narrative: string;
  problems: ProblemRow[];
  duplicates_table: DuplicateFinding[];
  dead_code: DeadCodeFinding[];
  target_architecture?: TargetArchitectureOutput;
  phases: RefactorPhase[];
  tasks: BacklogTask[];
  duplicates_backlog: BacklogDuplicate[];
  risky_areas: BacklogRiskyArea[];
  conventions: string[];
  first_pr: FirstPr;
  open_questions: string[];
  conflicts: Conflict[];
}

// ── Subagent output validators ───────────────────────────────────────────────

function fail<T>(errors: string[]): ValidationResult<T> {
  return { ok: false, errors, warnings: [] };
}
function done<T>(value: T, c: Checker): ValidationResult<T> {
  return c.errors.length === 0
    ? { ok: true, value, errors: [], warnings: c.warnings }
    : { ok: false, errors: c.errors, warnings: c.warnings };
}

export function validateInventory(v: unknown): ValidationResult<InventoryOutput> {
  if (!isPlainObject(v)) return fail(["inventory output is not an object"]);
  const c = new Checker();
  const out: InventoryOutput = {
    language: c.str(v, "language", "inventory"),
    frameworks: c.strArr(v, "frameworks", "inventory"),
    package_manager: c.str(v, "package_manager", "inventory"),
    entry_points: c.strArr(v, "entry_points", "inventory"),
    build_files: c.strArr(v, "build_files", "inventory"),
    test_files: c.strArr(v, "test_files", "inventory"),
    config_files: c.strArr(v, "config_files", "inventory"),
    ci_files: c.strArr(v, "ci_files", "inventory"),
    docs: c.strArr(v, "docs", "inventory"),
    generated_or_vendored_paths: c.strArr(v, "generated_or_vendored_paths", "inventory"),
    summary: c.str(v, "summary", "inventory"),
  };
  return done(out, c);
}

export function validateCommandDiscovery(v: unknown): ValidationResult<CommandDiscoveryOutput> {
  if (!isPlainObject(v)) return fail(["command-discovery output is not an object"]);
  const c = new Checker();
  const out: CommandDiscoveryOutput = {
    install_command: c.str(v, "install_command", "commands"),
    test_command: c.str(v, "test_command", "commands"),
    lint_command: c.str(v, "lint_command", "commands"),
    typecheck_command: c.str(v, "typecheck_command", "commands"),
    build_command: c.str(v, "build_command", "commands"),
    format_command: c.str(v, "format_command", "commands"),
    evidence: c.strArr(v, "evidence", "commands"),
  };
  return done(out, c);
}

export function validateArchitecture(v: unknown): ValidationResult<ArchitectureOutput> {
  if (!isPlainObject(v)) return fail(["architecture output is not an object"]);
  const c = new Checker();
  const out: ArchitectureOutput = {
    current_architecture: c.str(v, "current_architecture", "architecture"),
    runtime_flow: c.strArr(v, "runtime_flow", "architecture"),
    dependency_flow: c.strArr(v, "dependency_flow", "architecture"),
    main_modules: c.strArr(v, "main_modules", "architecture"),
    api_or_interface_layers: c.strArr(v, "api_or_interface_layers", "architecture"),
    domain_modules: c.strArr(v, "domain_modules", "architecture"),
    infrastructure_modules: c.strArr(v, "infrastructure_modules", "architecture"),
    shared_utilities: c.strArr(v, "shared_utilities", "architecture"),
    external_integrations: c.strArr(v, "external_integrations", "architecture"),
    configuration_flow: c.strArr(v, "configuration_flow", "architecture"),
    test_organization: c.strArr(v, "test_organization", "architecture"),
    architecture_risks: c.strArr(v, "architecture_risks", "architecture"),
  };
  return done(out, c);
}

export function validateDependencyHealth(v: unknown): ValidationResult<DependencyHealthOutput> {
  if (!isPlainObject(v)) return fail(["dependency-health output is not an object"]);
  const c = new Checker();
  const raw = c.array(v, "dependency_issues", "dependency-health");
  const issues: DependencyIssue[] = raw.map((item, i) => {
    const at = `dependency_issues[${i}]`;
    if (!isPlainObject(item)) { c.errors.push(`${at} must be an object`); return blankDepIssue(); }
    return {
      id: c.str(item, "id", at),
      severity: c.enum(item, "severity", SEVERITIES, at),
      paths: c.strArr(item, "paths", at),
      problem: c.str(item, "problem", at),
      evidence: c.strArr(item, "evidence", at),
      recommended_fix: c.str(item, "recommended_fix", at),
    };
  });
  return done({ dependency_issues: issues }, c);
}
function blankDepIssue(): DependencyIssue {
  return { id: "", severity: "low", paths: [], problem: "", evidence: [], recommended_fix: "" };
}

export function validateDuplication(v: unknown): ValidationResult<DuplicationOutput> {
  if (!isPlainObject(v)) return fail(["duplication output is not an object"]);
  const c = new Checker();
  const raw = c.array(v, "duplicates", "duplication");
  const dups: DuplicateFinding[] = raw.map((item, i) => {
    const at = `duplicates[${i}]`;
    if (!isPlainObject(item)) { c.errors.push(`${at} must be an object`); return blankDup(); }
    return {
      id: c.str(item, "id", at),
      paths: c.strArr(item, "paths", at),
      symbols: c.strArr(item, "symbols", at),
      duplicate_or_overlap: c.str(item, "duplicate_or_overlap", at),
      canonical_replacement: c.str(item, "canonical_replacement", at),
      action: c.enum(item, "action", DUP_TABLE_ACTIONS, at),
      call_sites_to_update: c.strArr(item, "call_sites_to_update", at),
      evidence: c.strArr(item, "evidence", at),
    };
  });
  return done({ duplicates: dups }, c);
}
function blankDup(): DuplicateFinding {
  return { id: "", paths: [], symbols: [], duplicate_or_overlap: "", canonical_replacement: "", action: "keep", call_sites_to_update: [], evidence: [] };
}

export function validateDeadCode(v: unknown): ValidationResult<DeadCodeOutput> {
  if (!isPlainObject(v)) return fail(["dead-code output is not an object"]);
  const c = new Checker();
  const raw = c.array(v, "dead_or_suspicious_code", "dead-code");
  const items: DeadCodeFinding[] = raw.map((item, i) => {
    const at = `dead_or_suspicious_code[${i}]`;
    if (!isPlainObject(item)) { c.errors.push(`${at} must be an object`); return blankDead(); }
    return {
      id: c.str(item, "id", at),
      path: c.str(item, "path", at),
      symbol_or_file: c.str(item, "symbol_or_file", at),
      evidence: c.strArr(item, "evidence", at),
      recommended_action: c.str(item, "recommended_action", at),
      risk: c.enum(item, "risk", RISKS, at),
    };
  });
  return done({ dead_or_suspicious_code: items }, c);
}
function blankDead(): DeadCodeFinding {
  return { id: "", path: "", symbol_or_file: "", evidence: [], recommended_action: "", risk: "low" };
}

export function validateTestRisk(v: unknown): ValidationResult<TestRiskOutput> {
  if (!isPlainObject(v)) return fail(["test-risk output is not an object"]);
  const c = new Checker();
  const gapsRaw = c.array(v, "test_gaps", "test-risk");
  const test_gaps: TestGap[] = gapsRaw.map((item, i) => {
    const at = `test_gaps[${i}]`;
    if (!isPlainObject(item)) { c.errors.push(`${at} must be an object`); return { path: "", gap: "", recommended_test: "", risk: "low" as Risk }; }
    return { path: c.str(item, "path", at), gap: c.str(item, "gap", at), recommended_test: c.str(item, "recommended_test", at), risk: c.enum(item, "risk", RISKS, at) };
  });
  const riskyRaw = c.array(v, "risky_areas", "test-risk");
  const risky_areas: RiskyArea[] = riskyRaw.map((item, i) => {
    const at = `risky_areas[${i}]`;
    if (!isPlainObject(item)) { c.errors.push(`${at} must be an object`); return { path: "", reason: "", required_tests_before_refactor: [] }; }
    return { path: c.str(item, "path", at), reason: c.str(item, "reason", at), required_tests_before_refactor: c.strArr(item, "required_tests_before_refactor", at) };
  });
  return done({ test_gaps, risky_areas, safety_baseline: c.strArr(v, "safety_baseline", "test-risk") }, c);
}

export function validateTargetArchitecture(v: unknown): ValidationResult<TargetArchitectureOutput> {
  if (!isPlainObject(v)) return fail(["target-architecture output is not an object"]);
  const c = new Checker();
  const raw = c.array(v, "target_directories", "target-architecture");
  const dirs: TargetDirectory[] = raw.map((item, i) => {
    const at = `target_directories[${i}]`;
    if (!isPlainObject(item)) { c.errors.push(`${at} must be an object`); return blankTargetDir(); }
    return {
      path: c.str(item, "path", at),
      responsibility: c.str(item, "responsibility", at),
      belongs_here: c.strArr(item, "belongs_here", at),
      does_not_belong_here: c.strArr(item, "does_not_belong_here", at),
      allowed_dependencies: c.strArr(item, "allowed_dependencies", at),
      forbidden_dependencies: c.strArr(item, "forbidden_dependencies", at),
    };
  });
  return done({ target_directories: dirs, target_tree: c.str(v, "target_tree", "target-architecture"), rationale: c.strArr(v, "rationale", "target-architecture") }, c);
}
function blankTargetDir(): TargetDirectory {
  return { path: "", responsibility: "", belongs_here: [], does_not_belong_here: [], allowed_dependencies: [], forbidden_dependencies: [] };
}

export function validatePhasePlanner(v: unknown): ValidationResult<PhasePlannerOutput> {
  if (!isPlainObject(v)) return fail(["phase-planner output is not an object"]);
  const c = new Checker();
  const raw = c.array(v, "phases", "phase-planner");
  const phases: RefactorPhase[] = raw.map((item, i) => {
    const at = `phases[${i}]`;
    if (!isPlainObject(item)) { c.errors.push(`${at} must be an object`); return blankPhase(); }
    const num = item.number;
    if (typeof num !== "number") c.errors.push(`${at}.number must be a number`);
    return {
      number: typeof num === "number" ? num : i + 1,
      name: c.str(item, "name", at),
      goal: c.str(item, "goal", at),
      actions: c.strArr(item, "actions", at),
      affected_paths: c.strArr(item, "affected_paths", at),
      validation_commands: c.strArr(item, "validation_commands", at),
      rollback: c.str(item, "rollback", at),
      risk: c.enum(item, "risk", RISKS, at),
    };
  });
  return done({ phases }, c);
}
function blankPhase(): RefactorPhase {
  return { number: 0, name: "", goal: "", actions: [], affected_paths: [], validation_commands: [], rollback: "", risk: "low" };
}

/** Maps an agent name to its output validator. Used by the normalizer. */
export const OUTPUT_VALIDATORS: Record<Exclude<AgentName, "artifact-synthesis">, (v: unknown) => ValidationResult<unknown>> = {
  "repository-inventory": validateInventory,
  "command-discovery": validateCommandDiscovery,
  "architecture": validateArchitecture,
  "dependency-health": validateDependencyHealth,
  "duplication": validateDuplication,
  "dead-code": validateDeadCode,
  "test-risk": validateTestRisk,
  "target-architecture": validateTargetArchitecture,
  "phase-planner": validatePhasePlanner,
};

// ── Final backlog validator (the gate) ───────────────────────────────────────

const RF_ID = /^RF-\d{3,}$/;
const DUP_ID = /^DUP-\d{3,}$/;

/**
 * Validate a parsed REFACTOR_BACKLOG.json object. Beyond shape/enum checks this
 * enforces the two things an executor depends on and an LLM gets wrong:
 *  - task `depends_on` references resolve and form a DAG (no deadlock cycles);
 *  - ids are unique and well-formed.
 * When `existingPaths` is supplied, a referenced SOURCE path that doesn't exist
 * is a hard error for path-dependent task types (delete/merge/rename/move) — the
 * thing being moved/removed must exist — and a warning for other types (which
 * legitimately name new target paths).
 */
const PATH_MUST_EXIST_TYPES = new Set<TaskType>(["delete", "merge", "rename", "move"]);

export function validateBacklog(v: unknown, existingPaths?: Set<string>): ValidationResult<RefactorBacklog> {
  if (!isPlainObject(v)) return fail(["backlog is not a JSON object"]);
  const c = new Checker();

  // summary
  const summary = isPlainObject(v.summary) ? v.summary : (c.errors.push("summary must be an object"), {});
  const sm: BacklogSummary = {
    language: c.str(summary, "language", "summary"),
    framework: c.str(summary, "framework", "summary"),
    package_manager: c.str(summary, "package_manager", "summary"),
    install_command: c.str(summary, "install_command", "summary"),
    test_command: c.str(summary, "test_command", "summary"),
    build_command: c.str(summary, "build_command", "summary"),
    lint_command: c.str(summary, "lint_command", "summary"),
    typecheck_command: c.str(summary, "typecheck_command", "summary"),
  };

  // target_architecture
  const ta = isPlainObject(v.target_architecture) ? v.target_architecture : (c.errors.push("target_architecture must be an object"), {});
  const dirsRaw = Array.isArray(ta.directories) ? ta.directories : (c.errors.push("target_architecture.directories must be an array"), []);
  const directories: BacklogTargetDirectory[] = dirsRaw.map((d, i) => {
    const at = `target_architecture.directories[${i}]`;
    if (!isPlainObject(d)) { c.errors.push(`${at} must be an object`); return { path: "", responsibility: "", allowed_dependencies: [], forbidden_dependencies: [] }; }
    return {
      path: c.str(d, "path", at),
      responsibility: c.str(d, "responsibility", at),
      allowed_dependencies: c.strArr(d, "allowed_dependencies", at),
      forbidden_dependencies: c.strArr(d, "forbidden_dependencies", at),
    };
  });

  // tasks
  const tasksRaw = Array.isArray(v.tasks) ? v.tasks : (c.errors.push("tasks must be an array"), []);
  const seenTaskIds = new Set<string>();
  const tasks: BacklogTask[] = tasksRaw.map((t, i) => {
    const at = `tasks[${i}]`;
    if (!isPlainObject(t)) { c.errors.push(`${at} must be an object`); return blankTask(); }
    const id = c.str(t, "id", at);
    const expectedId = `RF-${String(i + 1).padStart(3, "0")}`;
    if (!id) c.errors.push(`${at}.id must be a non-empty string`);
    else if (!RF_ID.test(id)) c.errors.push(`${at}.id '${id}' must match RF-NNN`);
    // sequential, 1-based, no gaps (the advertised contract — finding #8/#9/#10)
    else if (id !== expectedId) c.errors.push(`${at}.id '${id}' must be sequential: expected '${expectedId}' at position ${i}`);
    if (id && seenTaskIds.has(id)) c.errors.push(`${at}.id '${id}' is duplicated`);
    if (id) seenTaskIds.add(id);
    const task: BacklogTask = {
      id,
      title: c.str(t, "title", at),
      type: c.enum(t, "type", TASK_TYPES, at),
      severity: c.enum(t, "severity", SEVERITIES, at),
      risk: c.enum(t, "risk", RISKS, at),
      status: c.enum(t, "status", TASK_STATUSES, at),
      paths: c.strArr(t, "paths", at),
      symbols: c.strArr(t, "symbols", at),
      description: c.str(t, "description", at),
      evidence: c.strArr(t, "evidence", at),
      implementation_steps: c.strArr(t, "implementation_steps", at),
      depends_on: c.strArr(t, "depends_on", at),
      validation_commands: c.strArr(t, "validation_commands", at),
      rollback_plan: c.str(t, "rollback_plan", at),
    };
    return task;
  });

  // depends_on references resolve + DAG
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!seenTaskIds.has(dep)) c.errors.push(`task ${t.id} depends_on unknown task '${dep}'`);
    }
  }
  const cycle = findCycle(tasks);
  if (cycle) c.errors.push(`tasks.depends_on contains a cycle: ${cycle.join(" -> ")}`);

  // path existence: a hard gate for source-must-exist actions, a warning otherwise
  if (existingPaths) {
    for (const t of tasks) {
      for (const p of t.paths) {
        if (!p || existingPaths.has(p)) continue;
        if (PATH_MUST_EXIST_TYPES.has(t.type)) {
          c.errors.push(`task ${t.id} (${t.type}) references source path '${p}' which does not exist in the repo`);
        } else {
          c.warnings.push(`task ${t.id} references path '${p}' which does not exist in the repo`);
        }
      }
    }
  }

  // duplicates
  const dupsRaw = Array.isArray(v.duplicates) ? v.duplicates : (c.errors.push("duplicates must be an array"), []);
  const seenDupIds = new Set<string>();
  const duplicates: BacklogDuplicate[] = dupsRaw.map((d, i) => {
    const at = `duplicates[${i}]`;
    if (!isPlainObject(d)) { c.errors.push(`${at} must be an object`); return blankBacklogDup(); }
    const id = c.str(d, "id", at);
    const expectedId = `DUP-${String(i + 1).padStart(3, "0")}`;
    if (!id) c.errors.push(`${at}.id must be a non-empty string`);
    else if (!DUP_ID.test(id)) c.errors.push(`${at}.id '${id}' must match DUP-NNN`);
    else if (id !== expectedId) c.errors.push(`${at}.id '${id}' must be sequential: expected '${expectedId}' at position ${i}`);
    if (id && seenDupIds.has(id)) c.errors.push(`${at}.id '${id}' is duplicated`);
    if (id) seenDupIds.add(id);
    return {
      id,
      paths: c.strArr(d, "paths", at),
      symbols: c.strArr(d, "symbols", at),
      canonical_path: c.str(d, "canonical_path", at),
      action: c.enum(d, "action", DUP_BACKLOG_ACTIONS, at),
      reason: c.str(d, "reason", at),
      evidence: c.strArr(d, "evidence", at),
    };
  });

  // risky_areas
  const riskyRaw = Array.isArray(v.risky_areas) ? v.risky_areas : (c.errors.push("risky_areas must be an array"), []);
  const risky_areas: BacklogRiskyArea[] = riskyRaw.map((r, i) => {
    const at = `risky_areas[${i}]`;
    if (!isPlainObject(r)) { c.errors.push(`${at} must be an object`); return { path: "", reason: "", required_tests_before_refactor: [] }; }
    return { path: c.str(r, "path", at), reason: c.str(r, "reason", at), required_tests_before_refactor: c.strArr(r, "required_tests_before_refactor", at) };
  });

  const backlog: RefactorBacklog = { summary: sm, target_architecture: { directories }, tasks, duplicates, risky_areas };
  return done(backlog, c);
}

function blankTask(): BacklogTask {
  return { id: "", title: "", type: "docs", severity: "low", risk: "low", status: "planned", paths: [], symbols: [], description: "", evidence: [], implementation_steps: [], depends_on: [], validation_commands: [], rollback_plan: "" };
}
function blankBacklogDup(): BacklogDuplicate {
  return { id: "", paths: [], symbols: [], canonical_path: "", action: "keep", reason: "", evidence: [] };
}

/** DFS cycle detection over task.depends_on. Returns the cycle path or null. */
function findCycle(tasks: BacklogTask[]): string[] | null {
  const adj = new Map<string, string[]>();
  for (const t of tasks) adj.set(t.id, t.depends_on.filter((d) => d));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of adj.keys()) color.set(id, WHITE);
  const stack: string[] = [];

  const dfs = (u: string): string[] | null => {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      if (!adj.has(v)) continue; // unknown dep already reported as an error
      const cv = color.get(v);
      if (cv === GRAY) {
        const idx = stack.indexOf(v);
        return [...stack.slice(idx), v];
      }
      if (cv === WHITE) {
        const found = dfs(v);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(u, BLACK);
    return null;
  };

  for (const id of adj.keys()) {
    if (color.get(id) === WHITE) {
      const found = dfs(id);
      if (found) return found;
    }
  }
  return null;
}
