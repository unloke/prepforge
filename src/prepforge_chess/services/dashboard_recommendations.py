"""Personalized dashboard next actions (``GET /api/dashboard`` ``recommendations``).

One pure decision function maps the account's real state — due reviews and
weak/unresolved-mistake cards — to an ordered list of next actions, each
carrying a CTA that opens the matching SPA view. Only state-driven actions
qualify: generic navigation hints ("Analyze a game", "Extend a repertoire
branch", …) duplicate the top nav and add nothing to the Today card. No DB, no
request context: the priority rules regression-test directly
(``tests/test_dashboard_recommendations.py``).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

MAX_RECOMMENDATIONS = 3


@dataclass(frozen=True)
class DashboardSignals:
    """The account facts recommendations are derived from (all counts)."""

    games: int = 0
    repertoires: int = 0
    training_sessions: int = 0
    due_reviews: int = 0
    due_soon: int = 0
    open_mistakes: int = 0
    weak: int = 0


def _plural(count: int, noun: str) -> str:
    return "{0} {1}{2}".format(count, noun, "" if count == 1 else "s")


def build_recommendations(signals: DashboardSignals) -> List[Dict[str, Any]]:
    """Ordered next actions, most valuable first (at most 3).

    Only STATE-DRIVEN actions make the list. The old generic navigation
    recommendations ("Analyze a game → Open Analyze", "Extend a repertoire
    branch → Open Build", the three-step onboarding …) merely repeated the top
    navigation and crowded the Today card, so they are gone; the card keeps the
    account's real numbers (streak, due, weak) and offers a button only when
    there is actual work waiting.

    Priority — the rules the dashboard regression tests pin:

    1. **Due reviews win.** A spaced-repetition queue that is ready today is the
       single most valuable action, so it outranks everything else.
    2. **Weak / unresolved mistakes get a targeted review action** — cards the
       player grades wrong more often than right.

    Every item is ``{id, title, detail, cta: {label, view}}`` where ``view`` is
    the SPA view the CTA opens, so the frontend can route one click straight to
    the work; ``detail`` carries only the counts behind the action.
    """
    steps: List[Dict[str, Any]] = []

    # 1. Due reviews: the highest-value action available right now.
    if signals.due_reviews > 0:
        steps.append(
            {
                "id": "train-due",
                "title": "{0} due now".format(_plural(signals.due_reviews, "review card")),
                "detail": "",
                "cta": {"label": "Start due review", "view": "train"},
            }
        )

    # 2. Targeted review of weak / unresolved-mistake cards.
    if signals.weak > 0 or signals.open_mistakes > 0:
        detail_bits = []
        if signals.weak > 0:
            detail_bits.append(_plural(signals.weak, "weak move"))
        if signals.open_mistakes > 0:
            detail_bits.append(
                _plural(signals.open_mistakes, "unresolved mistake")
            )
        steps.append(
            {
                "id": "review-weak",
                "title": "Sharpen your weak spots",
                "detail": "{0}.".format(" · ".join(detail_bits)),
                "cta": {"label": "Review weak moves", "view": "train"},
            }
        )

    return steps[:MAX_RECOMMENDATIONS]
