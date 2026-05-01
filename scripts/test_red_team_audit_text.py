"""Tests for red_team_audit_text — FU-rt6 retention policy."""

from __future__ import annotations

import red_team_audit_text as rta


def _policy(retain_full_text: bool = False, excerpt_max_chars: int = 60):
    return rta.AuditRetentionPolicy(
        retain_full_text=retain_full_text,
        excerpt_max_chars=excerpt_max_chars,
    )


def test_policy_from_config_defaults_to_excerpt():
    pol = rta.policy_from_config(None)
    assert pol.retain_full_text is False
    assert pol.mode == "excerpt"


def test_policy_from_config_respects_explicit_full_text():
    pol = rta.policy_from_config({"retain_full_text": True})
    assert pol.retain_full_text is True
    assert pol.mode == "full"


def test_apply_to_field_returns_null_for_empty_text():
    out = rta.apply_to_field(None, _policy())
    assert out.stored is None
    assert out.hash is None
    out_empty = rta.apply_to_field("", _policy())
    assert out_empty.stored is None


def test_excerpt_mode_truncates_and_pairs_with_hash():
    pol = _policy(excerpt_max_chars=20)
    # Mix of words avoids the >40-char base64-secret regex catching the input.
    text = "the quick brown fox jumps over the lazy dog several times in the meadow"
    out = rta.apply_to_field(text, pol)
    assert out.stored is not None
    assert len(out.stored) <= 20
    assert out.stored.endswith("…")
    assert out.hash == rta.hash_text(text)


def test_excerpt_mode_redacts_secrets_before_truncating():
    pol = _policy(excerpt_max_chars=80)
    text = "Found token sk-deadbeefdeadbeefdeadbeefdeadbeef in config"
    out = rta.apply_to_field(text, pol)
    assert out.stored is not None
    assert "sk-deadbeefdeadbeefdeadbeefdeadbeef" not in out.stored
    assert "[REDACTED]" in out.stored
    # The hash is over the ORIGINAL text so two reruns of the same finding
    # match even after redaction obscures the token.
    assert out.hash == rta.hash_text(text)


def test_full_text_mode_skips_excerpt_hash():
    pol = _policy(retain_full_text=True)
    text = "long full-text concern that should be retained verbatim"
    out = rta.apply_to_field(text, pol)
    assert out.stored == text
    # No paired hash in full-text mode — the row IS the source of truth.
    assert out.hash is None


def test_full_text_mode_still_redacts_secrets():
    """Full-text retention does NOT mean store-secrets-verbatim. Defense in
    depth: even when the policy permits raw text, accidental secret echoes
    must be scrubbed."""
    pol = _policy(retain_full_text=True)
    text = "ghp_abcdefghijklmnopqrstuvwxyz1234567890 leaked"
    out = rta.apply_to_field(text, pol)
    assert out.stored is not None
    assert "ghp_abcdefghijklmnopqrstuvwxyz1234567890" not in out.stored


def test_hash_text_is_deterministic():
    h1 = rta.hash_text("hello")
    h2 = rta.hash_text("hello")
    assert h1 == h2
    h3 = rta.hash_text("Hello")
    assert h1 != h3


def test_redact_strips_pii_alongside_secrets():
    """PR-#430 round-3 review fix #15 — FU-rt6 calls for redacting known
    secrets *and* PII before audit insert. The earlier ``_redact`` only
    handled token-shaped secrets, so a finding citing
    ``alice@example.com had trouble (phone 555-123-4567, ip 10.1.2.3)``
    persisted that prose verbatim into the metrics queue."""
    text = (
        "alice@example.com had trouble logging in (192.168.1.42, "
        "phone 555-123-4567, ssn 123-45-6789, card 4111 1111 1111 1111). "
        "Token leaked: ghp_abcdefghijklmnopqrstuvwxyz1234567890."
    )
    out = rta._redact(text)
    assert "alice@example.com" not in out
    assert "192.168.1.42" not in out
    assert "555-123-4567" not in out
    assert "123-45-6789" not in out
    assert "4111 1111 1111 1111" not in out
    assert "ghp_abcdefghijklmnopqrstuvwxyz1234567890" not in out
    # Replacement markers should be present so an auditor can see what
    # categories were redacted (without disclosing the values).
    assert "[EMAIL-REDACTED]" in out
    assert "[IP-REDACTED]" in out
    assert "[PHONE-REDACTED]" in out
    assert "[SSN-REDACTED]" in out
    assert "[CC-REDACTED]" in out


def test_excerpt_mode_redacts_pii_before_truncation():
    """Excerpt should be redacted PII text, not the original."""
    pol = _policy(retain_full_text=False, excerpt_max_chars=80)
    text = "Customer alice@example.com from 10.0.0.1 reported the issue."
    out = rta.apply_to_field(text, pol)
    assert out.stored is not None
    assert "alice@example.com" not in out.stored
    assert "10.0.0.1" not in out.stored
    # Hash is over the ORIGINAL pre-redaction text so cross-run
    # de-duplication still works.
    assert out.hash == rta.hash_text(text)
