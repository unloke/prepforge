"""End-to-end confirmation of the new gate through the REAL pipeline.

Unlike brilliant_probe5_newgate.py (a pure replay of pre-computed numbers), this
drives the actual production code: classify_move + the real BrilliantAnalyzer
(with sound removed, trap_gap added) over the 23 hand-labeled moves (8 yes /
15 no). If the gate swap is correct, every YES is flagged and every NO is not.

    py -3.13 scripts/brilliant_probe6_gate_e2e.py
"""
from __future__ import annotations

import os

import chess

from brilliant_probe2 import FEN_TARGETS, PGN_TARGETS, locate

from prepforge_chess.core.models import Color
from prepforge_chess.services.brilliant import BrilliantAnalyzer, BrilliantConfig
from prepforge_chess.services.classification import ClassificationConfig, classify_move
from prepforge_chess.services.engine import EngineAnalysisConfig, StockfishEngine
from prepforge_chess.services.maia import Maia3Config, create_maia3_adapter

STOCKFISH = os.path.abspath(
    "engines/stockfish/stockfish/stockfish-windows-x86-64-avx2.exe"
)
DEPTH = 18
MAIA_RATING = 1900


def run_one(label, expected, fen_before, uci, side, engine, analyzer):
    cfg = EngineAnalysisConfig(depth=DEPTH, multipv=1)
    cfg2 = EngineAnalysisConfig(depth=DEPTH, multipv=2)
    board_before = chess.Board(fen_before)
    mv = chess.Move.from_uci(uci)
    board_after = board_before.copy()
    board_after.push(mv)

    pa = engine.analyze_position(fen_before, cfg2)
    eval_after = engine.analyze_position(board_after.fen(), cfg).evaluation
    best_after = pa.best_evaluation_after or eval_after
    cls = classify_move(
        side_to_move=side,
        played_move_uci=uci,
        best_move_uci=pa.best_move_uci,
        played_eval_after=eval_after,
        best_eval_after=best_after,
        config=ClassificationConfig(),
    )
    result = analyzer.evaluate(
        classification=cls.classification,
        fen_before=fen_before,
        played_move_uci=uci,
        side_to_move=side,
        stockfish_eval_before=pa.evaluation,
        stockfish_eval_after=eval_after,
    )
    flagged = bool(result and result.is_brilliant)
    trap = result.trap_gap if result else None
    reveal = result.reveal_score if result else None
    hp = result.human_probability if result else None
    return {
        "label": label, "expected": expected, "flagged": flagged,
        "class": cls.classification.value, "human_p": hp,
        "reveal": reveal, "trap": trap,
    }


def main():
    engine = StockfishEngine(STOCKFISH, threads=1, options={"UCI_ShowWDL": True})
    maia = create_maia3_adapter(config=Maia3Config(default_rating=MAIA_RATING))
    analyzer = BrilliantAnalyzer(
        maia=maia,
        engine=engine,
        engine_config=EngineAnalysisConfig(depth=DEPTH, multipv=1),
        config=BrilliantConfig(),
    )

    rows = []
    try:
        for label, expected, pgn, fullmove, side, san in PGN_TARGETS:
            fen_before, uci = locate(pgn, fullmove, side, san)
            rows.append(run_one(label, expected, fen_before, uci, side, engine, analyzer))
            print("done:", label)
        for label, expected, fen_before, uci, side in FEN_TARGETS:
            rows.append(run_one(label, expected, fen_before, uci, side, engine, analyzer))
            print("done:", label)
    finally:
        engine.close()

    def f(v, spec="{0:+.3f}"):
        return spec.format(v) if v is not None else "  -  "

    print("\n{0:<18} {1:>3} {2:>6} {3:>10} {4:>8} {5:>8} {6:>8}".format(
        "move", "exp", "flag", "class", "human_p", "reveal", "trap"))
    print("-" * 70)
    tp = fp = tn = fn = 0
    for r in sorted(rows, key=lambda x: (x["expected"] != "yes", x["label"])):
        yes = r["expected"] == "yes"
        if r["flagged"] and yes:
            tp += 1
        elif r["flagged"] and not yes:
            fp += 1
        elif not r["flagged"] and yes:
            fn += 1
        else:
            tn += 1
        mark = "OK" if (r["flagged"] == yes) else "** WRONG **"
        print("{0:<18} {1:>3} {2:>6} {3:>10} {4:>8} {5:>8} {6:>8}  {7}".format(
            r["label"], "Y" if yes else ".", "FLAG" if r["flagged"] else "-",
            r["class"], f(r["human_p"], "{0:.3f}"), f(r["reveal"]), f(r["trap"]), mark))

    print("\nConfusion (8 yes / 15 no):")
    print("  TP={0}  FP={1}  TN={2}  FN={3}".format(tp, fp, tn, fn))
    fps = [r["label"] for r in rows if r["flagged"] and r["expected"] != "yes"]
    misses = [r["label"] for r in rows if not r["flagged"] and r["expected"] == "yes"]
    print("  false positives kept:", ", ".join(fps) or "none")
    print("  real brilliancies missed:", ", ".join(misses) or "none")


if __name__ == "__main__":
    main()
