"""Research only. Picks the positions for the reason review and writes review/set.json.

  py research/coach-relations/review/build_set.py           # round 1 -> set.json
  py research/coach-relations/review/build_set.py --r2      # round 2 -> set-r2.json

From positions.jsonl: inaccuracies, mistakes and blunders whose played move is not the engine
move, one per game, no game from the v7 spot check (those tuned the enumerator), 45 of each
grade at most, interleaved by grade in a fixed shuffled order, 120 in all. Each item carries both lines move by move and the enumerator's
candidates, which the page shows only after the reviewer has written their own reason.
Round 2 keeps the same positions and ids minus those reviewed in LABELS.json, with candidates
from the current enumerator (round 1 tuned it, so only unseen positions measure it).
"""
import json
import pathlib
import random
from itertools import zip_longest
import sys

import chess

HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
from enumerate import candidates  # noqa: E402

TOTAL, PER_GRADE = 120, 45


def line(fen, pv):
    b = chess.Board(fen)
    out = []
    for u in pv:
        m = chess.Move.from_uci(u)
        if m not in b.legal_moves:
            break
        out.append({"san": b.san(m), "uci": u})
        b.push(m)
        out[-1]["fen"] = b.fen()
    return out


def main():
    rows = [json.loads(l) for l in (HERE.parent / "positions.jsonl").read_text(encoding="utf-8").splitlines()]
    tuned = {r["id"].split("/")[0] for r in rows if r["chk"]}
    pool = [r for r in rows if r["grade"] in ("inaccuracy", "mistake", "blunder")
            and r["played_pv"][:1] != r["best_pv"][:1] and r["id"].split("/")[0] not in tuned]
    rng = random.Random(20261013)
    rng.shuffle(pool)
    games, picked = set(), {"inaccuracy": [], "mistake": [], "blunder": []}
    for r in pool:
        g = r["id"].split("/")[0]
        if g not in games and len(picked[r["grade"]]) < PER_GRADE:
            games.add(g)
            picked[r["grade"]].append(r)
    items = [r for trio in zip_longest(*picked.values()) for r in trio if r][:TOTAL]
    r2 = "--r2" in sys.argv
    seen = {x["pos_id"] for x in json.loads((HERE / "LABELS.json").read_text(encoding="utf-8"))["reviews"]
            if x["submitted_at"]} if r2 else set()
    out = []
    for n, r in enumerate(items, 1):
        if f"rr-{n:03d}" in seen:
            continue
        b = chess.Board(r["fen"])
        out.append({"pos_id": f"rr-{n:03d}", "card": r["id"], "grade": r["grade"], "fen": r["fen"],
                    "side": "white" if b.turn else "black", "move_number": b.fullmove_number,
                    "lines": {"played": line(r["fen"], r["played_pv"]), "best": line(r["fen"], r["best_pv"])},
                    "candidates": candidates(r)})
    (HERE / ("set-r2.json" if r2 else "set.json")).write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(len(out), "positions", {k: len(v) for k, v in picked.items()})


if __name__ == "__main__":
    main()
