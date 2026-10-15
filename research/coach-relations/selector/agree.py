"""How stable sol's candidate labels are: cand/ and cand2/ judge the same 360 cards with the
candidates in different orders (and the cards in different orders within a batch).

  py -B selector/agree.py
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def labels(d):
    key = {k["n"]: k for k in map(json.loads, (HERE / d / "key.jsonl").read_text(encoding="utf-8").splitlines())}
    out = {}
    for p in sorted((HERE / d / "out").glob("batch-*.jsonl")):
        for lab in map(json.loads, p.read_text(encoding="utf-8").splitlines()):
            k = key[lab["n"]]
            byk = {c["k"]: c for c in lab["candidates"]}
            good = [bool(byk[k["rank_of_k"][j]]["correct"] and byk[k["rank_of_k"][j]]["main"]) for j in range(len(k["facts"]))]
            best = None if lab["best"] is None else k["rank_of_k"].index(lab["best"])  # as a rank position
            out[lab["n"]] = {"good": good, "best": best, "multi": len(k["facts"]) > 1}
    return out


def kappa(a, b):
    n = len(a)
    po = sum(x == y for x, y in zip(a, b)) / n
    pa, pb = sum(a) / n, sum(b) / n
    pe = pa * pb + (1 - pa) * (1 - pb)
    return (po - pe) / (1 - pe) if pe < 1 else 1.0


def main():
    a, b = labels("cand"), labels("cand2")
    ns = sorted(set(a) & set(b))
    cand_a = [g for n in ns for g in a[n]["good"]]
    cand_b = [g for n in ns for g in b[n]["good"]]
    speak_a = [a[n]["best"] is not None for n in ns]
    speak_b = [b[n]["best"] is not None for n in ns]
    multi = [n for n in ns if a[n]["multi"] and a[n]["best"] is not None and b[n]["best"] is not None]
    unstable = [n for n in ns if a[n]["best"] != b[n]["best"]]
    lines = ["# sol self-consistency (two passes, candidate order reshuffled)", "",
             f"- cards: {len(ns)}; candidates: {len(cand_a)}",
             f"- candidate good (correct and main): agreement {sum(x == y for x, y in zip(cand_a, cand_b)) / len(cand_a):.0%}, "
             f"kappa {kappa(cand_a, cand_b):.2f}",
             f"- speak or stay bare (best is null or not): agreement {sum(x == y for x, y in zip(speak_a, speak_b)) / len(ns):.0%}, "
             f"kappa {kappa(speak_a, speak_b):.2f}",
             f"- multi-candidate cards where both passes pick one: {len(multi)}; same pick "
             f"{sum(a[n]['best'] == b[n]['best'] for n in multi) / max(1, len(multi)):.0%}",
             f"- unstable cards (best differs): {len(unstable)}"]
    (HERE / "AGREE.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (HERE / "unstable.json").write_text(json.dumps(unstable) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
