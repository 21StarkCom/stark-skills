# stark-release — Internals

Cut a new release — reviews unreleased CHANGELOG entries, bumps version (patch/minor/major), creates git tag, and optionally creates a GitHub Release with notes. Use when the user says "release", "cut a version", "tag a release", "bump version", or invokes /stark-release.

## Architecture

```mermaid
graph TD
  Start([Start Release Command]) --> PreFlight{On clean main branch?}
  
  PreFlight -->|No| Abort1[Abort: Prompt user to checkout main/commit]
  PreFlight -->|Yes| GitTag[Get Latest Git Tag]
  
  GitTag --> ParseCL[Parse CHANGELOG.md]
  
  ParseCL --> HasChanges{Has Unreleased changes?}
  HasChanges -->|No| Abort2[Abort: Nothing to release]
  
  HasChanges -->|Yes| BumpDecision{Argument provided?}
  
  BumpDecision -->|Yes| UseArg[Use Provided Bump: patch/minor/major]
  BumpDecision -->|No| AutoCalc[Auto-calculate: Add=minor, Fix=patch]
  
  UseArg --> CalcNext[Calculate Next Version vX.Y.Z]
  AutoCalc --> CalcNext
  
  CalcNext --> MutateInit[Update src/infra_pulse/__init__.py]
  MutateInit --> MutateCL[Move Unreleased to versioned section in CHANGELOG]
  
  MutateCL --> Commit[git commit both files]
  Commit --> Tag[git tag -a vX.Y.Z]
  
  Tag --> Push[git push origin main & tag]
  Push -->|Fails| Rebase[git pull --rebase & retry]
  Push -->|Success| GHRelease[gh release create vX.Y.Z]
  
  GHRelease --> Summary([Print Success Summary])
```

![Internal architecture visualization for the stark-release skill showing the 10-step sequence from git pre-flight validation, semantic version calculation, file mutations, to GitHub release creation, alongside failure modes and observability metrics.](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-release/SKILL.md`, then run `/stark-generate-docs --skill stark-release` to regenerate documentation.
