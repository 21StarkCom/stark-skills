# Docstring Convention — Dependency Annotations

stark-graph reads structured annotations from Python docstrings to build the dependency graph. These annotations express which modules a function depends on, which events it publishes, and which callers invoke it.

## Annotation Tags

| Tag | Meaning | Grammar |
|-----|---------|---------|
| `Depends:` | This function directly imports or calls the listed targets | `Depends: module.function[, ...]` |
| `Publishes:` | This function emits the listed events or writes to the listed queues/topics | `Publishes: event.name[, ...]` |
| `Called by:` | Known entry points that invoke this function | `Called by: module.function[, ...]` |

## Grammar Rules

- Each tag appears on its own line inside the docstring.
- Multiple targets are comma-separated on one line.
- Target names must match the allowlist pattern `[a-zA-Z0-9_:./-]+` — no spaces, no special characters.
- Tags are case-sensitive. `Depends:` is valid; `depends:` is not.
- Tags may appear in any order within the docstring.
- Tags are optional — functions without any annotation are legal but reduce graph coverage.

## Examples

### Minimal (function with one dependency)

```python
def send_notification(user_id: str) -> None:
    """Send email notification to user.

    Depends: email_client.send
    """
    email_client.send(user_id, ...)
```

### Full annotation

```python
def process_payment(order_id: str) -> PaymentResult:
    """Process a payment for the given order.

    Depends: payment_gateway.charge, fraud_detector.check, order_store.get
    Publishes: payments.completed, payments.failed
    Called by: checkout_controller.submit, retry_worker.process
    """
    ...
```

### Event subscriber

```python
def on_order_placed(event: OrderEvent) -> None:
    """Handle order-placed events from the event bus.

    Depends: inventory_service.reserve
    Called by: event_bus.dispatch
    """
    ...
```

## Suppression Syntax

To suppress graph warnings for a specific function without adding full annotations, use the `graph: ignore` tag:

```python
def _internal_helper() -> str:
    """Build internal query string.

    graph: ignore
    """
    ...
```

`graph: ignore` silences `NO_DOCSTRING` and `MISSING` warnings for that function. Use sparingly — suppression reduces graph coverage.

## Violation Types

| Code | Description | Quick Fix |
|------|-------------|-----------|
| `NO_DOCSTRING` | Function has no docstring at all | Add a docstring with at least one annotation tag |
| `MISSING` | Docstring exists but has no annotation tags | Add `Depends:`, `Publishes:`, or `Called by:` as appropriate |
| `STALE` | A listed target no longer exists in the graph | Update or remove the stale target reference |

## Quick-Fix Guide

### NO_DOCSTRING

```python
# Before
def calculate_tax(amount: float) -> float:
    return amount * TAX_RATE

# After
def calculate_tax(amount: float) -> float:
    """Calculate tax for a given amount.

    Called by: invoice_builder.generate
    """
    return amount * TAX_RATE
```

### MISSING

```python
# Before
def calculate_tax(amount: float) -> float:
    """Calculate tax for a given amount."""
    return amount * TAX_RATE

# After
def calculate_tax(amount: float) -> float:
    """Calculate tax for a given amount.

    Called by: invoice_builder.generate
    """
    return amount * TAX_RATE
```

### STALE

When a `Depends:` target no longer exists, either:

1. **Update the reference** if the target was renamed:
   ```python
   # Before
   # Depends: old_module.send_email
   # After
   # Depends: notifications.send_email
   ```

2. **Remove the reference** if the dependency was eliminated:
   ```python
   # Before
   # Depends: cache_warmer.warm, legacy_adapter.convert
   # After
   # Depends: cache_warmer.warm
   ```

## Coverage Threshold

The `graph_coverage_threshold` config key (default: `80`) sets the minimum percentage of public functions that must have at least one annotation tag. Functions with `graph: ignore` are excluded from both numerator and denominator.

Check current coverage:

```bash
$PYTHON $SCRIPTS/stark_graph.py --stage audit --repo .
```

## Running Validation

```bash
# Strict mode (exits 1 on errors)
$PYTHON $SCRIPTS/stark_graph.py --stage validate --repo .

# Warn-only mode (exits 0, prints warnings)
$PYTHON $SCRIPTS/stark_graph.py --stage validate --warn --repo .

# Human-readable audit report
$PYTHON $SCRIPTS/stark_graph.py --stage audit --repo .
```

## False-Positive Reporting

If `stark-graph validate` reports an error that appears incorrect:

1. Check that the target name exactly matches a real function in the graph (correct module path, correct function name, no typos).
2. Check that the file containing the target is not excluded by an `--include` pattern.
3. If the target exists but is in a dynamically-loaded module that the parser cannot reach, use `graph: ignore` on the dependent function.
4. Open an issue at `GetEvinced/stark-skills` with the exact error message, the annotated docstring, and the target file path.
