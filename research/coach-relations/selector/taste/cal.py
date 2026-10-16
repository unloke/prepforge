"""The user's spot-check picks against a judge's picks, by the text shown (identical candidate
texts are the same choice; None = stay bare / every candidate is bad).

  py -B selector/taste/cal.py <labels folder> [...]   e.g. cand/out judge/out taste/cal/out
"""
import json
import sys
from pathlib import Path

SEL = Path(__file__).resolve().parents[1]


def user_picks():
    key = {json.loads(l)["pair_id"]: json.loads(l)["n"] for l in (SEL / "spot/key.jsonl").read_text(encoding="utf-8").splitlines()}
    doc = json.loads((SEL / "spot/human-review/HUMAN-REVIEW.json").read_text(encoding="utf-8"))
    return {key[r["pair_id"]]: None if r["verdict"] == "none" else int(r["verdict"]) for r in doc["reviews"] if r["verdict"] is not None}


def cards():
    out = {}
    for p in sorted((SEL / "cand").glob("batch-*.jsonl")):
        for o in map(json.loads, p.read_text(encoding="utf-8").splitlines()):
            out[o["n"]] = [c["text"] for c in o["candidates"]]
    return out


def picks(folder):
    out = {}
    for p in sorted((SEL / folder).glob("batch-*.jsonl")):
        for o in map(json.loads, p.read_text(encoding="utf-8").splitlines()):
            out[o["n"]] = o["best"]
    return out


def main():
    user, text = user_picks(), cards()
    shown = lambda n, b: None if b is None else text[n][b]
    for folder in sys.argv[1:]:
        j = picks(folder)
        ns = [n for n in user if n in j]
        same = [n for n in ns if shown(n, user[n]) == shown(n, j[n])]
        bare = sum((user[n] is None) == (j[n] is None) for n in ns)
        print(f"{folder}: same choice {len(same)}/{len(ns)}, speak/bare agree {bare}/{len(ns)}; "
              f"differ on n={[n for n in ns if n not in same]}")


if __name__ == "__main__":
    main()
