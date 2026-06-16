"""Cheap (no extra-SF-call) feature probe, inspired by arXiv:2406.11895
("Predicting User Perception of Move Brilliance in Chess").

That paper's key finding: a move looks more brilliant when a *weaker* engine
(shallow search / Maia) underrates it relative to a *stronger* one (deep
search). The current `reveal` already does this with Maia-as-weak vs
SF-depth-18-as-strong. This probe tests two near-free alternatives on the same
23 human-labeled moves (8 yes / 15 no) from brilliant_probe2.py:

1. **sf_shallow_reveal** -- instead of Maia's value head, use STOCKFISH'S OWN
   low-depth eval of the position after the move as the "glance". Iterative
   deepening means depth-1/3/5 evals are emitted for free during the *same*
   depth-18 search that already produces sf_truth -- zero extra engine calls.
   reveal_dN = sf_truth(d18) - sf(dN), mover POV.

2. **multipv spread** -- the paper's "branching factor / tree width" idea.
   Asking for multipv=5 instead of multipv=1/2 is one search, marginally more
   expensive, not five. From the position BEFORE the move:
     - multipv_gap_15 = wc(rank1) - wc(rank5)
     - multipv_gap_13 = wc(rank1) - wc(rank3)
     - near_best_count = how many of the top-5 are within 0.05 win-chance of
       rank1 (a "how many moves look about equally good" branching count)

Each feature is then scored the same way as brilliant_probe2_corr.py: Pearson r
and AUC against the yes/no label.

    py -3.13 scripts/brilliant_probe3.py
"""
from __future__ import annotations

import math
import os
from dataclasses import dataclass
from io import StringIO
from typing import List, Optional, Tuple

import chess
import chess.engine
import chess.pgn

from prepforge_chess.core.models import Color
from prepforge_chess.services.classification import win_chance_for_side
from prepforge_chess.services.engine import EngineAnalysisConfig, StockfishEngine

STOCKFISH = os.path.abspath(
    "engines/stockfish/stockfish/stockfish-windows-x86-64-avx2.exe"
)
DEPTH = 18
SHALLOW_DEPTHS = (1, 3, 5, 8)
NEAR_BEST_MARGIN = 0.05


IMMORTAL = """
[White "lawtrafalgar02"]
[Black "opponent"]
[Result "*"]

1. d4 e6 2. Nf3 f5 3. Nc3 Nf6 4. Bg5 Be7 5. Bxf6 Bxf6 6. e4 fxe4 7. Nxe4 b6
8. Ne5 O-O 9. Bd3 Bb7 10. Qh5 Qe7 11. Qxh7+ Kxh7 12. Nxf6+ Kh6 13. Neg4+ Kg5
14. h4+ Kf4 15. g3+ Kf3 16. Be2+ Kg2 17. Rh2+ Kg1 18. Kd2# *
"""

ROTLEWI = """
[White "Georg Rotlewi"]
[Black "Akiba Rubinstein"]
[Result "0-1"]

1. d4 d5 2. Nf3 e6 3. e3 c5 4. c4 Nc6 5. Nc3 Nf6 6. dxc5 Bxc5 7. a3 a6 8. b4 Bd6
9. Bb2 O-O 10. Qd2 Qe7 11. Bd3 dxc4 12. Bxc4 b5 13. Bd3 Rd8 14. Qe2 Bb7 15. O-O
Ne5 16. Nxe5 Bxe5 17. f4 Bc7 18. e4 Rac8 19. e5 Bb6+ 20. Kh1 Ng4 21. Be4 Qh4
22. g3 Rxc3 23. gxh4 Rd2 24. Qxd2 Bxe4+ 25. Qg2 Rh3 0-1
"""

MARSHALL = """
[White "Stefan Levitsky"]
[Black "Frank Marshall"]
[Result "0-1"]

1. e4 e6 2. d4 d5 3. Nc3 c5 4. Nf3 Nc6 5. exd5 exd5 6. Be2 Nf6 7. O-O Be7 8. Bg5
O-O 9. dxc5 Be6 10. Nd4 Bxc5 11. Nxe6 fxe6 12. Bg4 Qd6 13. Bh3 Rae8 14. Qd2 Bb4
15. Bxf6 Rxf6 16. Rad1 Qc5 17. Qe2 Bxc3 18. bxc3 Qxc3 19. Rxd5 Nd4 20. Qh5 Ref8
21. Re5 Rh6 22. Qg5 Rxh3 23. Rc5 Qg3 24. hxg3 Ne2# 0-1
"""

BLITZ_RD2 = """
[White "Surya-darma"]
[Black "Anonymousub"]
[Result "0-1"]

1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 g6 5. Nc3 Bg7 6. Be3 Nf6 7. Bc4 O-O
8. O-O Nxe4 9. Nxe4 d5 10. Bb3 dxe4 11. Nxc6 bxc6 12. c3 Ba6 13. Qxd8 Rfxd8
14. Rfd1 Bd3 15. Rd2 a5 16. Rad1 Rdb8 17. Ba4 Ra6 18. f3 f5 19. Kf2 Be5 20. f4
Bf6 21. g3 Kg7 22. h4 Bb5 23. Bc2 Bc4 24. Bb1 Bd5 25. Bd4 Bxd4+ 26. Rxd4 Rxb2+
27. R4d2 Rxd2+ 28. Rxd2 Rb6 29. Rd1 Rb2+ 30. Ke3 Rg2 31. Kd4 Rxg3 32. c4 Be6
33. Rc1 e3 34. Bd3 Rf3 35. Kc5 Rxf4 36. Kxc6 Rd4 37. Be2 Rd2 38. Bf3 Rxa2 39. c5
Rd2 40. Kc7 a4 41. c6 a3 42. Kb8 Rb2+ 43. Ka7 a2 44. c7 Rb1 45. c8=Q Bxc8 0-1
"""


def _norm(san: str) -> str:
    return san.replace("+", "").replace("#", "").replace("!", "").replace("?", "")


def locate(pgn_text: str, fullmove: int, side: Color, san: str) -> Tuple[str, str]:
    """Return (fen_before, uci) for the targeted move."""
    game = chess.pgn.read_game(StringIO(pgn_text.strip()))
    board = game.board()
    want_white = side is Color.WHITE
    for mv in game.mainline_moves():
        this_full = board.fullmove_number
        this_white = board.turn == chess.WHITE
        this_san = board.san(mv)
        if this_full == fullmove and this_white == want_white and _norm(this_san) == _norm(san):
            return board.fen(), mv.uci()
        board.push(mv)
    raise LookupError("move not found: {0} {1}{2}".format(fullmove, "" if want_white else "...", san))


# (label, expected, pgn, fullmove, side, san)
PGN_TARGETS: List[Tuple[str, str, str, int, Color, str]] = [
    ("Immortal Qxh7+", "yes", IMMORTAL, 11, Color.WHITE, "Qxh7+"),
    ("Rubinstein Rxc3", "yes", ROTLEWI, 22, Color.BLACK, "Rxc3"),
    ("Rubinstein Rd2", "yes", ROTLEWI, 23, Color.BLACK, "Rd2"),
    ("Marshall Qg3", "yes", MARSHALL, 23, Color.BLACK, "Qg3"),
    ("Blitz Rd2 (dud)", "no", BLITZ_RD2, 39, Color.BLACK, "Rd2"),
]


# (label, expected, fen_before, uci, side) -- account-scan hits (from the scan jsonl)
FEN_TARGETS: List[Tuple[str, str, str, str, Color]] = [
    ("#5 28.Qxe4", "yes", "8/1bq3kp/p3Qbp1/1p6/1P1NnP2/P3P3/6PP/4B1K1 w - - 3 28", "e6e4", Color.WHITE),
    ("#6 54...Rxg4", "yes", "6r1/R7/3k1p2/1p2pP2/6P1/1P1p1K2/P7/8 b - - 1 54", "g8g4", Color.BLACK),
    ("#13 29...Bg3", "yes", "r3r1k1/1p3pp1/p6p/2p1b3/P1QpP1P1/4q3/BPP2RR1/6K1 b - - 9 29", "e5g3", Color.BLACK),
    ("#18 13.axb4", "yes", "r4rk1/pp1bppbp/3p2p1/q1pP4/1nP1P3/P1N5/1P1QNPPP/RB3RK1 w - - 1 13", "a3b4", Color.WHITE),

    ("#2 40...Re8", "no", "3k2r1/pb6/1pp1Q3/8/3P1P2/P1P4P/KP6/6r1 b - - 2 40", "g8e8", Color.BLACK),
    ("#4 53.Rf3+", "no", "8/1R6/8/4p3/8/r1nk2P1/1p3RKP/8 w - - 6 53", "f2f3", Color.WHITE),
    ("#7 41.Kf2", "no", "3n1r2/1k1P1P1p/8/4N3/2p5/7p/1P5P/3RK3 w - - 3 41", "e1f2", Color.WHITE),
    ("#8 45...Kc8", "no", "8/3k1p2/3P1Ppp/3K4/6PP/8/8/8 b - - 2 45", "d7c8", Color.BLACK),
    ("#9 65.Qd1", "no", "8/8/3K4/6k1/5n2/8/2Q5/8 w - - 9 65", "c2d1", Color.WHITE),
    ("#10 66...Kg6", "no", "8/5N2/8/6k1/r5p1/6K1/8/8 b - - 7 66", "g5g6", Color.BLACK),
    ("#11 41...Kg7", "no", "8/p6k/4P1p1/q6p/7P/1P1R2P1/2P1K3/8 b - - 4 41", "h7g7", Color.BLACK),
    ("#12 34.Rbf7+", "no", "5k2/1R4R1/7p/3p4/3Pn3/4P2P/1p4PK/1r6 w - - 5 34", "b7f7", Color.WHITE),
    ("#15 35...Qa1+", "no", "4r2k/5p2/2p2prN/p2pp2Q/4P3/4PR2/1q4PP/5K2 b - - 5 35", "b2a1", Color.BLACK),
    ("#16 66.Qc2", "no", "8/1K3p2/5n1k/6pp/8/8/8/2Q5 w - - 0 66", "c1c2", Color.WHITE),
    ("#17 88...Be4", "no", "1R6/8/4p1p1/3n1bk1/3P4/8/5K2/8 b - - 15 88", "f5e4", Color.BLACK),
    ("#19 5.c3", "no", "r1bqk1nr/ppp2ppp/2np4/4p3/8/1P6/PBPPPPPP/RN1QKBNR w KQkq - 0 5", "c2c3", Color.WHITE),
    ("#20 41.Qb7+", "no", "5R2/6kp/6p1/3pP2q/1Q1Pn3/B3P1P1/2p3K1/8 w - - 0 41", "b4b7", Color.WHITE),
    ("#21 33...Re8", "no", "2r4k/6p1/p4p1p/3NnQ2/1p2P3/6KP/Pq6/3B4 b - - 1 33", "c8e8", Color.BLACK),
]


@dataclass
class Row:
    label: str
    expected: str
    sf_truth: Optional[float] = None
    sf_d1: Optional[float] = None
    sf_d3: Optional[float] = None
    sf_d5: Optional[float] = None
    sf_d8: Optional[float] = None
    reveal_d1: Optional[float] = None
    reveal_d3: Optional[float] = None
    reveal_d5: Optional[float] = None
    reveal_d8: Optional[float] = None
    multipv_gap_15: Optional[float] = None
    multipv_gap_13: Optional[float] = None
    near_best_count: Optional[int] = None


def shallow_reveal(engine: StockfishEngine, fen_after: str, side: Color) -> dict:
    """Stream a depth-18 search on fen_after, capturing the win-chance at
    SHALLOW_DEPTHS and the final depth -- all from ONE search."""
    board = engine.chess_core.board(fen_after)
    sf = engine._ensure_engine()
    captured: dict = {}
    with sf.analysis(board, chess.engine.Limit(depth=DEPTH)) as analysis:
        for info in analysis:
            d = info.get("depth")
            if d is None:
                continue
            if d not in captured:
                cfg = EngineAnalysisConfig(depth=d)
                ev = engine._evaluation_from_info(info, config=cfg)
                captured[d] = win_chance_for_side(ev, side)
            if d >= DEPTH:
                break
    return captured


def multipv_spread(engine: StockfishEngine, fen_before: str, side: Color) -> Tuple[List[float], int]:
    cfg = EngineAnalysisConfig(depth=DEPTH, multipv=5)
    pa = engine.analyze_position(fen_before, cfg)
    wcs = [win_chance_for_side(c.evaluation_after, side) for c in pa.candidates]
    near_best = sum(1 for w in wcs if wcs and (wcs[0] - w) <= NEAR_BEST_MARGIN)
    return wcs, near_best


def main():
    targets: List[Tuple[str, str, str, str, Color]] = []
    for label, expected, pgn, fullmove, side, san in PGN_TARGETS:
        fen_before, uci = locate(pgn, fullmove, side, san)
        targets.append((label, expected, fen_before, uci, side))
    targets.extend(FEN_TARGETS)

    engine = StockfishEngine(STOCKFISH, threads=1, options={"UCI_ShowWDL": True})
    rows: List[Row] = []
    try:
        for label, expected, fen_before, uci, side in targets:
            board_before = chess.Board(fen_before)
            mv = chess.Move.from_uci(uci)
            if mv not in board_before.legal_moves:
                print("SKIP (illegal move, FEN mismatch): {0}".format(label))
                continue
            board_after = board_before.copy()
            board_after.push(mv)

            row = Row(label=label, expected=expected)

            captured = shallow_reveal(engine, board_after.fen(), side)
            d18 = captured.get(DEPTH) or captured.get(max(captured))
            row.sf_truth = d18
            for d in SHALLOW_DEPTHS:
                if d in captured and d18 is not None:
                    setattr(row, "sf_d{0}".format(d), captured[d])
                    setattr(row, "reveal_d{0}".format(d), d18 - captured[d])

            wcs, near_best = multipv_spread(engine, fen_before, side)
            if len(wcs) >= 5:
                row.multipv_gap_15 = wcs[0] - wcs[4]
            if len(wcs) >= 3:
                row.multipv_gap_13 = wcs[0] - wcs[2]
            row.near_best_count = near_best

            rows.append(row)
            print("done: {0} ({1}) sf_truth={2}".format(label, expected, fmt(row.sf_truth)))
    finally:
        engine.close()

    print_table(rows)
    correlations(rows)


def fmt(v, spec="{0:.3f}"):
    return spec.format(v) if v is not None else "   -  "


def print_table(rows: List[Row]):
    cols = "{0:<16} {1:<4} {2:>7} {3:>7} {4:>7} {5:>7} {6:>8} {7:>8} {8:>8} {9:>8} {10:>9} {11:>9} {12:>4}"
    print("\n" + cols.format(
        "move", "exp", "sf_d1", "sf_d3", "sf_d5", "sf_d8", "sf_d18",
        "rev_d1", "rev_d3", "rev_d5", "rev_d8", "mpv_15", "near5",
    ))
    for r in rows:
        print(cols.format(
            r.label, r.expected,
            fmt(r.sf_d1), fmt(r.sf_d3), fmt(r.sf_d5), fmt(r.sf_d8), fmt(r.sf_truth),
            fmt(r.reveal_d1, "{0:+.3f}"), fmt(r.reveal_d3, "{0:+.3f}"),
            fmt(r.reveal_d5, "{0:+.3f}"), fmt(r.reveal_d8, "{0:+.3f}"),
            fmt(r.multipv_gap_15, "{0:+.3f}"),
            str(r.near_best_count) if r.near_best_count is not None else " - ",
        ))


def pearson(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    vx = sum((x - mx) ** 2 for x in xs)
    vy = sum((y - my) ** 2 for y in ys)
    if vx == 0 or vy == 0:
        return float("nan")
    return cov / math.sqrt(vx * vy)


def auc(values, labels):
    yes = [v for v, l in zip(values, labels) if l == 1]
    no = [v for v, l in zip(values, labels) if l == 0]
    total = len(yes) * len(no)
    if total == 0:
        return float("nan")
    wins = 0.0
    for y in yes:
        for n in no:
            if y > n:
                wins += 1
            elif y == n:
                wins += 0.5
    return wins / total


def correlations(rows: List[Row]):
    labels = [1 if r.expected == "yes" else 0 for r in rows]
    fields = [
        "reveal_d1", "reveal_d3", "reveal_d5", "reveal_d8",
        "sf_d1", "sf_d3", "sf_d5", "sf_d8",
        "multipv_gap_15", "multipv_gap_13", "near_best_count",
    ]
    print("\n\n================ NEW FEATURES vs yes/no ================")
    print("{0:<18} {1:>8} {2:>6} {3:>9}".format("feature", "r", "AUC", "|AUC-.5|"))
    print("-" * 46)
    results = []
    for f in fields:
        pairs = [(getattr(r, f), l) for r, l in zip(rows, labels) if getattr(r, f) is not None]
        if len(pairs) < len(rows):
            print("{0:<18} (only {1}/{2} rows have data)".format(f, len(pairs), len(rows)))
            continue
        values = [p[0] for p in pairs]
        ls = [p[1] for p in pairs]
        r = pearson(values, ls)
        a = auc(values, ls)
        results.append((f, r, a))
    for f, r, a in sorted(results, key=lambda t: -abs(t[1])):
        print("{0:<18} {1:>8.3f} {2:>6.3f} {3:>9.3f}".format(f, r, a, abs(a - 0.5)))


if __name__ == "__main__":
    main()
