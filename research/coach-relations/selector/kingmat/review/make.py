"""Sol's small review after the two fixes (kingmat/ab disputes + the material quote): old and new text
in random order. Kingmat part: the A/B cards Muse disputed that still carry a threat (old = no threat,
current quote). Quote part: 25 random cards whose text the quote fix changed (old/new from pool
snapshots). Lines are the engine lines with Stockfish's capture tail, as the Coach quotes them.

  py -B selector/kingmat/review/make.py SNAP_OLD.json SNAP_NEW.json CHANGED.json
"""
import json
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SEL = HERE.parents[1]
sys.path.insert(0, str(SEL))
import pool  # noqa: E402

explain = pool.explain
DISPUTED = [36, 59, 60, 73, 81, 89, 100, 105, 110, 111, 120, 143, 154, 181, 189, 193]


def text(r, on):
    real = explain.threatened
    if not on:
        explain.threatened = lambda facts, ranked, ext: facts
    try:
        return explain.explain(r)["text"]
    finally:
        explain.threatened = real


def lines(r):
    root = explain.chess.Board(r["fen"])
    out = {}
    for k in ("played", "best"):
        ln = explain.Line(r["fen"], r[f"{k}_pv"])
        tail = [] if ln.boards[-1].is_game_over() else explain.tactics.tail(ln.boards[-1], root.turn)[0]
        out[k] = explain.Line(r["fen"], ln.moves + [explain.chess.Move.from_uci(u) for u in tail]).seq(1, 99)
    return out


def main():
    snap_old, snap_new, changed = (json.loads(Path(p).read_text(encoding="utf-8")) for p in sys.argv[1:4])
    sealed = {json.loads(l)["id"] for l in (SEL / "confirm/key.jsonl").read_text(encoding="utf-8").splitlines()}
    ab = {o["n"]: o["id"] for p in (HERE.parent / "ab").glob("batch-*.jsonl") for o in map(json.loads, p.open(encoding="utf-8"))}
    cards, rng, pairs = pool.setup(), random.Random(20261016), []
    for n in DISPUTED:
        r = pool.row(cards[ab[n]])
        old, new = text(r, False), text(r, True)
        if old != new:
            pairs.append(("kingmat", ab[n], old, new))
    for i in rng.sample(sorted(i for i in changed["q"] if i not in sealed), 25):
        pairs.append(("quote", i, snap_old[i]["text"], snap_new[i]["text"]))
    rng.shuffle(pairs)
    items, key = [], []
    for n, (part, i, old, new) in enumerate(pairs):
        r, c, swap = pool.row(cards[i]), cards[i], rng.random() < 0.5
        ls = lines(r)
        items.append({"n": n, "id": i, "fen": r["fen"], "side_to_move": c["mover"], "grade": r["grade"],
                      "played": c["san"], "best": c["bestSan"], "played_line": ls["played"], "best_line": ls["best"],
                      "eval_loss_cp": r.get("loss"), "A": new if swap else old, "B": old if swap else new})
        key.append({"n": n, "id": i, "part": part, "new": "A" if swap else "B"})
    (HERE / "batch-01.jsonl").write_text("".join(json.dumps(o, ensure_ascii=False) + "\n" for o in items), encoding="utf-8")
    (SEL / "kingmat-review-key.jsonl").write_text("".join(json.dumps(o) + "\n" for o in key), encoding="utf-8")
    print(len(items), "cards:", sum(p[0] == "kingmat" for p in pairs), "kingmat,", sum(p[0] == "quote" for p in pairs), "quote")


if __name__ == "__main__":
    main()
