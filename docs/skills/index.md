# Skill Documentation Index

| Skill | Description | Docs |
|-------|-------------|------|
| `/stark-design` | Use this skill when the user wants to create a design document, spec, or architecture doc from requirements, a feature description, or a high-level prompt. Triggers whenever someone needs to go from an idea or set of requirements to a formal design. Covers requests like "design this feature", "write a spec for", "create an architecture doc", "I need a design document for", or any variation where input is requirements/prompt and desired output is a design/spec document. Also triggers on `/stark-design <prompt-or-path>`. Works by dispatching 3 independent AI agents to each produce a design, then cross-reviewing all designs to synthesize the best one. This is the natural first step before design review (`/stark-review-design`). | [usage.md](stark-design/usage.md) · [internals.md](stark-design/internals.md) |
