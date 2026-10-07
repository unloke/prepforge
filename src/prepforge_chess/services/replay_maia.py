"""Replay Maia — feeds browser-computed Maia3 assessments into Brilliant detection.

Phase 3d of the browser-engine migration moves Maia3 (the human model) into the
browser, just as Phase 2 moved Stockfish. The server must run NO engine/model
compute in the public flow, so the browser computes each played move's
``move_assessment`` (``humanProbability``, ``winChanceAfter``) locally and sends it
up; this adapter replays those numbers into the existing, validated
:class:`~prepforge_chess.services.brilliant.BrilliantAnalyzer` so the
unintuitive/reveal/sound threshold logic — and its win-chance math — stay in Python
as the single source of truth.

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
         "human_probability": <0..1>, "win_chance_after": <0..1>,
         "trap_gap": <-1..1, optional>, "only_move_gap": <-1..1, optional>,
         "two_move_gap": <-1..1, optional>}

    :meth:`move_assessment` and :meth:`precomputed_trap_gap` are the two methods
    ``BrilliantAnalyzer`` consults; both replay browser-computed numbers.
    :meth:`predictions` raises, since the public classify path never generates
    moves (that is the Build-Generate browser path, which uses its own provider).
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
        # Browser-supplied trap_gap per (fen, played move). Optional per item: a move
        # the browser never deemed eligible (or had no Maia for) carries no trap_gap,
        # and the analyzer treats its absence as "trap layer un-evaluable" → not flagged.
        self._trap_by_key: Dict[Tuple[str, str], float] = {}
        # Browser-supplied only_move_gap (played vs the best other move), optional too.
        self._only_by_key: Dict[Tuple[str, str], float] = {}
        # ...and two_move_gap (played vs the SECOND-best other move), for Great.
        self._two_by_key: Dict[Tuple[str, str], float] = {}
        for item in assessments:
            fen = item.get("fen")
            uci = item.get("uci")
            if not isinstance(fen, str) or not isinstance(uci, str):
                continue
            key = self._key(fen, uci)
            self._by_key[key] = (
                float(item["human_probability"]),
                float(item["win_chance_after"]),
            )
            trap = item.get("trap_gap")
            if isinstance(trap, (int, float)) and not isinstance(trap, bool):
                self._trap_by_key[key] = float(trap)
            only = item.get("only_move_gap")
            if isinstance(only, (int, float)) and not isinstance(only, bool):
                self._only_by_key[key] = float(only)
            two = item.get("two_move_gap")
            if isinstance(two, (int, float)) and not isinstance(two, bool):
                self._two_by_key[key] = float(two)

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

    def precomputed_trap_gap(
        self,
        fen: str,
        move_uci: str,
    ) -> Optional[float]:
        """The browser-computed ``trap_gap`` for (fen, played move), or None.

        The browser computes ``trap_gap = sf_truth(played) − sf_truth(Maia's
        top-policy move)`` locally — it has both Maia3 and Stockfish — and ships it
        in the assessment, because the public server runs no engine and so cannot
        evaluate the hypothetical natural-move position itself. ``BrilliantAnalyzer``
        reads this supplied value (alongside how
        :meth:`move_assessment` is replayed). None → the trap layer is un-evaluable
        for this move → it is not flagged Brilliant.
        """
        return self._trap_by_key.get(self._key(fen, move_uci))

    def precomputed_only_move_gap(
        self,
        fen: str,
        move_uci: str,
    ) -> Optional[float]:
        """The browser-computed ``only_move_gap`` (played vs the best other move,
        mover POV) for (fen, played move), or None."""
        return self._only_by_key.get(self._key(fen, move_uci))

    def precomputed_two_move_gap(
        self,
        fen: str,
        move_uci: str,
    ) -> Optional[float]:
        """The browser-computed ``two_move_gap`` (played vs the second-best other
        move, mover POV) for (fen, played move), or None."""
        return self._two_by_key.get(self._key(fen, move_uci))

    def predictions(self, *args, **kwargs):  # pragma: no cover - never called here
        raise NotImplementedError(
            "ReplayMaia only replays move assessments for Brilliant detection; "
            "move generation runs in the browser Build-Generate provider."
        )
