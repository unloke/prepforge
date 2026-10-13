"""Concept router output on the 40 positions of the v7 spot check, next to the user's notes there.

python research/concept-labels/review.py <coach-concepts.jsonl> <out.md>

For each position: the router's top concepts after the played move and after the best move (scores
are the probability a commentator would mention the concept), the v7 verdict and the user's note.
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
V7 = ROOT / "research/sft/experiment/coach-v7-20261012/spot-check"
concepts_path, out_path = sys.argv[1:3]

by_fen = {}
for line in (ROOT / "research/coach-prod-v2/after.jsonl").open(encoding="utf-8"):
    r = json.loads(line)
    by_fen[r["fen"]] = r
scores = {}
for line in open(concepts_path, encoding="utf-8"):
    r = json.loads(line)
    scores[r["id"]] = r
reviews = {r["pair_id"]: r for r in json.loads((V7 / "human-review/HUMAN-REVIEW.json").read_text(encoding="utf-8"))["reviews"]}


def top(d, n=4):
    return ", ".join(f"{k} {v:.2f}" for k, v in sorted(d.items(), key=lambda kv: -kv[1])[:n])


lines = ["# Concept router on the v7 spot-check positions", ""]
for line in (V7 / "run-output/BLINDED.jsonl").open(encoding="utf-8"):
    p = json.loads(line)
    row = by_fen.get(p["facts"]["fen_before"])
    if not row or row["id"] not in scores:
        continue
    s = scores[row["id"]]
    key = s["router"]
    rv = reviews.get(p["pair_id"], {})
    lines += [f"## {p['pair_id']} {row['id']} — {row['san']} ({row['code']}), best {row['bestSan']}",
              f"- verdict: {rv.get('verdict', '-')}; note: {rv.get('note') or '-'}",
              f"- after played: {top(s[f'{key}:played'])}",
              f"- after best: {top(s[f'{key}:best'])}", ""]
pathlib.Path(out_path).write_text("\n".join(lines), encoding="utf-8")
print(json.dumps({"positions": sum(l.startswith("## ") for l in lines), "out": out_path}))
