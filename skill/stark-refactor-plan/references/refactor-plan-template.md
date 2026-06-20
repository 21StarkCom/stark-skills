# `REFACTOR_PLAN.md` — exact structure

Produce a practical, implementation-oriented Markdown plan using this exact
section order and these exact table columns. Fill every section with real paths,
symbols, and commands discovered during analysis. Keep prose tight — this is a
work order for another agent, not an essay.

````md
# Refactor Plan

## 1. Repository Summary

- Detected language/framework:
- Package/build system:
- Main entry points:
- Install command:
- Test command:
- Typecheck command:
- Lint command:
- Build command:
- Current architectural style:
- Main risk areas:

## 2. Current Structure

Describe the current repository structure using actual paths. Include a
directory map with comments:

```text
path/
  file.ext  # purpose
```

## 3. Current Architecture

Explain the architecture **as implemented, not as intended**. Cover: runtime
flow, dependency flow, main modules, shared utilities, external integrations,
configuration flow, test organization.

## 4. Problems Found

| ID | Severity | Area | Path(s) | Problem | Evidence | Why It Matters | Recommended Fix |
| -- | -------- | ---- | ------- | ------- | -------- | -------------- | --------------- |

Severity ∈ { Critical, High, Medium, Low }.

## 5. Redundant / Duplicate Code

| ID | Path | Symbol | Duplicate / Overlap | Evidence | Canonical Replacement | Action | Call Sites To Update |
| -- | ---- | ------ | ------------------- | -------- | --------------------- | ------ | -------------------- |

Action ∈ { Delete, Merge, Rename, Move, Replace, Keep }.

## 6. Dead or Suspicious Code

| ID | Path | Symbol / File | Evidence | Recommended Action | Risk |
| -- | ---- | ------------- | -------- | ------------------ | ---- |

Evidence must reference actual search results, imports, exports, call sites, or
the *lack* of references (e.g. "0 hits for `oldHelper(` across the repo").

## 7. Proposed Target Architecture

Provide the recommended target directory tree:

```text
src/
  ...
tests/
  ...
```

For every proposed top-level directory, state: responsibility, what belongs
there, what does not, allowed dependencies, forbidden dependencies.

## 8. Refactor Phases

A safe, phased implementation plan. Each phase uses this structure:

### Phase N: Name

**Goal:**
...

**Actions:**

1. ...
2. ...

**Affected paths:**

- ...

**Validation:**

```bash
...
```

**Rollback:**
...

**Risk:** Low / Medium / High

Required phases, in order:

1. Safety baseline
2. Test coverage before movement
3. Directory/module reorganization
4. Deduplication
5. Dependency cleanup
6. Configuration cleanup
7. Test cleanup
8. Documentation and final validation

## 9. File-by-File Execution Plan

| Step | Path | Action | Details | Depends On | Validation | Risk |
| ---- | ---- | ------ | ------- | ---------- | ---------- | ---- |

Each row must be specific enough for a coding agent to execute without
guessing.

> Bad: "Clean up utils."
> Good: "Move `src/helpers/date.ts` into `src/shared/date/date-utils.ts`,
> replace imports in `src/api/orders.ts` and `src/jobs/sync.ts`, then delete the
> old file after tests pass."

## 10. New Coding Conventions

Define conventions for: directory ownership, file naming, function naming, class
naming, module boundaries, import rules, error handling, logging, configuration,
testing, shared utilities, dependency direction.

## 11. Validation Strategy

The commands that must pass after each phase — use the repo's **real** commands:

```bash
# install
# lint
# typecheck
# test
# build
```

Mark any unavailable command `unknown` and explain why.

## 12. First PR Recommendation

The first safe pull request. Include: PR title, goal, files changed, exact
steps, validation commands, and why it's low risk.

## 13. Do-Not-Touch-Yet Areas

| Path | Reason | Required Safety Work First |
| ---- | ------ | -------------------------- |

## 14. Open Questions

Only questions that *block* safe implementation. No generic or non-blocking
questions.
````
