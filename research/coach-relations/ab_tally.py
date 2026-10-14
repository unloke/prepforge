"""Unblinds the Codex verdicts of make_ab.py's A/B and counts them.

  py research/coach-relations/ab_tally.py ab2

Wins, ties and both-bad by program, an exact two-sided sign test on the decisive pairs, issue tags
per program (count and share of pairs), the split by grade and by what explain.py led with (its
first fact's kind, or none), and the low-confidence pairs with both texts.
"""
import json
import math
import pathlib
import sys
from collections import Counter


def sign_test(k, n):
    tail = sum(math.comb(n, i) for i in range(0, min(k, n - k) + 1)) / 2 ** n
    return min(1.0, 2 * tail)


def kind(facts):
    if facts is None:
        return "?"
    if not facts:
        return "no fact"
    return {"mate": "mate", "mate_threat": "mate", "forced_mate": "mate", "material": "material"}.get(facts[0], "other fact")


def main():
    HERE = pathlib.Path(__file__).parent / sys.argv[1] / "run-output"
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
    out, issues, grade, kinds = Counter(), {"relations": Counter(), "production": Counter()}, {}, {}
    for pid, v in sorted(verdicts.items()):
        k = key[pid]
        w = k[v["verdict"]] if v["verdict"] in ("A", "B") else v["verdict"]
        out[w] += 1
        grade.setdefault(cards[pid]["grade"], Counter())[w] += 1
        kinds.setdefault(kind(k.get("facts")), Counter())[w] += 1
        for side in ("A", "B"):
            issues[k[side]].update(v["issues"].get(side, []))
    n = out["relations"] + out["production"]
    print(f"relations {out['relations']}, production {out['production']}, tie {out['tie']}, both_bad {out['both_bad']}; "
          f"sign test on {n} decisive: p = {sign_test(out['relations'], n):.3f}")
    for g in ("inaccuracy", "mistake", "blunder"):
        print(f"  {g}: {dict(grade.get(g, {}))}")
    for g, c in sorted(kinds.items()):
        print(f"  {g}: {dict(c)}")
    for p, c in issues.items():
        print(f"  {p} issues: " + ", ".join(f"{t} {n} ({n / len(verdicts):.0%})" for t, n in c.most_common()))
    print("\nlow confidence:")
    for pid, v in sorted(verdicts.items()):
        if v["confidence"] == "low":
            k, c = key[pid], cards[pid]
            print(f"{pid} {k['id']} {c['grade']} -> {k[v['verdict']] if v['verdict'] in ('A', 'B') else v['verdict']}\n"
                  f"  played {c['played']} | best {c['best']}\n  {k['A']}: {c['A']}\n  {k['B']}: {c['B']}\n"
                  f"  reason: {v['main_reason']}\n  why: {v['why']}\n")


if __name__ == "__main__":
    main()
