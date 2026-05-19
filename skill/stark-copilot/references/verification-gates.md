# Verification Gates

## Step Verification (§2e): Verify the approved diff before applying

Before applying, the lead's approved diff must pass these gates in the lead's worktree. A failure here means either burning one more dispatcher round with the gate failure as a finding, or stopping the run.

### Gate 1: Import check

Install deps and import all new/modified Python modules:

```bash
# Create or reuse a verification venv
[ -d /tmp/stark-copilot-verify ] || python3 -m venv /tmp/stark-copilot-verify
/tmp/stark-copilot-verify/bin/pip install -q -r requirements.txt 2>/dev/null

# Import every Python module in the package
/tmp/stark-copilot-verify/bin/python3 -c "
import importlib, pathlib, sys
sys.path.insert(0, '.')
failures = []
for f in pathlib.Path('.').rglob('*.py'):
    if any(p in str(f) for p in ['test', 'venv', 'node_modules', '.git']): continue
    if f.name == '__main__.py': continue
    mod = str(f.with_suffix('')).replace('/', '.')
    try: importlib.import_module(mod)
    except Exception as e: failures.append((mod, e))
for m, e in failures: print(f'FAIL {m}: {e}')
sys.exit(len(failures))
"
```

If any module fails to import, either burn one more dispatcher round with the failure as a wing finding, or stop the run. The most common cause is cross-module interface mismatches (calling constructors with wrong args, importing names that don't exist).

### Gate 2: SDK API verification (when step adds external SDK calls)

If the step introduces calls to external SDKs (database clients, cloud APIs, LLM SDKs), verify the methods exist:

```bash
/tmp/stark-copilot-verify/bin/python3 -c "
import inspect
from <sdk_module> import <Class>
# Verify method signatures match what our code calls
for method_name in [<methods_we_call>]:
    assert hasattr(<Class>, method_name), f'{method_name} does not exist'
    sig = inspect.signature(getattr(<Class>, method_name))
    print(f'{method_name}: {sig}')
"
```

This caught 5 bugs in the Firestore SDK alone — methods that AI agents confidently called but that don't exist (`begin()`, `rollback()`, `async_transactional` decorator). **Never trust AI knowledge or documentation for SDK APIs — verify against the installed package.**

### Gate 3: Cross-module interface check (every 5 steps or per phase)

Every 5 steps (or when completing a phase), trace the call chain between modules:

1. For each function call that crosses module boundaries, verify the callee's signature accepts the args the caller passes
2. For each return value consumed by another module, verify the type matches
3. For each config/secret name used in code, verify it matches what infrastructure (Terraform, env vars) defines

This is the #1 source of bugs in multi-step autonomous runs — the lead writes code assuming interfaces it hasn't verified, and the wing reviews the diff in isolation without exercising imports.

## End-of-Run Verification (Phase 2.5)

After ALL steps complete but BEFORE the summary, run a comprehensive verification:

### Full import chain test

```bash
/tmp/stark-copilot-verify/bin/pip install -q -r requirements.txt
/tmp/stark-copilot-verify/bin/python3 -c "
import importlib, pathlib, sys
sys.path.insert(0, '.')
ok = fail = 0
for f in pathlib.Path('.').rglob('*.py'):
    if any(p in str(f) for p in ['test', 'venv', 'node_modules', '.git']): continue
    if f.name == '__main__.py': continue
    mod = str(f.with_suffix('')).replace('/', '.')
    try:
        importlib.import_module(mod)
        ok += 1
    except Exception as e:
        print(f'FAIL {mod}: {e}')
        fail += 1
print(f'{ok} OK, {fail} FAIL')
sys.exit(fail)
"
```

If ANY module fails to import, fix the issue before proceeding to the summary. This catches circular imports, missing dependencies, and interface mismatches.

### Smoke test key objects

Instantiate the main entry points (app, config, registry) to verify they construct without crashing:

```python
# Adjust for your project — the goal is to exercise the real construction path
from <pkg>.config import get_settings
settings = get_settings()
from <pkg>.schema import load_all_agents
agents = load_all_agents(Path('agents'))
print(f"Loaded {len(agents)} agents")
```

### SDK API spot-check

For each external SDK used in the project, verify the specific methods called in our code actually exist:

```python
import inspect
# Example for Firestore
from google.cloud.firestore_v1.async_transaction import AsyncTransaction
for method in ['get', 'set', 'update', 'commit', '_rollback']:
    assert hasattr(AsyncTransaction, method), f"AsyncTransaction.{method} does not exist"
```

**This phase exists because:** In an 8-round review of a 22-step autonomous build, 43 bugs were found — the majority were cross-module interface mismatches and wrong SDK API assumptions that would have been caught by importing the modules and verifying method signatures. The cost of this verification is ~60 seconds. The cost of not doing it is hours of review rounds.
