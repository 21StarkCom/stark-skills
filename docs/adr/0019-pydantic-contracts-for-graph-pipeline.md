# ADR-0019: Pydantic Contracts for Graph Pipeline

## Status

Accepted

## Context

The stark-graph pipeline has multiple stages (parser, validator, differ, commenter) that exchange data via JSON files in a shared workdir. Each stage reads the previous stage's output and writes its own. Without a shared contract, stages can silently break when upstream output format changes.

Options considered:
1. **JSON Schema files** -- language-agnostic but no runtime validation, easy to drift from implementation
2. **Python dataclasses + manual validation** -- lightweight but no built-in serialization or constraint enforcement
3. **Pydantic v2 models** -- runtime validation, JSON serialization, schema generation, Python-native

## Decision

Use Pydantic v2 BaseModel classes as the single source of truth for all inter-stage contracts. Models defined in `scripts/graph/model.py` and imported by every stage.

Key models:
- `Graph` (nodes, edges, metadata) -- produced by parser, consumed by validator and differ
- `ValidationReport` (findings, coverage, mode) -- produced by validator, consumed by commenter
- `DiffReport` (added/removed nodes/edges, blast radius) -- produced by differ, consumed by commenter and prompt enrichment

Schema version enforcement via `Graph.reject_unknown_version()` model validator -- prevents silent consumption of incompatible data.

## Consequences

- Every stage gets free input validation -- malformed JSON fails loudly at deserialization
- Adding a field to a stage's output requires updating exactly one model class
- CI artifact handoff (Job 1 -> Job 2 in graph-review.yml) validates artifacts against Pydantic before use
- Runtime dependency on pydantic >= 2.0 (pinned in `scripts/requirements-graph.txt` with SHA256 hashes)
- Schema version field enables future major version bumps without silent breakage

## Related

- Plan: `docs/specs/2026-04-07-stark-graph-plan.md`
- Tracking: #265 (Phase 1 -- Foundation and Contracts)
