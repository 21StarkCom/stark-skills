"""Explicit state machine for the red-team iterative refinement loop (FU-rt4).

The spec for the iterative loop (red-team design §4.3) gave conflicting
accounts of how flicker rounds interact with `max_rounds`:

- "Flicker counts as a round" — but doesn't produce a remediation attempt,
  so users saw nondeterministic exits even when no stable blocking finding
  was ever confirmed.
- "Flicker becomes advisory" vs. "halt unresolved" vs. "clean_after_flicker"
  — three contradictory exit semantics for the same outcome.

This module makes the contradiction go away by modelling the loop as an
explicit state machine where every round produces a named outcome, every
transition is a named edge, and `max_rounds` is consumed only by remediation
attempts. Callers drive the machine by:

1. Running the primary call → ``RoundOutcome.from_primary(result)``
2. Running the verification call → ``classify_round(primary, verification)``
3. Asking the machine what to do next → ``next_state(state, outcome)``

The machine is pure: no I/O, no logging, no model dispatch. Callers wire in
those concerns. The transition log returned in ``IterativeRunState.history``
is the audit signal FU-rt4 asked for.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - type-only import
    from stark_red_team import RedTeamResult


class RoundOutcome(str, Enum):
    """Outcome of one round (one primary + one verification call).

    - ``clean`` — primary returned no blocking findings.
    - ``confirmed_blocking`` — primary AND verification agree on a stable
      blocking finding (overlap holds).
    - ``flicker`` — primary returned blocking findings; verification did
      not agree (overlap fails). Treated as advisory; does NOT consume a
      remediation round.
    - ``degraded`` — primary or verification produced an error AFTER at
      least one prior round had useful output. Final state: surface as
      ``degraded`` rather than masking the error as clean.
    - ``error`` — first call hit an error with no prior good round.
    """

    clean = "clean"
    confirmed_blocking = "confirmed_blocking"
    flicker = "flicker"
    degraded = "degraded"
    error = "error"


@dataclass(frozen=True)
class RoundRecord:
    """One round's primary + verification + outcome, frozen for the audit log.

    Both ``primary`` and ``verification`` are recorded even when the round
    classifies as ``flicker`` — the FU-rt4 invariant is "record before
    branching" so a downstream auditor can replay the gate decision.
    """

    round_num: int
    primary: "RedTeamResult"
    verification: "RedTeamResult | None"
    outcome: RoundOutcome
    transition: str  # named transition that produced this record


@dataclass
class IterativeRunState:
    """Mutable accumulator for an iterative red-team run.

    ``rounds_used`` tracks remediation attempts (clean / confirmed_blocking
    / degraded / error). Flicker rounds appear in ``history`` but do NOT
    bump ``rounds_used`` — that's the "don't burn max_rounds on flicker"
    rule from FU-rt4.

    ``history`` is append-only. Each entry has the named transition that
    brought it into the log so an auditor can answer "why did this run
    exit?" by reading the last entry's ``transition``.
    """

    max_rounds: int
    rounds_used: int = 0
    # FU-rt4 fix (PR #430 review): flicker rounds don't bump ``rounds_used``
    # but they DO consume budget — this counter caps total rounds attempted
    # (including flicker) so a primary/verification pair that keeps disagreeing
    # eventually terminates with ``terminate.budget_exhausted_flicker`` rather
    # than spinning forever. Defaults to ``max_rounds * 2 + 1`` so a single
    # remediation cycle can still flicker once and recover.
    flicker_attempts: int = 0
    history: list[RoundRecord] = field(default_factory=list)
    terminated: bool = False
    final_transition: str | None = None

    @property
    def max_flicker_attempts(self) -> int:
        return max(1, self.max_rounds * 2 + 1)


def classify_round(
    primary: "RedTeamResult",
    verification: "RedTeamResult | None",
    *,
    overlap: "Callable[[RedTeamResult, RedTeamResult], bool]",
    has_prior_good_round: bool,
    verification_required: bool = True,
) -> RoundOutcome:
    """Classify one round given its primary + optional verification result.

    Pure function — no state mutation. ``overlap`` is the stability gate
    (typically ``stark_red_team._overlap``); injected so tests can stub it.

    ``verification_required`` (default True) signals whether a verification
    call SHOULD have been made for this round. When the orchestrator
    runs in single-call mode (``max_rounds == 1``), verification is
    intentionally absent and a missing verification result must not
    surface as ``degraded``. Set ``False`` for that path so the
    classifier returns ``confirmed_blocking`` directly when the primary
    has blocking findings.

    Decision order:

    1. ``primary.error`` → ``error`` (or ``degraded`` if a prior round
       contributed useful output — that prior output is what callers
       surface).
    2. ``primary.blocking_count == 0`` → ``clean``. No verification needed
       to confirm "nothing to confirm".
    3. ``verification_required=False`` → trust the primary result and
       return ``confirmed_blocking`` directly.
    4. Verification missing or errored → ``degraded``. The gate cannot
       judge stability without a verification call.
    5. ``overlap(primary, verification)`` is True → ``confirmed_blocking``.
    6. Otherwise → ``flicker``.
    """
    if primary.error is not None:
        return RoundOutcome.degraded if has_prior_good_round else RoundOutcome.error
    if primary.blocking_count == 0:
        return RoundOutcome.clean
    if not verification_required:
        return RoundOutcome.confirmed_blocking
    if verification is None or verification.error is not None:
        return RoundOutcome.degraded
    if overlap(primary, verification):
        return RoundOutcome.confirmed_blocking
    return RoundOutcome.flicker


def record_round(
    state: IterativeRunState,
    *,
    round_num: int,
    primary: "RedTeamResult",
    verification: "RedTeamResult | None",
    outcome: RoundOutcome,
    transition: str,
) -> None:
    """Append the round to ``state.history`` and bump counters per FU-rt4.

    - ``clean`` / ``confirmed_blocking`` / ``degraded`` / ``error`` consume a
      remediation round (``rounds_used`` += 1).
    - ``flicker`` does NOT consume a remediation round but DOES consume a
      flicker attempt (``flicker_attempts`` += 1). The PR-#430 review fix:
      tracking flicker separately is what bounds the otherwise-unbounded
      flicker loop while preserving the spec's "don't burn max_rounds on
      flicker" rule.
    """
    state.history.append(
        RoundRecord(
            round_num=round_num,
            primary=primary,
            verification=verification,
            outcome=outcome,
            transition=transition,
        )
    )
    if outcome == RoundOutcome.flicker:
        state.flicker_attempts += 1
    else:
        state.rounds_used += 1


def should_terminate(
    state: IterativeRunState,
    outcome: RoundOutcome,
) -> tuple[bool, str | None]:
    """Decide whether the loop should exit after the just-classified round.

    Returns ``(terminate, transition_label)``. The transition label names
    the named edge that takes us out of the loop — those labels are the
    audit signal FU-rt4 demands. Examples:

    - ``"terminate.clean"`` — primary returned no blocking findings.
    - ``"terminate.confirmed_blocking"`` — stable blocking risk, halt.
    - ``"terminate.budget_exhausted"`` — max_rounds reached without
      converging.
    - ``"terminate.degraded"`` — error / missing verification at the
      gate; surface degraded.
    - ``"continue.flicker"`` — flicker; loop again without consuming a
      round.
    """
    if outcome == RoundOutcome.clean:
        return True, "terminate.clean"
    if outcome == RoundOutcome.confirmed_blocking:
        return True, "terminate.confirmed_blocking"
    if outcome == RoundOutcome.error:
        return True, "terminate.error"
    if outcome == RoundOutcome.degraded:
        return True, "terminate.degraded"
    # flicker — bound by flicker_attempts (which record_round will bump). We
    # check against the flicker cap; the legacy ``rounds_used >= max_rounds``
    # check stays so a flicker after every remediation slot is exhausted
    # also exits.
    if state.rounds_used >= state.max_rounds:
        return True, "terminate.budget_exhausted_flicker"
    if state.flicker_attempts + 1 >= state.max_flicker_attempts:
        # ``+ 1`` because record_round hasn't bumped flicker_attempts yet at
        # the moment should_terminate is called — checking the post-record
        # value here keeps the exit deterministic.
        return True, "terminate.flicker_attempts_exhausted"
    return False, "continue.flicker"


def mark_terminated(state: IterativeRunState, transition: str) -> None:
    """Pin the final transition on ``state``. Idempotent."""
    if not state.terminated:
        state.terminated = True
        state.final_transition = transition
