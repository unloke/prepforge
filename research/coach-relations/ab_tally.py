"""Unblinds the Codex verdicts of make_ab.py's A/B and counts them.

  py research/coach-relations/ab_tally.py

Wins, ties and both-bad by program, an exact two-sided sign test on the decisive pairs, issue tags
per program, the split by grade, and the low-confidence pairs with both texts.
"""
import json
import math
import pathlib
from collections import Counter

HERE = pathlib.Path(__file__).parent / "ab/run-output"


def sign_test(k, n):
    tail = sum(math.comb(n, i) for i in range(0, min(k, n - k) + 1)) / 2 ** n
    return min(1.0, 2 * tail)


def main():
    key = json.loads((HERE / "BLIND-KEY.json").read_text(encoding="utf-8"))["pairs"]
    cards = {}
    for f in sorted((HERE / "judge").glob("batch*.jsonl")):
        for l in f.read_text(encoding="utf-8").splitlines():
            r = json.loads(l)
            cards[r["pair_id"]] = r
    verdicts = {}
    for f in sorted((HERE / "judge/out").glob("batch*.jsonl")):
        for l in f.read_text(encoding="utf-8").splitlines():
            if l.strip():
                r = json.loads(l)
                verdicts[r["pair_id"]] = r
    print(f"{len(verdicts)}/{len(key)} judged")
    out, issues, grade = Counter(), {"relations": Counter(), "production": Counter()}, {}
    for pid, v in sorted(verdicts.items()):
        k = key[pid]
        w = k[v["verdict"]] if v["verdict"] in ("A", "B") else v["verdict"]
        out[w] += 1
        grade.setdefault(cards[pid]["grade"], Counter())[w] += 1
        for side in ("A", "B"):
            issues[k[side]].update(v["issues"].get(side, []))
    n = out["relations"] + out["production"]
    print(f"relations {out['relations']}, production {out['production']}, tie {out['tie']}, both_bad {out['both_bad']}; "
          f"sign test on {n} decisive: p = {sign_test(out['relations'], n):.3f}")
    for g in ("inaccuracy", "mistake", "blunder"):
        print(f"  {g}: {dict(grade.get(g, {}))}")
    for p, c in issues.items():
        print(f"  {p} issues: {dict(c)}")
    print("\nlow confidence:")
    for pid, v in sorted(verdicts.items()):
        if v["confidence"] == "low":
            k, c = key[pid], cards[pid]
            print(f"{pid} {k['id']} {c['grade']} -> {k[v['verdict']] if v['verdict'] in ('A', 'B') else v['verdict']}\n"
                  f"  played {c['played']} | best {c['best']}\n  {k['A']}: {c['A']}\n  {k['B']}: {c['B']}\n"
                  f"  reason: {v['main_reason']}\n  why: {v['why']}\n")


if __name__ == "__main__":
    main()
