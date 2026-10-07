from __future__ import annotations

import importlib.util
import threading
from typing import List, Optional, Tuple

import chess

from dataclasses import dataclass


@dataclass
class Prediction:
    move_uci: str
    probability: float


MAIA3_DEFAULT_MODEL = "maia3-23m"
MAIA3_DEFAULT_REPO = "UofTCSSLab/Maia3-23M"


class Maia3Unavailable(RuntimeError):
    pass


class Maia3Reference:
    """Offline reference for browser asset export, using the official `maia3` package.

    The default model is Maia3 23M (`UofTCSSLab/Maia3-23M`). The package resolves
    the checkpoint through Hugging Face on first use. This is never imported by the application.
    """

    name = MAIA3_DEFAULT_MODEL

    def __init__(
        self,
    ):
        self._engine = None
        self._lock = threading.Lock()

    @staticmethod
    def is_available() -> bool:
        return importlib.util.find_spec("maia3") is not None

    def predictions(
        self,
        fen: str,
        *,
        rating: Optional[int] = None,
    ) -> List[Prediction]:
        with self._lock:
            engine = self._ensure_engine()
            engine.board = chess.Board(fen)
            engine._reset_history()
            engine.self_elo = int(rating or 1500)
            engine.oppo_elo = int(rating or 1500)
            engine.temperature = 0.0
            engine.top_p = 1.0
            engine.multipv = max(1, min(20, int(12)))
            _move, top_moves = engine.score_moves()

        predictions = []
        for item in top_moves:
            predictions.append(
                Prediction(
                    move_uci=item["move"].uci(),
                    probability=float(item.get("policy", 0.0)),
                )
            )
        return predictions

    def move_assessment(
        self,
        fen: str,
        move_uci: str,
        *,
        rating: Optional[int] = None,
    ) -> Optional[Tuple[float, float]]:
        import torch
        from maia3.dataset import get_legal_moves_mask
        from maia3.uci import invert_wdl, wdl_from_value_logits

        try:
            board = chess.Board(fen)
            move = chess.Move.from_uci(move_uci)
        except ValueError:
            return None
        if move not in board.legal_moves:
            return None

        with self._lock:
            engine = self._ensure_engine()
            engine.board = board
            engine._reset_history()
            elo = int(rating or 1500)
            engine.self_elo = elo
            engine.oppo_elo = elo
            device = engine.cfg.device

            legal_mask = get_legal_moves_mask(board, engine.all_moves_dict).to(device)
            tokens = engine._tokens_from_history(engine.history).unsqueeze(0).to(device)
            self_elos = torch.tensor([elo], dtype=torch.long, device=device)
            oppo_elos = torch.tensor([elo], dtype=torch.long, device=device)
            with torch.no_grad():
                logits_move, _, _ = engine.model(tokens, self_elos, oppo_elos)
            logits = logits_move[0].float().masked_fill(~legal_mask, float("-inf"))
            probs = torch.softmax(logits, dim=-1)

            # The move vocabulary is in maia's side-to-move (mirrored) frame, so
            # map indices back to real moves via the engine and match by uci.
            human_probability = 0.0
            for idx in torch.nonzero(probs > 0).flatten().tolist():
                candidate = engine._move_from_index(idx)
                if candidate is not None and candidate.uci() == move_uci:
                    human_probability = float(probs[idx])
                    break

            # Value of the position after the move. The candidate board's side
            # to move is the opponent, so swap elos and invert back to the mover.
            cand_tokens = (
                engine._tokens_from_history(engine._history_after_move(move))
                .unsqueeze(0)
                .to(device)
            )
            cand_self = torch.tensor([engine.oppo_elo], dtype=torch.long, device=device)
            cand_oppo = torch.tensor([engine.self_elo], dtype=torch.long, device=device)
            with torch.no_grad():
                _, value_logits, _ = engine.model(cand_tokens, cand_self, cand_oppo)
            win, draw, loss = invert_wdl(wdl_from_value_logits(value_logits[0]))
            win_chance_after = (win + 0.5 * draw) / 1000.0

        return human_probability, win_chance_after

    def _ensure_engine(self):
        if self._engine is not None:
            return self._engine
        if not self.is_available():
            raise Maia3Unavailable(
                "Maia3 package is not installed. Install CSSLab/maia3 and cache "
                "`maia3-23m` to use the true Maia3 adapter."
            )

        try:
            from maia3.uci import Maia3UCIEngine, parse_args
        except ImportError as exc:
            raise Maia3Unavailable(str(exc)) from exc

        self._engine = Maia3UCIEngine(parse_args([
            "--model", MAIA3_DEFAULT_MODEL, "--multipv", "12",
            "--temperature", "0", "--device", "cpu",
        ]))
        self._engine.ensure_model_loaded()
        return self._engine
