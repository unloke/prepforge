"""Empirical calibration: phase-bucketed sharpness on Maia3's WDL.

Maia self-plays several games (human-like -> realistic positions across all
phases). Every position is labelled by phase using lichess's (scalachess)
Divider, and two candidate "sharpness" signals are measured:

  - lc0wdl : (2 / (ln(1/W-1)+ln(1/L-1)))^2   -- the LC0 draw-based formula.
  - volat  : stdev of win-chance(mover) across the top human-plausible moves
             -- "how much does a slightly-off move cost you" (easy to mess up).

We print per-phase percentiles so the coach can use phase-relative thresholds
instead of one global cutoff (an opening is never "calm"; an endgame often is).

Run: py -3.13 scripts/maia3_sharpness_probe.py
"""
from __future__ import annotations

import math
import random
import statistics
import sys

import chess
import torch

from prepforge_chess.services.maia import Maia3Adapter, Maia3Config
from maia3.uci import invert_wdl, wdl_from_value_logits
from maia3.dataset import get_legal_moves_mask

ELO = 1500
N_GAMES = 8
MAX_PLIES = 70
TOP_K_VOLATILITY = 5  # how many human-plausible moves to weigh for volatility
random.seed(7)

# ---- lichess / scalachess phase division ------------------------------------
_MIX = {
    (0, 0): 0, (1, 0): 1, (2, 0): 2, (3, 0): 3, (4, 0): 3,
    (0, 1): 1, (1, 1): 5, (2, 1): 4, (3, 1): 3,
    (0, 2): 2, (1, 2): 4, (2, 2): 7,
    (0, 3): 3, (1, 3): 3, (0, 4): 3,
}


def _mixedness(board: chess.Board) -> int:
    total = 0
    for y in range(7):
        for x in range(7):
            w = b = 0
            for dy in (0, 1):
                for dx in (0, 1):
                    p = board.piece_at(chess.square(x + dx, y + dy))
                    if p:
                        if p.color == chess.WHITE:
                            w += 1
                        else:
                            b += 1
            total += _MIX.get((w, b), 0)
    return total


def phase_of(board: chess.Board) -> str:
    mm = sum(
        1 for p in board.piece_map().values()
        if p.piece_type not in (chess.KING, chess.PAWN)
    )
    if mm <= 6:
        return "endgame"
    white_r1 = sum(
        1 for f in range(8)
        if (p := board.piece_at(chess.square(f, 0))) and p.color == chess.WHITE
    )
    black_r8 = sum(
        1 for f in range(8)
        if (p := board.piece_at(chess.square(f, 7))) and p.color == chess.BLACK
    )
    sparse = white_r1 < 4 or black_r8 < 4
    if mm <= 10 or sparse or _mixedness(board) > 150:
        return "middlegame"
    return "opening"


def lc0_sharpness(win01: float, loss01: float) -> float:
    eps = 1e-3
    w = min(max(win01, eps), 1 - eps)
    l = min(max(loss01, eps), 1 - eps)
    denom = math.log(1 / w - 1) + math.log(1 / l - 1)
    if abs(denom) < 1e-6:
        denom = 1e-6 if denom >= 0 else -1e-6
    return (2 / denom) ** 2


def main() -> int:
    adapter = Maia3Adapter(Maia3Config())
    engine = adapter._ensure_engine()  # noqa: SLF001
    device = engine.cfg.device
    elos = torch.tensor([ELO], dtype=torch.long, device=device)
    print(f"device={device} games={N_GAMES} max_plies={MAX_PLIES}\n")

    def forward(board):
        """(ranked [(prob, move)], (W,D,L) mover-POV permille) for a position."""
        engine.board = board
        engine._reset_history()  # noqa: SLF001
        engine.self_elo = ELO
        engine.oppo_elo = ELO
        mask = get_legal_moves_mask(board, engine.all_moves_dict).to(device)
        tok = engine._tokens_from_history(engine.history).unsqueeze(0).to(device)  # noqa: SLF001
        with torch.no_grad():
            lm, vl, _ = engine.model(tok, elos, elos)
        logits = lm[0].float().masked_fill(~mask, float("-inf"))
        probs = torch.softmax(logits, dim=-1)
        ranked = []
        for idx in torch.nonzero(probs > 1e-6).flatten().tolist():
            mv = engine._move_from_index(idx)  # noqa: SLF001
            if mv is not None:
                ranked.append((float(probs[idx]), mv))
        ranked.sort(key=lambda t: -t[0])
        w, d, l = wdl_from_value_logits(vl[0])
        return ranked, (w, d, l)

    def win_chance_after(board, move):
        engine.board = board
        engine._reset_history()  # noqa: SLF001
        ct = engine._tokens_from_history(engine._history_after_move(move)).unsqueeze(0).to(device)  # noqa: SLF001
        with torch.no_grad():
            _, cv, _ = engine.model(ct, elos, elos)
        cw, cd, cl = invert_wdl(wdl_from_value_logits(cv[0]))
        return (cw + 0.5 * cd) / 1000.0

    rows = {"opening": [], "middlegame": [], "endgame": []}
    for g in range(N_GAMES):
        board = chess.Board()
        for _ply in range(MAX_PLIES):
            if board.is_game_over():
                break
            ranked, (w, d, l) = forward(board)
            if not ranked:
                break
            ph = phase_of(board)
            top_prob = ranked[0][0]
            plausible = sum(1 for p, _ in ranked if p >= 0.10)
            lc0 = lc0_sharpness(w / 1000.0, l / 1000.0)
            cand = [mv for p, mv in ranked if p >= 0.05][:TOP_K_VOLATILITY] or [ranked[0][1]]
            wcs = [win_chance_after(board, mv) for mv in cand]
            volat = statistics.pstdev(wcs) if len(wcs) > 1 else 0.0
            rows[ph].append((lc0, volat, d, top_prob, plausible))
            # Continue the game: sample from policy (temp) for variety.
            r = random.random()
            acc = 0.0
            chosen = ranked[0][1]
            for p, mv in ranked:
                acc += p
                if acc >= r:
                    chosen = mv
                    break
            board.push(chosen)

    def pctl(xs, q):
        if not xs:
            return float("nan")
        xs = sorted(xs)
        i = min(len(xs) - 1, max(0, int(q * (len(xs) - 1))))
        return xs[i]

    print(f"{'phase':11s} {'n':>4s} | {'lc0wdl  p25/p50/p75/p90':>30s} | "
          f"{'volatility p25/p50/p75/p90':>32s} | {'drawPM med':>10s} {'top% med':>8s}")
    print("-" * 110)
    for ph in ("opening", "middlegame", "endgame"):
        data = rows[ph]
        if not data:
            print(f"{ph:11s}    0 |  (no samples)")
            continue
        lc0s = [r[0] for r in data]
        vol = [r[1] for r in data]
        draws = [r[2] for r in data]
        tops = [r[3] for r in data]
        print(
            f"{ph:11s} {len(data):4d} | "
            f"{pctl(lc0s,.25):6.1f}/{pctl(lc0s,.5):6.1f}/{pctl(lc0s,.75):6.1f}/{pctl(lc0s,.9):6.1f} | "
            f"{pctl(vol,.25):.3f}/{pctl(vol,.5):.3f}/{pctl(vol,.75):.3f}/{pctl(vol,.9):.3f} | "
            f"{statistics.median(draws):9.0f} {statistics.median(tops)*100:7.0f}%"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
