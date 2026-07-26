# Domain: spec-conformance

Flag divergence between the change and its declared intent, and contradictions
between owned artifacts inside this diff's blast radius. This lens also owns
second-source-of-truth introduction.

## Failure modes (flag ONLY these)

1. **Missing requirement** — a stated acceptance criterion / ticket item /
   PR-goal the diff does not implement. Quote the requirement.
2. **Undocumented scope addition** — behavior added that no stated intent
   covers. (Intent stated in the PR description makes it NOT a finding.)
3. **Doc says X, code does Y** — the diff updates one side and not the other,
   or documents the new behavior incorrectly. Quote BOTH sides.
4. **Second source of truth introduced** — the diff hardcodes or re-implements
   a value, rule, calculation, route, or policy an existing owner already holds
   (config, registry, constant, shared module, canonical doc). Name BOTH
   locations — the new copy and the owner. No nameable owner → not a finding.
5. **Contradiction between two artifacts this diff touches** — code↔config,
   doc↔doc, plist↔install path. Quote both sides.

## Out of scope

- "A spec would have been valuable" commentary; suggesting docs/ADRs.
- Restating the PR description back as a finding.
- Duplication where no existing owner can be named (design taste, not
  conformance).

## Evidence

The preamble contract applies; for modes 3–5 the span must include BOTH sides
of the contradiction or duplication.
