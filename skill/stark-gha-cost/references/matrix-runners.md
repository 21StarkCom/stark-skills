# When the driver is a test matrix (and when to leave GHA-hosted runners)

The single biggest CI overspends usually aren't "many small things" — they're
**one** thing (a matrix) where **per-job overhead**, not test logic, dominates.
This reference is for that case.

## Quantify first — one thing usually dominates

Pull **real per-job timings**, not vibes: `gh run view <run-id>` (and per job).
Almost always one workflow/matrix is ~80–98% of the bill and everything else is
rounding error. A real example: 660 billed min/run where the integration matrix
was **98%** (649 min across 90 jobs) — trimming web-ci/security/eval would have
been noise. **Find the Pareto driver, then optimize only that.**

## The cost function: `job_count × per-job_overhead`

Both factors are levers. And per-job overhead is usually **setup, not tests** —
often 4–5 of every 7 minutes per job is:
- minting a token,
- dependency download (`go mod download`, `npm ci`, …),
- **cold compilation** (e.g. `go run migrate up` recompiles the whole binary),
- with **zero build-cache sharing**: matrix jobs all start together → all miss
  the cache → all recompile from scratch.

So `90 jobs × ~7 min` is a *setup* cost, not a *test* cost. Attack the right
factor.

### Cut `job_count`
- **Bucket / shard down.** 90 one-container-per-package jobs → ~8 buckets can cut
  ~70% by itself. Before paying for per-job isolation, check the invariant is not
  **already defended in code** (e.g. an in-test `RestoreSchemaAfterDestructiveTest`).
  "Perfect isolation" you don't need is a luxury tax — one Postgres per package
  to prevent leakage that the code already prevents.
- **Path-filter the heavy matrix off changes it doesn't concern.** A `.github/**`
  (or repo-root) trigger-all makes *every* workflow/rename/infra PR run the full
  matrix despite touching zero product code — this is why an org-rename week can
  burn a fortune. One `paths:`/`paths-ignore:` line fixes it.

### Cut `per-job_overhead`
- **Share / warm the build cache** (`actions/cache`, or just bucketing so one job
  reuses its own warm cache) so jobs stop cold-recompiling in parallel.
- **Don't cold-compile per job.** Build once, reuse the binary; avoid `go run`
  of a heavy entrypoint in every matrix leg.
- **Template-clone databases instead of replaying migrations.** A Postgres
  template DB gives identical schema+seed instantly; a forced full-migration
  replay per test is slow *by choice* and is often why a package needs N shards.
- **Question CI configs that deliberately disable a fast path.** Slow tests
  usually have a *reversible root cause* (a disabled fast path, a forced full
  setup), not an inherent one. Find the choice, don't just parallelize around it.

## Leaving GHA-hosted runners (the biggest lever, conditionally)

The default advice — "self-hosting is rarely worth it" — **flips when you
already own idle compute.** If the project already runs on a cluster (e.g. GKE
Autopilot), self-hosted **ephemeral** runners via **Actions Runner Controller
(ARC)** take GitHub-billed minutes to **~0**. The deciding factor isn't the
minute count — it's whether you already own the compute:
- **Already own a cluster** → ARC is likely the single biggest lever. Leaving
  GHA-hosted runners beats any amount of workflow micro-optimizing.
- **Would stand up new compute just for this** → usually not worth it; you'd
  trade a GitHub bill for a GCP bill plus ops.
- **Never** self-host on **public** repos (untrusted PR code on your infra), and
  **macOS can't** be self-hosted on GCP (no Mac instances).

## Two meta-lessons for CI cost work

- **The cost-fix chicken-and-egg.** An infra/CI-changing PR often trigger-alls
  the expensive matrix, so *validating a cost reduction costs a full run*. You
  pay once to stop paying forever — sequence deliberately: land the **trigger
  narrowing first** (so later cost PRs don't re-run the matrix), and accept one
  expensive validation run when unavoidable.
- **local-green ≠ CI-green.** A warm local module/build cache can hide a problem
  CI will hit cold — e.g. a dependency that no longer resolves after a module
  move. Cost work and correctness work collide in the same CI, so a broken CI
  blocks both; fix the correctness break first or they mask each other.
