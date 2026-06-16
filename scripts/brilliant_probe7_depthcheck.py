"""Why do #2 (40...Re8) and #3 (55...Ka8) still flag brilliant?

Both are Black-to-move. The browser ships trap_gap; the server uses it. Validated
trap_gap (probe2/6) was at depth 18, but the default analysis depth is 16. This
checks, for each move, the server Maia3 top-policy "natural move" and the
resulting trap_gap at several depths — to tell a depth/robustness problem apart
from a wrong-natural-move problem.

    py -3.13 scripts/brilliant_probe7_depthcheck.py
"""
from __future__ import annotations

import os

import chess

from prepforge_chess.core.models import Color
from prepforge_chess.services.classification import win_chance_for_side
from prepforge_chess.services.engine import EngineAnalysisConfig, StockfishEngine
from prepforge_chess.services.maia import Maia3Config, create_maia3_adapter

STOCKFISH = os.path.abspath(
    "engines/stockfish/stockfish/stockfish-windows-x86-64-avx2.exe"
)
MAIA_RATING = 1900
DEPTHS = (12, 14, 16, 18)

# (label, fen_before, uci, side)
TARGETS = [
    ("#2 40...Re8", "3k2r1/pb6/1pp1Q3/8/3P1P2/P1P4P/KP6/6r1 b - - 2 40", "g8e8", Color.BLACK),
    ("#3 55...Ka8", "1kr5/pb2QP2/1p6/8/3p3P/P4r2/1P1K4/8 b - - 0 55", "b8a8", Color.BLACK),
]


RATINGS = (1100, 1500, 1900)
CHECK_DEPTH = 16


def main():
    engine = StockfishEngine(STOCKFISH, threads=1, options={"UCI_ShowWDL": True})
    maia = create_maia3_adapter(config=Maia3Config(default_rating=MAIA_RATING))
    cfg = EngineAnalysisConfig(depth=CHECK_DEPTH, multipv=1)
    try:
        for label, fen_before, uci, side in TARGETS:
            board = chess.Board(fen_before)
            played = chess.Move.from_uci(uci)
            board_after = board.copy()
            board_after.push(played)
            played_wc = win_chance_for_side(
                engine.evaluate_position(board_after.fen(), cfg), side)

            print("\n==== {0} (played sf_wc={1:.3f} @d{2}) ====".format(
                label, played_wc, CHECK_DEPTH))
            print("{0:>6} {1:>14} {2:>8} {3:>12} {4:>10}".format(
                "rating", "natural", "nat_p", "sf_natural", "trap_gap"))
            for rating in RATINGS:
                preds = maia.predictions(fen_before, rating=rating)
                top = preds[0] if preds else None
                top_uci = top.move_uci if top else None
                top_san = board.san(chess.Move.from_uci(top_uci)) if top_uci else "-"
                if not top_uci or top_uci == uci:
                    nat_wc, trap = played_wc, 0.0
                else:
                    hb = board.copy()
                    hb.push(chess.Move.from_uci(top_uci))
                    nat_wc = win_chance_for_side(engine.evaluate_position(hb.fen(), cfg), side)
                    trap = played_wc - nat_wc
                flag = "  <-- >=0.05 FLAGS brilliant" if trap >= 0.05 else ""
                print("{0:>6} {1:>14} {2:>8.3f} {3:>12.3f} {4:>+10.3f}{5}".format(
                    rating, top_san, top.probability if top else 0.0, nat_wc, trap, flag))
    finally:
        engine.close()


if __name__ == "__main__":
    main()
