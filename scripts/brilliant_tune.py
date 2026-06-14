"""Brilliant-detection threshold tuning probe.

Runs the real analysis stack (Stockfish + Maia3) over one or more PGNs, dumps
the per-ply Brilliant metrics for every Best/Excellent move, then sweeps a set
of candidate threshold configs and reports how many Brilliants each would flag
per game. Use it to find a "sweet spot" that catches genuine brilliancies
(e.g. Marshall's 23...Qg3) without firing on ordinary good moves.

    py -3.13 scripts/brilliant_tune.py

Edit GAMES below or pass PGN file paths as argv.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass, replace
from io import StringIO
from typing import List, Optional

import chess
import chess.pgn

from prepforge_chess.core.models import Color, MoveSource
from prepforge_chess.services.brilliant import BrilliantConfig
from prepforge_chess.services.classification import (
    ClassificationConfig,
    classify_move,
    win_chance_for_side,
)
from prepforge_chess.services.engine import EngineAnalysisConfig, StockfishEngine
from prepforge_chess.services.maia import Maia3Config, create_maia3_adapter

import os
STOCKFISH = os.path.abspath(
    "engines/stockfish/stockfish/stockfish-windows-x86-64-avx2.exe"
)
DEPTH = 16
MAIA_RATING = 1900
ELIGIBLE = {"best", "excellent"}


GAME1 = """
[White "AudienceCTQ"]
[Black "Keynos"]
[Result "1-0"]

1. e4 e5 2. f4 exf4 3. Nf3 d5 4. exd5 Qxd5 5. Nc3 Qa5 6. d4 Bd6 7. Bd3 Ne7
8. O-O O-O 9. Nb5 Ng6 10. Ng5 Be7 11. Nxh7 Kxh7 12. Bxf4 Na6 13. Qh5+ Kg8
14. Bxc7 Nxc7 15. Rxf7 Ne6 16. Bxg6 Ng5 17. Rxf8+ Bxf8 18. Qxg5 Bg4 19. Qh4 Bh5
20. Qxh5 Qe1+ 21. Rxe1 Bc5 22. Qh7+ Kf8 23. Qh8# 1-0
"""

GAME2 = """
[White "Stefan Levitsky"]
[Black "Frank Marshall"]
[Result "0-1"]

1. e4 e6 2. d4 d5 3. Nc3 c5 4. Nf3 Nc6 5. exd5 exd5 6. Be2 Nf6 7. O-O Be7 8. Bg5
O-O 9. dxc5 Be6 10. Nd4 Bxc5 11. Nxe6 fxe6 12. Bg4 Qd6 13. Bh3 Rae8 14. Qd2 Bb4
15. Bxf6 Rxf6 16. Rad1 Qc5 17. Qe2 Bxc3 18. bxc3 Qxc3 19. Rxd5 Nd4 20. Qh5 Ref8
21. Re5 Rh6 22. Qg5 Rxh3 23. Rc5 Qg3 24. hxg3 Ne2# 0-1
"""


@dataclass
class PlyRow:
    ply: int
    san: str
    side: Color
    classification: str
    human_p: Optional[float] = None
    maia_glance: Optional[float] = None
    sf_truth: Optional[float] = None
    sf_before: Optional[float] = None
    reveal: Optional[float] = None


def parse_moves(pgn_text: str):
    game = chess.pgn.read_game(StringIO(pgn_text.strip()))
    board = game.board()
    rows = []
    ply = 0
    for mv in game.mainline_moves():
        ply += 1
        fen_before = board.fen()
        san = board.san(mv)
        side = Color.WHITE if board.turn == chess.WHITE else Color.BLACK
        board.push(mv)
        rows.append(
            dict(
                ply=ply,
                uci=mv.uci(),
                san=san,
                side=side,
                fen_before=fen_before,
                fen_after=board.fen(),
            )
        )
    white = game.headers.get("White", "?")
    black = game.headers.get("Black", "?")
    return "{0} vs {1}".format(white, black), rows


def analyze(label, rows, engine, maia):
    cfg = EngineAnalysisConfig(depth=DEPTH, multipv=1)
    ccfg = ClassificationConfig()
    out: List[PlyRow] = []
    for r in rows:
        pa = engine.analyze_position(r["fen_before"], cfg)
        eval_after = engine.analyze_position(r["fen_after"], cfg).evaluation
        best_after = pa.best_evaluation_after or eval_after
        cls = classify_move(
            side_to_move=r["side"],
            played_move_uci=r["uci"],
            best_move_uci=pa.best_move_uci,
            played_eval_after=eval_after,
            best_eval_after=best_after,
            config=ccfg,
        )
        row = PlyRow(
            ply=r["ply"], san=r["san"], side=r["side"],
            classification=cls.classification.value,
        )
        if cls.classification.value in ELIGIBLE:
            assessment = maia.move_assessment(r["fen_before"], r["uci"], rating=MAIA_RATING)
            if assessment is not None:
                hp, glance = assessment
                truth = win_chance_for_side(eval_after, r["side"])
                before = win_chance_for_side(pa.evaluation, r["side"])
                row.human_p = hp
                row.maia_glance = glance
                row.sf_truth = truth
                row.sf_before = before
                row.reveal = truth - glance
        out.append(row)
        print("  ply {0:>2} {1:<7} {2:<10} hp={3} reveal={4}".format(
            row.ply, row.san, row.classification,
            "{0:.3f}".format(row.human_p) if row.human_p is not None else "  -  ",
            "{0:+.3f}".format(row.reveal) if row.reveal is not None else "  -  ",
        ))
    return out


def count_brilliant(rows: List[PlyRow], c: BrilliantConfig):
    hits = []
    for r in rows:
        if r.classification not in ELIGIBLE or r.human_p is None:
            continue
        if (
            r.human_p <= c.max_human_probability
            and r.reveal >= c.min_reveal_score
            and r.sf_truth >= r.sf_before - c.max_high_drop_vs_before
            and r.sf_truth >= c.min_high_win_chance
        ):
            hits.append(r)
    return hits


def main():
    paths = sys.argv[1:]
    games = []
    if paths:
        for p in paths:
            with open(p, "r", encoding="utf-8") as fh:
                games.append(fh.read())
    else:
        games = [GAME1, GAME2]

    engine = StockfishEngine(STOCKFISH)
    maia = create_maia3_adapter(config=Maia3Config(default_rating=MAIA_RATING))

    analyzed = []
    try:
        for g in games:
            label, rows = parse_moves(g)
            print("\n=== {0} ===".format(label))
            analyzed.append((label, analyze(label, rows, engine, maia)))
    finally:
        engine.close()

    # Candidate configs to sweep. Baseline is current production.
    configs = {
        "old (reveal>=.30, hp<=.10)": replace(BrilliantConfig(), min_reveal_score=0.30),
        "reveal>=.25, hp<=.10": replace(BrilliantConfig(), min_reveal_score=0.25),
        "reveal>=.20, hp<=.10": replace(BrilliantConfig(), min_reveal_score=0.20),
        "CURRENT default (reveal>=.17, hp<=.10)": BrilliantConfig(),
        "reveal>=.15, hp<=.10": replace(BrilliantConfig(), min_reveal_score=0.15),
        "reveal>=.12, hp<=.10": replace(BrilliantConfig(), min_reveal_score=0.12),
    }

    print("\n\n================ THRESHOLD SWEEP ================")
    for name, c in configs.items():
        print("\n-- {0} --".format(name))
        for label, rows in analyzed:
            hits = count_brilliant(rows, c)
            tag = ", ".join("{0} {1}".format(h.ply, h.san) for h in hits) or "(none)"
            print("   {0:<28} {1} brilliant: {2}".format(label, len(hits), tag))


if __name__ == "__main__":
    main()
