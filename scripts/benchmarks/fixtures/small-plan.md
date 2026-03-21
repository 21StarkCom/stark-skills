# Widget Cache — Design

## Overview

Add an in-memory LRU cache for widget lookups to reduce database round trips.

## Decision

Use Python's `functools.lru_cache` with a max size of 1000 entries and a TTL of 5 minutes.
Cache invalidation happens on widget update/delete via a simple `cache_clear()` call.

## API

```python
@lru_cache(maxsize=1000)
def get_widget(widget_id: str) -> Widget:
    return db.widgets.find_one({"id": widget_id})
```

## Constraints

- No distributed cache (single-process only)
- No persistence across restarts
- Cache size bounded at 1000 entries
