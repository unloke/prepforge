"""Replay Maia — feeds browser-computed Maia3 assessments into Brilliant detection.

Phase 3d of the browser-engine migration moves Maia3 (the human model) into the
browser, just as Phase 2 moved Stockfish. The server must run NO engine/model
compute in the public flow, so the browser computes each played move's
``move_assessment`` (``humanProbability``, ``winChanceAfter``) locally and sends it
up; this adapter replays those numbers into the existing, validated
:class:`~prepforge_chess.services.brilliant.BrilliantAnalyzer` so the
unintuitive/reveal/sound threshold logic — and its win-chance math — stay in Python
as the single source of truth (mirroring :class:`ReplayEngine` for Stockfish).

A move with no client-supplied assessment returns ``None``, which the analyzer
treats as "can't judge" → that move simply isn't flagged Brilliant (the correct
degradation when the browser had no Maia, rather than a fake that misclassifies).
"""

from __future__ import annotations

from typing import Dict, Iterable, Optional, Tuple

from prepforge_chess.core.chess_core import ChessCore


class ReplayMaia:
    """Inert Maia adapter returning browser-computed assessments by (FEN, move).

    ``assessments`` is an iterable of dicts shaped like the browser payload::

        {"fen": <fen_before>, "uci": <played_move>,
         "human_probability": <0..1>, "win_chance_after": <0..1>}

    Only :meth:`move_assessment` is implemented — that is the sole method
    ``BrilliantAnalyzer`` calls. :meth:`predictions` raises, since the public
    classify path never generates moves (that is the Build-Generate browser path,
    which uses its own provider).
    """

    name = "maia3 (browser)"

    def __init__(
        self,
        assessments: Iterable[Dict[str, object]],
        *,
        chess_core: Optional[ChessCore] = None,
    ) -> None:
        self.chess_core = chess_core or ChessCore()
        self._by_key: Dict[Tuple[str, str], Tuple[float, float]] = {}
        for item in assessments:
            fen = item.get("fen")
            uci = item.get("uci")
            if not isinstance(fen, str) or not isinstance(uci, str):
                continue
            self._by_key[self._key(fen, uci)] = (
                float(item["human_probability"]),
                float(item["win_chance_after"]),
            )

    def _key(self, fen: str, uci: str) -> Tuple[str, str]:
        try:
            normalized = self.chess_core.normalize_fen(fen)
        except Exception:
            normalized = fen.strip()
        return (normalized, uci.strip().lower())

    def move_assessment(
        self,
        fen: str,
        move_uci: str,
        *,
        rating: Optional[int] = None,
    ) -> Optional[Tuple[float, float]]:
        # rating is ignored: the browser already computed the assessment at the
        # agreed Brilliant rating (the server hands that rating to the client via
        # the prepare payload). None → analyzer skips Brilliant for this move.
        del rating
        return self._by_key.get(self._key(fen, move_uci))

    def predictions(self, *args, **kwargs):  # pragma: no cover - never called here
        raise NotImplementedError(
            "ReplayMaia only replays move assessments for Brilliant detection; "
            "move generation runs in the browser Build-Generate provider."
        )
