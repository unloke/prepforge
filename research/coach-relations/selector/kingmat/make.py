"""Material and king safety: which pool cards need both in one sentence? Every pool card whose
candidates (after explain.said) hold a material fact and a mate threat or lost castling in the
same line, for sol to judge. Cards from the sealed confirmation set (../confirm) are left out.

  py -B selector/kingmat/make.py   -> kingmat/batch-NN.jsonl (judge input), ../kingmat-key.jsonl
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
KING = ("mate_threat", "castling")


def relation(m, k):
    if k["type"] == "castling":
        return "castle_first" if k["ply"] < m["ply"] else "castle_same_or_after"
    return "same" if k["ply"] == m["ply"] else "threat_first" if k["ply"] < m["ply"] else "threat_after"


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
            rk, e = pool.ranked(r)
        except pool.CacheMiss:
            continue
        for line in ("played", "best"):
            ms = [c for c in rk if c["type"] == "material" and c["line"] == line]
            ks = [c for c in rk if c["type"] in KING and c["line"] == line]
            if not ms or not ks:
                continue
            m = max(ms, key=lambda c: c["net"])
            facts = [m] + ks
            texts = list(dict.fromkeys(pool.alone(r, c) for c in facts))
            order = list(range(len(texts)))
            rng.shuffle(order)
            c = cards[i]
            n = len(items)
            items.append({"n": n, "id": i, "fen": r["fen"], "side_to_move": c["mover"], "grade": r["grade"],
                          "played": c["san"], "best": c["bestSan"],
                          "played_line": explain.Line(r["fen"], r["played_pv"]).seq(1, 99),
                          "best_line": explain.Line(r["fen"], r["best_pv"]).seq(1, 99),
                          "eval_loss_cp": r.get("loss"),
                          "candidates": [{"k": k, "text": texts[j]} for k, j in enumerate(order)]})
            src = {t: f for f in reversed(facts) for t in [pool.alone(r, f)]}
            key.append({"n": n, "id": i, "line": line, "shown": e["text"], "top": rk[0]["type"], "top_line": rk[0]["line"],
                        "relation": relation(m, ks[0]), "kinds": [src[texts[j]]["type"] for j in order], "facts": facts})
    rng.shuffle(idx := list(range(len(items))))
    for b in range(0, len(items), BATCH):
        (HERE / f"batch-{b // BATCH + 1:02d}.jsonl").write_text(
            "".join(json.dumps(items[j], ensure_ascii=False) + "\n" for j in idx[b:b + BATCH]), encoding="utf-8")
    (HERE.parent / "kingmat-key.jsonl").write_text("".join(json.dumps(o) + "\n" for o in key), encoding="utf-8")
    print(len(items), "rows from", len({k["id"] for k in key}), "cards")


if __name__ == "__main__":
    main()
