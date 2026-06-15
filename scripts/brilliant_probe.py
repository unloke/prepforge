"""Brilliant-detection feature probe over a labeled set of real moves.

Unlike ``brilliant_tune.py`` (which sweeps every ply of a game and is slow), this
probe targets a small, hand-labeled set of moves -- known true brilliancies and
known false positives -- and dumps the *full* candidate feature vector for each
so we can see, empirically, which signal (or threshold) actually separates the
real brilliancies from the duds.

    py -3.13 scripts/brilliant_probe.py

Each TARGET is (label, expected, pgn, fullmove, side, san). ``expected`` is one
of "yes" (should be flagged Brilliant), "no" (must NOT be), or "meh" (borderline,
informational only). The probe locates the move by (fullmove, side, san), runs
the real Stockfish + Maia3 stack on that one ply, and reports:

    human_p       Maia3 policy prob of the played move (low = unintuitive)
    top_policy    Maia3 policy prob of its single most-likely move
    policy_margin top_policy - human_p (high = humans clearly prefer something else)
    maia_glance   Maia3 value of the resulting position, mover POV (low = looks bad)
    sf_before     Stockfish win-chance BEFORE the move, mover POV (high = already winning)
    sf_truth      Stockfish win-chance AFTER the move, mover POV
    reveal        sf_truth - maia_glance (high = looks bad but is good)

Then it scores each candidate gate by whether a single threshold cleanly
separates every "yes" from every "no".
"""
from __future__ import annotations

import os
import sys
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
ELIGIBLE = {"best", "excellent"}


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
TARGETS: List[Tuple[str, str, str, int, Color, str]] = [
    ("Immortal Qxh7+", "yes", IMMORTAL, 11, Color.WHITE, "Qxh7+"),
    ("Rubinstein Rxc3", "yes", ROTLEWI, 22, Color.BLACK, "Rxc3"),
    ("Rubinstein Rd2", "yes", ROTLEWI, 23, Color.BLACK, "Rd2"),
    ("Marshall Qg3", "yes", MARSHALL, 23, Color.BLACK, "Qg3"),
    ("Marshall Rh6", "meh", MARSHALL, 21, Color.BLACK, "Rh6"),
    ("Blitz Rd2 (dud)", "no", BLITZ_RD2, 39, Color.BLACK, "Rd2"),
]


def _norm(san: str) -> str:
    return san.replace("+", "").replace("#", "").replace("!", "").replace("?", "")


def locate(pgn_text: str, fullmove: int, side: Color, san: str):
    """Return (fen_before, fen_after, uci, san) for the targeted move."""
    game = chess.pgn.read_game(StringIO(pgn_text.strip()))
    board = game.board()
    want_white = side is Color.WHITE
    for mv in game.mainline_moves():
        this_full = board.fullmove_number
        this_white = board.turn == chess.WHITE
        this_san = board.san(mv)
        if this_full == fullmove and this_white == want_white and _norm(this_san) == _norm(san):
            fen_before = board.fen()
            board.push(mv)
            return fen_before, board.fen(), mv.uci(), this_san
        board.push(mv)
    raise LookupError("move not found: {0} {1}{2}".format(fullmove, "" if want_white else "...", san))


_PIECE_VAL = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}


def _mover_advantage(board: chess.Board, mover_is_white: bool) -> float:
    """Material balance in pawns from the mover's POV."""
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
    # --- untested candidates ---
    only_move_gap: Optional[float] = None   # SF: wc(best) - wc(2nd best), mover POV
    trap_gap: Optional[float] = None        # SF: truth(played) - truth(human's top-policy move)
    maia_trap_gap: Optional[float] = None   # MAIA value: glance(played) - glance(human's top move) [free, no SF]
    maia_glance_human: Optional[float] = None  # MAIA value after the human's top-policy move
    policy_entropy: Optional[float] = None  # Maia: entropy of policy over top-N (bits)
    sac_invest: Optional[float] = None      # material the mover is down 2-ply later (pawns)
    sf_draw: Optional[float] = None         # SF WDL draw prob after the move (sharpness; low = decisive)
    is_capture: Optional[bool] = None
    is_check: Optional[bool] = None


def probe_move(label, expected, pgn, fullmove, side, san, engine, maia) -> Probe:
    fen_before, fen_after, uci, real_san = locate(pgn, fullmove, side, san)
    cfg = EngineAnalysisConfig(depth=DEPTH, multipv=1)
    cfg2 = EngineAnalysisConfig(depth=DEPTH, multipv=2)
    mover_white = side is Color.WHITE

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

    board_before = chess.Board(fen_before)
    mv = chess.Move.from_uci(uci)
    p.is_capture = board_before.is_capture(mv)
    p.is_check = board_before.gives_check(mv)

    # only-move gap: how far the best move stands above the 2nd best.
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
        # trap gaps: how much worse is the move a human would actually pick?
        # SF version (objective truth, costs 1 extra SF eval) and the Maia-value
        # version (human glance, free -- just one more Maia forward).
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

    # sacrifice investment: material the mover is down two plies later (after the
    # opponent's best reply). Positive = the move gave material up.
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
        p.sf_draw = eval_after.wdl.get("white_draw")  # draw prob is side-agnostic
    return p


def fmt(v, spec="{0:.3f}"):
    return spec.format(v) if v is not None else "   -  "


# (name, accessor, direction) -- direction "low" means a brilliancy wants a LOW
# value (so the gate is value <= threshold); "high" means it wants a HIGH value.
GATES = [
    ("human_p (low)", lambda p: p.human_p, "low"),
    ("maia_glance (low)", lambda p: p.maia_glance, "low"),
    ("reveal (high)", lambda p: p.reveal, "high"),
    ("sf_before (low)", lambda p: p.sf_before, "low"),
    ("top_policy (high)", lambda p: p.top_policy, "high"),
    ("policy_margin (high)", lambda p: p.policy_margin, "high"),
    ("only_move_gap (high)", lambda p: p.only_move_gap, "high"),
    ("trap_gap SF (high)", lambda p: p.trap_gap, "high"),
    ("maia_trap_gap (high)", lambda p: p.maia_trap_gap, "high"),
    ("maia_trap_gap (low)", lambda p: p.maia_trap_gap, "low"),
    ("policy_entropy (low)", lambda p: p.policy_entropy, "low"),
    ("sac_invest (high)", lambda p: p.sac_invest, "high"),
    ("sf_draw (low)", lambda p: p.sf_draw, "low"),
]


def separation(probes: List[Probe]):
    """For each candidate gate, can one threshold split every yes from every no?"""
    yes = [p for p in probes if p.expected == "yes"]
    no = [p for p in probes if p.expected == "no"]
    print("\n\n================ GATE SEPARATION (yes vs no) ================")
    print("A gate 'separates' if one threshold keeps every YES and drops every NO.\n")
    for name, acc, direction in GATES:
        ys = [acc(p) for p in yes if acc(p) is not None]
        ns = [acc(p) for p in no if acc(p) is not None]
        if not ys or not ns:
            print("  {0:<22} (insufficient data)".format(name))
            continue
        if direction == "low":
            worst_yes = max(ys)   # the yes that is hardest to keep
            best_no = min(ns)     # the no that is hardest to drop
            ok = worst_yes < best_no
            window = "yes<= up to {0:.3f}, no>= down to {1:.3f}".format(worst_yes, best_no)
        else:
            worst_yes = min(ys)
            best_no = max(ns)
            ok = worst_yes > best_no
            window = "yes>= down to {0:.3f}, no<= up to {1:.3f}".format(worst_yes, best_no)
        gap = abs(worst_yes - best_no)
        spread = (max(ys) - min(ys)) or 1e-9
        norm = gap / spread  # robustness: gap relative to how scattered the YESes are
        verdict = "SEP gap={0:.3f} norm={1:.2f}".format(gap, norm) if ok else "overlaps"
        print("  {0:<22} {1:<24} {2}".format(name, verdict, window))


def main():
    engine = StockfishEngine(STOCKFISH, threads=1, options={"UCI_ShowWDL": True})
    maia = create_maia3_adapter(config=Maia3Config(default_rating=MAIA_RATING))

    probes: List[Probe] = []
    try:
        for label, expected, pgn, fullmove, side, san in TARGETS:
            p = probe_move(label, expected, pgn, fullmove, side, san, engine, maia)
            probes.append(p)
            print("done: {0}".format(label))
    finally:
        engine.close()

    cols = "{0:<18} {1:<4} {2:<10} {3:<8} {4:<8} {5:<8} {6:<9} {7:<10} {8:<8} {9:<8} {10:<8} {11:<8} {12:<8}"
    print("\n" + cols.format(
        "move", "exp", "class", "human_p", "glance", "reveal",
        "trap_SF", "trap_maia", "p_entr", "margin", "sac", "sf_draw", "sf_tru",
    ))
    for p in probes:
        print(cols.format(
            p.label, p.expected, p.classification,
            fmt(p.human_p), fmt(p.maia_glance), fmt(p.reveal, "{0:+.3f}"),
            fmt(p.trap_gap, "{0:+.3f}"), fmt(p.maia_trap_gap, "{0:+.3f}"),
            fmt(p.policy_entropy, "{0:.2f}"), fmt(p.policy_margin),
            fmt(p.sac_invest, "{0:+.1f}"), fmt(p.sf_draw), fmt(p.sf_truth),
        ))

    separation(probes)


if __name__ == "__main__":
    main()
