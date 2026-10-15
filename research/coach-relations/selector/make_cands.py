"""Candidate-level labelling set: one error card per game, from games no earlier label touches,
120 cards with one candidate reason and 240 with two or more. Each candidate is written as the
Coach would write it alone; the judge sees them in shuffled order with no rank.

  py -B selector/make_cands.py      -> cand/batch-NN.jsonl (judge input), cand/key.jsonl (features)
"""
import json
import random
from collections import defaultdict

import pool

N1, N2, BATCH = 120, 240, 30


def main():
    cards = pool.setup()
    used = {json.loads(l)["id"].split("/")[0] for l in open(pool.HERE / "labels.jsonl", encoding="utf-8")}
    by_game = defaultdict(list)
    for i in sorted(cards):
        if i.split("/")[0] not in used:
            by_game[i.split("/")[0]].append(i)
    rng = random.Random(20261015)
    games = sorted(by_game)
    rng.shuffle(games)
    one, many = [], []
    for g in games:
        ids = by_game[g][:]
        rng.shuffle(ids)
        for i in ids:
            r = pool.row(cards[i])
            if not r:
                continue
            rk, e = pool.ranked(r)
            if not rk:
                continue
            want = one if len(rk) == 1 else many
            if len(want) < (N1 if want is one else N2):
                want.append((i, r, rk))
            break  # one card per game
        if len(one) >= N1 and len(many) >= N2:
            break
    picked = one + many
    rng.shuffle(picked)
    items, key = [], []
    for n, (i, r, rk) in enumerate(picked):
        c = cards[i]
        order = list(range(len(rk)))
        rng.shuffle(order)
        items.append({"n": n, "id": i, "fen": r["fen"], "side_to_move": c["mover"], "grade": r["grade"],
                      "played": c["san"], "best": c["bestSan"],
                      "played_line": pool.explain.Line(r["fen"], r["played_pv"]).seq(1, 99),
                      "best_line": pool.explain.Line(r["fen"], r["best_pv"]).seq(1, 99),
                      "eval_loss_cp": r.get("loss"),
                      "candidates": [{"k": k, "text": pool.alone(r, rk[j])} for k, j in enumerate(order)]})
        key.append({"n": n, "id": i, "grade": r["grade"], "loss": r.get("loss"), "move": c["moveNumber"],
                    "rank_of_k": [order.index(j) for j in range(len(rk))],  # rank position -> shown k
                    "facts": [{x: v for x, v in f.items() if x != "text_zh"} for f in rk]})
    out = pool.HERE / "cand"
    for b in range(0, len(items), BATCH):
        (out / f"batch-{b // BATCH + 1:02d}.jsonl").write_text(
            "".join(json.dumps(o, ensure_ascii=False) + "\n" for o in items[b:b + BATCH]), encoding="utf-8")
    (out / "key.jsonl").write_text("".join(json.dumps(o, ensure_ascii=False) + "\n" for o in key), encoding="utf-8")
    print(len(one), "one-candidate cards,", len(many), "multi-candidate cards")


if __name__ == "__main__":
    main()
