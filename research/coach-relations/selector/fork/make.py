"""False-fork check: every pool card the fork rule (explain.pays) changes, for sol to judge blind.
A card is affected when it loses a fork candidate or its text changes. Cards from the sealed
confirmation set (../confirm) are left out.

  py -B selector/fork/make.py   -> fork/batch-NN.jsonl (judge input), fork-key.jsonl (outside the judge folder)
"""
import json
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import pool  # noqa: E402

explain = pool.explain
BATCH = 30


def coach(r, check):
    real = explain.pays
    if not check:
        explain.pays = lambda f, ln: True
    try:
        rk, e = pool.ranked(r)
        return e["text"], [pool.alone(r, c) for c in rk]
    finally:
        explain.pays = real


def main():
    sealed = {json.loads(l)["id"] for l in (HERE.parent / "confirm/key.jsonl").read_text(encoding="utf-8").splitlines()}
    cards = pool.setup()
    rng = random.Random(20261015)
    items, key = [], []
    for i in sorted(cards):
        if i in sealed:
            continue
        try:
            r = pool.row(cards[i])
            if not r:
                continue
            old, old_c = coach(r, False)
            new, new_c = coach(r, True)
        except pool.CacheMiss:
            continue
        removed = [t for t in dict.fromkeys(old_c) if t not in new_c]
        if not removed and old == new:
            continue
        c = cards[i]
        swap = rng.random() < 0.5
        n = len(items)
        items.append({"n": n, "id": i, "fen": r["fen"], "side_to_move": c["mover"], "grade": r["grade"],
                      "played": c["san"], "best": c["bestSan"],
                      "played_line": explain.Line(r["fen"], r["played_pv"]).seq(1, 99),
                      "best_line": explain.Line(r["fen"], r["best_pv"]).seq(1, 99),
                      "eval_loss_cp": r.get("loss"),
                      "removed": [{"k": k, "text": t} for k, t in enumerate(removed)],
                      "A": None if old == new else (new if swap else old),
                      "B": None if old == new else (old if swap else new)})
        key.append({"n": n, "id": i, "new": None if old == new else ("A" if swap else "B")})
    for b in range(0, len(items), BATCH):
        (HERE / f"batch-{b // BATCH + 1:02d}.jsonl").write_text(
            "".join(json.dumps(o, ensure_ascii=False) + "\n" for o in items[b:b + BATCH]), encoding="utf-8")
    (HERE.parent / "fork-key.jsonl").write_text("".join(json.dumps(o) + "\n" for o in key), encoding="utf-8")
    print(len(items), "affected cards,", sum(k["new"] is not None for k in key), "with a changed text")


if __name__ == "__main__":
    main()
