# Verification Gates

These gates are **language-agnostic in concept** but **TypeScript-first in mechanics** — this
repo and most stark-copilot targets are TypeScript (run via `node --experimental-strip-types`),
with some Go. Each gate below states the concept, then gives concrete commands for TypeScript
(primary) and Go (secondary). For any other language, apply the same gate concepts with the
project's native toolchain (build, symbol-existence, interface-match, tests).

## Step Verification (§2e): Verify the approved diff before applying

Before applying, the lead's approved diff must pass these gates in the lead's worktree. A failure here means either burning one more dispatcher round with the gate failure as a finding, or stopping the run.

### Gate 1: Build / import check

**Concept:** Every new or modified module must compile and load without error. This catches the
single most common autonomous-build failure: cross-module interface mismatches (calling
constructors with wrong args, importing names that don't exist).

**TypeScript** — typecheck the whole project, then load each entry point to catch runtime-only
import errors that `tsc` misses (missing exports resolved at runtime, side-effecting top-level code):

```bash
# Typecheck — no emit, just verify the project compiles
npx tsc -p . --noEmit

# Load each new/modified entry module (repeat per file the diff touched)
node --experimental-strip-types path/to/changed-module.ts >/dev/null
```

**Go:**

```bash
go build ./...
go vet ./...
```

If anything fails to build or load, either burn one more dispatcher round with the failure as a wing finding, or stop the run.

### Gate 2: Symbol-existence check (when step adds calls into other modules or SDKs)

**Concept:** If the step introduces calls to symbols defined elsewhere — another module in the
repo, or an external dependency/SDK — verify those symbols (functions, classes, methods) actually
exist with the shape the code assumes. **Never trust AI knowledge or documentation for an API —
verify against the installed/declared source.** This class of check has historically caught
several confidently-hallucinated SDK methods that simply did not exist.

**TypeScript** — `tsc` already verifies most of this against `.d.ts` types, so Gate 1 covers the
common case. For symbols that escape static checking (dynamic imports, `any`-typed clients,
JS-only deps without types), assert existence at runtime:

```bash
node --experimental-strip-types -e "
import { TheClient } from './path/to/module.ts';
for (const m of ['methodA', 'methodB', 'methodC']) {
  if (typeof (TheClient.prototype as any)[m] !== 'function') {
    console.error('MISSING: ' + m); process.exit(1);
  }
}
console.log('all symbols present');
"
```

Or a cheap grep against the declared source when a runtime load is awkward:

```bash
grep -RnE 'export (function|const|class) methodName' node_modules/<pkg>/ src/
```

**Go:** the compiler is the symbol check — `go build ./...` fails if a called identifier or method
does not exist. No separate step needed beyond Gate 1.

### Gate 3: Cross-module interface check (every 5 steps or per phase)

Every 5 steps (or when completing a phase), trace the call chain between modules:

1. For each function call that crosses module boundaries, verify the callee's signature accepts the args the caller passes
2. For each return value consumed by another module, verify the type matches
3. For each config/secret name used in code, verify it matches what infrastructure (Terraform, env vars) defines

In TypeScript a project-wide `npx tsc -p . --noEmit` (and `go build ./...` in Go) catches most of
this statically — but config/secret name drift and dynamically-typed boundaries still need a
manual trace. This is the #1 source of bugs in multi-step autonomous runs — the lead writes code assuming interfaces it hasn't verified, and the wing reviews the diff in isolation without exercising the build.

## End-of-Run Verification (Phase 2.5)

After ALL steps complete but BEFORE the summary, run a comprehensive verification.

### Full build / load chain

**Concept:** Compile the entire project and load every entry point. This catches circular imports,
missing dependencies, and interface mismatches that only surface when the whole tree is wired
together.

**TypeScript:**

```bash
npx tsc -p . --noEmit
# Then load every entry/index module the build produces (loop over your real entry points)
for f in $(git diff --name-only --diff-filter=d main... | grep '\.ts$'); do
  node --experimental-strip-types "$f" >/dev/null || echo "FAIL load: $f"
done
```

**Go:**

```bash
go build ./...
go vet ./...
```

If anything fails to build or load, fix the issue before proceeding to the summary.

### Smoke test key objects

Construct the main entry points (app, config, registry) to verify they wire up without crashing.
The goal is to exercise the **real** construction path, not a mock.

**TypeScript:**

```bash
node --experimental-strip-types -e "
import { getSettings } from './src/config.ts';
import { loadAllAgents } from './src/schema.ts';
const settings = getSettings();
const agents = loadAllAgents('agents');
console.log('Loaded ' + agents.length + ' agents');
"
```

**Go:** add a tiny throwaway `func main()` (or a `*_test.go` smoke test) that calls the real
constructors, then `go run ./cmd/smoke` or `go test -run Smoke ./...`.

### Test suite

Run the project's tests — they are the highest-fidelity gate.

**TypeScript:**

```bash
npm test
# or a single file:
node --experimental-strip-types --test path/to/module.test.ts
```

**Go:**

```bash
go test ./...
```

**This phase exists because:** in an 8-round review of a 22-step autonomous build, 43 bugs were found — the majority were cross-module interface mismatches and wrong API assumptions that a project-wide typecheck/build plus exercising the real construction path would have caught. The cost of this verification is roughly a minute. The cost of not doing it is hours of review rounds.
