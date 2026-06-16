"""How much does MultiPV actually cost?

multipv_gap_13 / near_best_count from brilliant_probe3.py looked like the
strongest "cheap" feature, but they need multipv>=3 on the before-move
search. MultiPV is NOT free in Stockfish -- non-PV root moves get less
aggressive pruning, so search-to-depth gets slower as MultiPV grows.

This measures real nodes + wall time for multipv=1 vs 3 vs 5 at depth=18,
single-threaded, on a handful of the labeled positions, so we can judge
whether the multipv_gap_13 signal is "worth" the slowdown.

    py -3.13 scripts/brilliant_probe4_multipv_cost.py
"""
from __future__ import annotations

import os
import time

import chess

from prepforge_chess.services.engine import EngineAnalysisConfig, StockfishEngine

STOCKFISH = os.path.abspath(
    "engines/stockfish/stockfish/stockfish-windows-x86-64-avx2.exe"
)
DEPTH = 18

# (label, fen_before) -- a mix of yes/no positions, midgame + endgame
POSITIONS = [
    ("Immortal Qxh7+", "r1b1r1k1/pb1p1ppp/1p1Bp3/4P3/2BP4/2N2N2/PP3PPP/R2QK2R w KQ - 0 11"),
    ("#5 28.Qxe4", "8/1bq3kp/p3Qbp1/1p6/1P1NnP2/P3P3/6PP/4B1K1 w - - 3 28"),
    ("#13 29...Bg3", "r3r1k1/1p3pp1/p6p/2p1b3/P1QpP1P1/4q3/BPP2RR1/6K1 b - - 9 29"),
    ("#10 66...Kg6 (4 legal moves)", "8/5N2/8/6k1/r5p1/6K1/8/8 b - - 7 66"),
    ("#21 33...Re8", "2r4k/6p1/p4p1p/3NnQ2/1p2P3/6KP/Pq6/3B4 b - - 1 33"),
]


def main():
    engine = StockfishEngine(STOCKFISH, threads=1)
    try:
        print("{0:<32} {1:>5} {2:>12} {3:>8} {4:>12} {5:>8}".format(
            "position", "mpv", "nodes", "time(s)", "nodes_x1", "time_x1"))
        print("-" * 80)
        for label, fen in POSITIONS:
            board = chess.Board(fen)
            base_nodes = None
            base_time = None
            for mpv in (1, 3, 5):
                mpv_eff = min(mpv, board.legal_moves.count())
                cfg = EngineAnalysisConfig(depth=DEPTH, multipv=mpv_eff)
                t0 = time.perf_counter()
                pa = engine.analyze_position(fen, cfg)
                dt = time.perf_counter() - t0
                nodes = pa.evaluation.nodes or 0
                if mpv == 1:
                    base_nodes, base_time = nodes, dt
                nx = nodes / base_nodes if base_nodes else float("nan")
                tx = dt / base_time if base_time else float("nan")
                tag = "" if mpv_eff == mpv else " (capped to {0})".format(mpv_eff)
                print("{0:<32} {1:>5} {2:>12} {3:>8.3f} {4:>12.2f} {5:>8.2f}{6}".format(
                    label, mpv, nodes, dt, nx, tx, tag))
            print()
    finally:
        engine.close()


if __name__ == "__main__":
    main()
