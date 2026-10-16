"""Blind A/B of the material + mate-threat sentence (explain.threatened): every pool card whose text
it changes, old and new in random order. Cards from the sealed confirmation set are left out.

  py -B selector/kingmat/ab/make.py   -> ab/batch-NN.jsonl (judge input), ../../kingmat-ab-key.jsonl
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
BATCH = 25


def text(r, on):
    real = explain.threatened
    if not on:
        explain.threatened = lambda facts, ranked, ext: facts
    try:
        return explain.explain(r)["text"]
    finally:
        explain.threatened = real


def main():
    sealed = {json.loads(l)["id"] for l in (SEL / "confirm/key.jsonl").read_text(encoding="utf-8").splitlines()}
    cards = pool.setup()
    rng = random.Random(20261016)
    items, key = [], []
    for i in sorted(cards):
        if i in sealed:
            continue
        try:
            r = pool.row(cards[i])
            if not r:
                continue
            old, new = text(r, False), text(r, True)
        except pool.CacheMiss:
            continue
        if old == new:
            continue
        c, swap, n = cards[i], rng.random() < 0.5, len(items)
        items.append({"n": n, "id": i, "fen": r["fen"], "side_to_move": c["mover"], "grade": r["grade"],
                      "played": c["san"], "best": c["bestSan"],
                      "played_line": explain.Line(r["fen"], r["played_pv"]).seq(1, 99),
                      "best_line": explain.Line(r["fen"], r["best_pv"]).seq(1, 99),
                      "eval_loss_cp": r.get("loss"), "A": new if swap else old, "B": old if swap else new})
        key.append({"n": n, "id": i, "new": "A" if swap else "B"})
    for b in range(0, len(items), BATCH):
        (HERE / f"batch-{b // BATCH + 1:02d}.jsonl").write_text(
            "".join(json.dumps(o, ensure_ascii=False) + "\n" for o in items[b:b + BATCH]), encoding="utf-8")
    (SEL / "kingmat-ab-key.jsonl").write_text("".join(json.dumps(o) + "\n" for o in key), encoding="utf-8")
    print(len(items), "changed cards")


if __name__ == "__main__":
    main()
