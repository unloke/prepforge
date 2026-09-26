"""Personalized dashboard next actions (``GET /api/dashboard`` ``recommendations``).

One pure decision function maps the account's real state — due reviews, weak
and unresolved-mistake cards, repertoire presence, overall activity — to an
ordered list of next actions, each carrying a CTA that opens the matching SPA
view. No DB, no request context: the priority rules regression-test directly
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

    Priority — the rules the dashboard regression tests pin:

    1. **Due reviews win.** A spaced-repetition queue that is ready today is the
       single most valuable action, so it outranks everything else.
    2. **Weak / unresolved mistakes get a targeted review action** — cards the
       player grades wrong more often than right.
    3. **No repertoire yet** → guide creating or importing one (the account has
       games/sessions but nowhere to drill).
    4. **A brand-new account** keeps the simple three-step onboarding (analyze →
       repertoire → train) instead of being dropped into an empty app.
    5. Otherwise generic next steps: analyze a game, extend a repertoire branch.

    Every item is ``{id, title, detail, cta: {label, view}}`` where ``view`` is
    the SPA view the CTA opens (``train`` / ``build`` / ``analyze``), so the
    frontend can route one click straight to the work.
    """
    steps: List[Dict[str, Any]] = []

    # 1. Due reviews: the highest-value action available right now.
    if signals.due_reviews > 0:
        steps.append(
            {
                "id": "train-due",
                "title": "{0} due now".format(_plural(signals.due_reviews, "review card")),
                "detail": (
                    "Spaced repetition has cards ready today — clearing the queue "
                    "is the fastest win available."
                ),
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
                "detail": "Graded wrong more often than right: {0}.".format(
                    " · ".join(detail_bits)
                ),
                "cta": {"label": "Review weak moves", "view": "train"},
            }
        )

    if signals.repertoires == 0:
        if signals.games == 0 and signals.training_sessions == 0:
            # 4. Brand-new account: the simple three-step onboarding.
            steps.extend(
                [
                    {
                        "id": "onboarding-analyze",
                        "title": "Analyze a game",
                        "detail": "Import a PGN and review your classifications.",
                        "cta": {"label": "Open Analyze", "view": "analyze"},
                    },
                    {
                        "id": "onboarding-repertoire",
                        "title": "Create or import a repertoire",
                        "detail": "Turn an opening you play into trainable lines.",
                        "cta": {"label": "Open Build", "view": "build"},
                    },
                    {
                        "id": "onboarding-train",
                        "title": "Train your first cards",
                        "detail": "Five cards a day is enough to start a streak.",
                        "cta": {"label": "Open Train", "view": "train"},
                    },
                ]
            )
        else:
            # 3. Has data but no repertoire: guide create-or-import.
            steps.append(
                {
                    "id": "create-repertoire",
                    "title": "Create or import your first repertoire",
                    "detail": (
                        "Build one from an opening you play, or import a "
                        "PGN/JSON package."
                    ),
                    "cta": {"label": "Open Build", "view": "build"},
                }
            )
    else:
        # 5. Steady state: widen coverage and keep reviewing.
        steps.append(
            {
                "id": "analyze-game",
                "title": "Analyze a game",
                "detail": "Run a full review to see classifications and key moments.",
                "cta": {"label": "Open Analyze", "view": "analyze"},
            }
        )
        steps.append(
            {
                "id": "extend-repertoire",
                "title": "Extend a repertoire branch",
                "detail": "Add or generate a line in Build to widen your coverage.",
                "cta": {"label": "Open Build", "view": "build"},
            }
        )

    return steps[:MAX_RECOMMENDATIONS]
