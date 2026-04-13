"""Tests for forged_review_triage_cache."""

from __future__ import annotations

import forged_review_triage_cache as cache


# ── compute_triage_key ────────────────────────────────────────────────


def test_compute_triage_key_deterministic():
    key1 = cache.compute_triage_key("diff", ["a.py", "b.py"], "body")
    key2 = cache.compute_triage_key("diff", ["a.py", "b.py"], "body")
    assert key1 == key2


def test_compute_triage_key_file_order_insensitive():
    key1 = cache.compute_triage_key("d", ["a.py", "b.py"], "")
    key2 = cache.compute_triage_key("d", ["b.py", "a.py"], "")
    assert key1 == key2


def test_compute_triage_key_diff_sensitive():
    key1 = cache.compute_triage_key("diff one", ["a.py"], "")
    key2 = cache.compute_triage_key("diff two", ["a.py"], "")
    assert key1 != key2


def test_compute_triage_key_body_truncated():
    shared = "same start " + ("x" * 2000)
    longer = shared + " trailing change"
    key1 = cache.compute_triage_key("d", ["a.py"], shared)
    key2 = cache.compute_triage_key("d", ["a.py"], longer)
    # Body beyond body_char_limit (default 500) must not flip the key.
    assert key1 == key2


# ── load / save round trip ────────────────────────────────────────────


def test_save_then_load_returns_result(tmp_path):
    path = tmp_path / "triage-cache.json"
    payload = {"selected_domains": ["correctness"], "rationale": {"correctness": "always-on"}}
    cache.save_cached_triage("k1", payload, cache_path=path)
    loaded = cache.load_cached_triage("k1", cache_path=path)
    assert loaded == payload


def test_load_returns_none_on_missing_file(tmp_path):
    path = tmp_path / "never-written.json"
    assert cache.load_cached_triage("k1", cache_path=path) is None


def test_load_returns_none_on_missing_key(tmp_path):
    path = tmp_path / "cache.json"
    cache.save_cached_triage("other", {"selected_domains": []}, cache_path=path)
    assert cache.load_cached_triage("k1", cache_path=path) is None


def test_load_returns_none_on_expired_ttl(tmp_path):
    path = tmp_path / "cache.json"
    cache.save_cached_triage("k1", {"selected_domains": []}, cache_path=path, now=1000.0)
    # TTL of 100s; query 500s later → expired.
    assert cache.load_cached_triage("k1", cache_path=path, ttl_s=100, now=1500.0) is None


def test_load_returns_result_within_ttl(tmp_path):
    path = tmp_path / "cache.json"
    payload = {"selected_domains": ["security"]}
    cache.save_cached_triage("k1", payload, cache_path=path, now=1000.0)
    assert cache.load_cached_triage("k1", cache_path=path, ttl_s=100, now=1050.0) == payload


def test_load_handles_corrupt_file(tmp_path):
    path = tmp_path / "cache.json"
    path.write_text("definitely not json", encoding="utf-8")
    assert cache.load_cached_triage("k1", cache_path=path) is None


# ── FIFO eviction ─────────────────────────────────────────────────────


def test_save_evicts_oldest_when_over_cap(tmp_path):
    path = tmp_path / "cache.json"
    for i in range(5):
        cache.save_cached_triage(
            f"k{i}", {"selected_domains": [str(i)]}, cache_path=path,
            max_entries=3, now=1000.0 + i,
        )
    # k0, k1 should be evicted; k2, k3, k4 should remain.
    # Pass now close to save time so the TTL check doesn't expire them.
    assert cache.load_cached_triage("k0", cache_path=path, now=1005.0) is None
    assert cache.load_cached_triage("k1", cache_path=path, now=1005.0) is None
    assert cache.load_cached_triage("k2", cache_path=path, now=1005.0) == {"selected_domains": ["2"]}
    assert cache.load_cached_triage("k4", cache_path=path, now=1005.0) == {"selected_domains": ["4"]}


# ── integration with dispatch_triage ──────────────────────────────────


def test_dispatch_triage_uses_cache_on_second_call(tmp_path, monkeypatch):
    import forged_review_dispatch as disp
    import forged_review_triage_cache as cache_module

    monkeypatch.setattr(cache_module, "DEFAULT_CACHE_PATH", tmp_path / "cache.json")

    calls = []

    def fake_run_agent(agent, prompt, cwd=None, timeout_s=None):
        calls.append(agent)
        return disp.AgentCallResult(
            agent=agent,
            raw_output='{"selected_domains": ["correctness"], "rationale": {"correctness": "test"}}',
            duration_s=0.1,
        )

    monkeypatch.setattr(disp, "run_agent", fake_run_agent)

    # First call — cache miss, run_agent called once.
    result1 = disp.dispatch_triage("diff", ["a.py"], "body")
    assert result1 == {"selected_domains": ["correctness"], "rationale": {"correctness": "test"}}
    assert len(calls) == 1

    # Second call with identical inputs — cache hit, run_agent NOT called again.
    result2 = disp.dispatch_triage("diff", ["a.py"], "body")
    assert result2 == result1
    assert len(calls) == 1  # unchanged


def test_dispatch_triage_skips_cache_when_disabled(tmp_path, monkeypatch):
    import forged_review_dispatch as disp
    import forged_review_triage_cache as cache_module

    monkeypatch.setattr(cache_module, "DEFAULT_CACHE_PATH", tmp_path / "cache.json")

    calls = []

    def fake_run_agent(agent, prompt, cwd=None, timeout_s=None):
        calls.append(agent)
        return disp.AgentCallResult(
            agent=agent,
            raw_output='{"selected_domains": ["correctness"], "rationale": {}}',
            duration_s=0.1,
        )

    monkeypatch.setattr(disp, "run_agent", fake_run_agent)

    disp.dispatch_triage("diff", ["a.py"], "body", use_cache=False)
    disp.dispatch_triage("diff", ["a.py"], "body", use_cache=False)
    assert len(calls) == 2
