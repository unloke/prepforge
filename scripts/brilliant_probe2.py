"""Extended brilliant-detection feature probe.

Combines the original hand-picked reference brilliancies/dud
(``brilliant_probe.py``'s IMMORTAL/ROTLEWI/MARSHALL/BLITZ_RD2) with a
**human-labeled** set of real moves pulled from the 1000-game account scan
(``scripts/out/brilliant_anonymousub.jsonl``). The user reviewed all 21
auto-flagged "Brilliant" candidates and labeled each yes/no/controversial;
controversial ones are dropped here.

Goal: every move in both groups already clears the CURRENT production gate
(unintuitive p<=0.10, reveal>=0.30, sound). So the existing features can't
separate them -- that's exactly the false-positive problem. This probe dumps
the *full* candidate feature vector (including the still-unshipped trap_gap,
policy_entropy, sac_invest, sf_draw, only_move_gap, etc.) for all of them and
reports which single feature, if any, cleanly separates yes from no.

    py -3.13 scripts/brilliant_probe2.py
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from io import StringIO
from typing import List, Optional, Tuple

import chess
import chess.pgn

from prepforge_chess.core.models import Color
from prepforge_chess.services.classification import (
    ClassificationConfig,
    classify_move,
    win_chance_for_side,
)
from prepforge_chess.services.engine import EngineAnalysisConfig, StockfishEngine
from prepforge_chess.services.maia import Maia3Config, create_maia3_adapter

STOCKFISH = os.path.abspath(
    "engines/stockfish/stockfish/stockfish-windows-x86-64-avx2.exe"
)
DEPTH = 18
MAIA_RATING = 1900


# ---------------------------------------------------------------------------
# Reference games (known true brilliancies + one known dud), from brilliant_probe.py
# ---------------------------------------------------------------------------

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


# (label, expected, pgn, fullmove, side, san)
PGN_TARGETS: List[Tuple[str, str, str, int, Color, str]] = [
    ("Immortal Qxh7+", "yes", IMMORTAL, 11, Color.WHITE, "Qxh7+"),
    ("Rubinstein Rxc3", "yes", ROTLEWI, 22, Color.BLACK, "Rxc3"),
    ("Rubinstein Rd2", "yes", ROTLEWI, 23, Color.BLACK, "Rd2"),
    ("Marshall Qg3", "yes", MARSHALL, 23, Color.BLACK, "Qg3"),
    ("Blitz Rd2 (dud)", "no", BLITZ_RD2, 39, Color.BLACK, "Rd2"),
]


def _norm(san: str) -> str:
    return san.replace("+", "").replace("#", "").replace("!", "").replace("?", "")


def locate(pgn_text: str, fullmove: int, side: Color, san: str):
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


# ---------------------------------------------------------------------------
# Account-scan hits, human-labeled (controversial ones dropped)
# (label, expected, fen_before, uci, side)
# ---------------------------------------------------------------------------

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


_PIECE_VAL = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}


def _mover_advantage(board: chess.Board, mover_is_white: bool) -> float:
    adv = 0.0
    for piece in board.piece_map().values():
        v = _PIECE_VAL[piece.piece_type]
        adv += v if (piece.color == chess.WHITE) == mover_is_white else -v
    return adv


def _entropy(probs) -> float:
    import math
    ps = [x for x in probs if x and x > 0]
    total = sum(ps)
    if total <= 0:
        return 0.0
    ps = [x / total for x in ps]
    return -sum(x * math.log2(x) for x in ps)


@dataclass
class Probe:
    label: str
    expected: str
    san: str
    classification: str
    human_p: Optional[float] = None
    top_policy: Optional[float] = None
    top_move: Optional[str] = None
    policy_margin: Optional[float] = None
    maia_glance: Optional[float] = None
    sf_before: Optional[float] = None
    sf_truth: Optional[float] = None
    reveal: Optional[float] = None
    only_move_gap: Optional[float] = None
    trap_gap: Optional[float] = None
    maia_trap_gap: Optional[float] = None
    maia_glance_human: Optional[float] = None
    policy_entropy: Optional[float] = None
    sac_invest: Optional[float] = None
    sf_draw: Optional[float] = None
    is_capture: Optional[bool] = None
    is_check: Optional[bool] = None


def probe(label, expected, fen_before, uci, side, engine, maia) -> Probe:
    cfg = EngineAnalysisConfig(depth=DEPTH, multipv=1)
    cfg2 = EngineAnalysisConfig(depth=DEPTH, multipv=2)
    mover_white = side is Color.WHITE

    board_before = chess.Board(fen_before)
    mv = chess.Move.from_uci(uci)
    real_san = board_before.san(mv)
    board_after = board_before.copy()
    board_after.push(mv)
    fen_after = board_after.fen()

    pa = engine.analyze_position(fen_before, cfg2)
    eval_after = engine.analyze_position(fen_after, cfg).evaluation
    best_after = pa.best_evaluation_after or eval_after
    cls = classify_move(
        side_to_move=side,
        played_move_uci=uci,
        best_move_uci=pa.best_move_uci,
        played_eval_after=eval_after,
        best_eval_after=best_after,
        config=ClassificationConfig(),
    )

    p = Probe(label=label, expected=expected, san=real_san, classification=cls.classification.value)

    p.is_capture = board_before.is_capture(mv)
    p.is_check = board_before.gives_check(mv)

    if len(pa.candidates) >= 2:
        wc_best = win_chance_for_side(pa.candidates[0].evaluation_after, side)
        wc_2nd = win_chance_for_side(pa.candidates[1].evaluation_after, side)
        p.only_move_gap = wc_best - wc_2nd

    assessment = maia.move_assessment(fen_before, uci, rating=MAIA_RATING)
    preds = maia.predictions(fen_before, rating=MAIA_RATING)
    if assessment is not None:
        hp, glance = assessment
        p.human_p = hp
        p.maia_glance = glance
        p.sf_before = win_chance_for_side(pa.evaluation, side)
        p.sf_truth = win_chance_for_side(eval_after, side)
        p.reveal = p.sf_truth - glance
    if preds:
        p.top_policy = preds[0].probability
        p.policy_entropy = _entropy([pr.probability for pr in preds])
        try:
            top_uci = preds[0].move_uci
            p.top_move = board_before.san(chess.Move.from_uci(top_uci))
        except Exception:
            p.top_move = preds[0].move_uci
        if p.human_p is not None:
            p.policy_margin = p.top_policy - p.human_p
        if preds[0].move_uci != uci:
            human_assess = maia.move_assessment(fen_before, preds[0].move_uci, rating=MAIA_RATING)
            if human_assess is not None and p.maia_glance is not None:
                p.maia_glance_human = human_assess[1]
                p.maia_trap_gap = p.maia_glance - p.maia_glance_human
            if p.sf_truth is not None:
                try:
                    hb = chess.Board(fen_before)
                    hb.push(chess.Move.from_uci(preds[0].move_uci))
                    human_eval = engine.analyze_position(hb.fen(), cfg).evaluation
                    p.trap_gap = p.sf_truth - win_chance_for_side(human_eval, side)
                except Exception:
                    pass

    adv_before = _mover_advantage(board_before, mover_white)
    b2 = chess.Board(fen_after)
    reply_pv = eval_after.pv or []
    if reply_pv:
        try:
            b2.push(chess.Move.from_uci(reply_pv[0]))
        except Exception:
            pass
    p.sac_invest = adv_before - _mover_advantage(b2, mover_white)

    if eval_after.wdl:
        p.sf_draw = eval_after.wdl.get("white_draw")
    return p


def fmt(v, spec="{0:.3f}"):
    return spec.format(v) if v is not None else "   -  "


GATES = [
    ("human_p (low)", lambda p: p.human_p, "low"),
    ("maia_glance (low)", lambda p: p.maia_glance, "low"),
    ("reveal (high)", lambda p: p.reveal, "high"),
    ("sf_before (low)", lambda p: p.sf_before, "low"),
    ("sf_truth (high)", lambda p: p.sf_truth, "high"),
    ("top_policy (high)", lambda p: p.top_policy, "high"),
    ("policy_margin (high)", lambda p: p.policy_margin, "high"),
    ("only_move_gap (high)", lambda p: p.only_move_gap, "high"),
    ("trap_gap SF (high)", lambda p: p.trap_gap, "high"),
    ("maia_trap_gap (high)", lambda p: p.maia_trap_gap, "high"),
    ("maia_trap_gap (low)", lambda p: p.maia_trap_gap, "low"),
    ("policy_entropy (low)", lambda p: p.policy_entropy, "low"),
    ("policy_entropy (high)", lambda p: p.policy_entropy, "high"),
    ("sac_invest (high)", lambda p: p.sac_invest, "high"),
    ("sf_draw (low)", lambda p: p.sf_draw, "low"),
    ("sf_draw (high)", lambda p: p.sf_draw, "high"),
]


def separation(probes: List[Probe]):
    yes = [p for p in probes if p.expected == "yes"]
    no = [p for p in probes if p.expected == "no"]
    print("\n\n================ GATE SEPARATION (yes vs no) ================")
    print("yes={0}, no={1}".format(len(yes), len(no)))
    print("A gate 'separates' if one threshold keeps every YES and drops every NO.\n")
    found_any = False
    for name, acc, direction in GATES:
        ys = [acc(p) for p in yes if acc(p) is not None]
        ns = [acc(p) for p in no if acc(p) is not None]
        if not ys or not ns:
            print("  {0:<24} (insufficient data: yes={1} no={2})".format(name, len(ys), len(ns)))
            continue
        if direction == "low":
            worst_yes = max(ys)
            best_no = min(ns)
            ok = worst_yes < best_no
            window = "yes<= up to {0:.3f}, no>= down to {1:.3f}".format(worst_yes, best_no)
        else:
            worst_yes = min(ys)
            best_no = max(ns)
            ok = worst_yes > best_no
            window = "yes>= down to {0:.3f}, no<= up to {1:.3f}".format(worst_yes, best_no)
        gap = abs(worst_yes - best_no)
        spread = (max(ys) - min(ys)) or 1e-9
        norm = gap / spread
        if ok:
            found_any = True
            verdict = "** SEPARATES ** gap={0:.3f} norm={1:.2f}".format(gap, norm)
        else:
            verdict = "overlaps"
        print("  {0:<24} {1:<28} {2}".format(name, verdict, window))
    if not found_any:
        print("\n  No single feature cleanly separates yes from no.")


def main():
    engine = StockfishEngine(STOCKFISH, threads=1, options={"UCI_ShowWDL": True})
    maia = create_maia3_adapter(config=Maia3Config(default_rating=MAIA_RATING))

    probes: List[Probe] = []
    try:
        for label, expected, pgn, fullmove, side, san in PGN_TARGETS:
            fen_before, uci = locate(pgn, fullmove, side, san)
            p = probe(label, expected, fen_before, uci, side, engine, maia)
            probes.append(p)
            print("done: {0} ({1})".format(label, expected))
        for label, expected, fen_before, uci, side in FEN_TARGETS:
            p = probe(label, expected, fen_before, uci, side, engine, maia)
            probes.append(p)
            print("done: {0} ({1})".format(label, expected))
    finally:
        engine.close()

    cols = "{0:<16} {1:<4} {2:<10} {3:<8} {4:<8} {5:<8} {6:<9} {7:<10} {8:<10} {9:<8} {10:<8} {11:<8} {12:<8} {13:<8}"
    print("\n" + cols.format(
        "move", "exp", "class", "human_p", "glance", "reveal",
        "trap_SF", "trap_maia", "p_entr", "margin", "sac", "sf_draw", "sf_tru", "sf_bef",
    ))
    for p in probes:
        print(cols.format(
            p.label, p.expected, p.classification,
            fmt(p.human_p), fmt(p.maia_glance), fmt(p.reveal, "{0:+.3f}"),
            fmt(p.trap_gap, "{0:+.3f}"), fmt(p.maia_trap_gap, "{0:+.3f}"),
            fmt(p.policy_entropy, "{0:.2f}"), fmt(p.policy_margin),
            fmt(p.sac_invest, "{0:+.1f}"), fmt(p.sf_draw), fmt(p.sf_truth), fmt(p.sf_before),
        ))

    separation(probes)


if __name__ == "__main__":
    main()
