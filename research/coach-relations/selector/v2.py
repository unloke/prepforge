"""Weak-type list v2, frozen from the 360 development cards before any confirmation data.

Rule: a type is weak when the Wilson 95% upper bound of its good rate (correct and main, averaged
over the two sol passes) is below 2/3, the break-even rate when a wrong reason costs twice what a
right one gains. Types with fewer than 10 candidates keep their v1 status.

  py -B selector/v2.py
"""
import math
from collections import defaultdict

import fit

BAR, MIN_N = 2 / 3, 10


def wilson_hi(k, n, z=1.96):
    p = k / n
    return (p + z * z / (2 * n) + z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n)


def derive():
    a = {c["n"]: c for c in fit.load_pass("cand")}
    b = {c["n"]: c for c in fit.load_pass("cand2")}
    st = defaultdict(lambda: [0, 0.0])
    for n, c in a.items():
        for j, f in enumerate(c["facts"]):
            s = st[fit.kind(f, fit.mover(c))]
            s[0] += 1
            s[1] += (c["good"][j] + b[n]["good"][j]) / 2
    weak = {t for t in fit.WEAK if st[t][0] < MIN_N}
    weak |= {t for t, (n, g) in st.items() if n >= MIN_N and wilson_hi(g, n) < BAR}
    return weak, st


WEAK2 = {"trades", "pawn_weakness", "passed_pawn", "castling", "restricted", "outpost", "draw_risk", "material_unfinished"}


def r1v2(c):
    return next((j for j, f in enumerate(c["facts"]) if fit.kind(f, fit.mover(c)) not in WEAK2), None)


def utility(m):
    return m["coverage"] * m["hit"] - 2 * m["coverage"] * (1 - m["hit"])


def main():
    weak, st = derive()
    assert weak == WEAK2, sorted(weak ^ WEAK2)
    cards = fit.load()
    w = fit.weights(cards)
    out = ["# Weak-type list v2 (frozen 2026-10-15)", "",
           f"v1: {', '.join(sorted(fit.WEAK))}", f"v2: {', '.join(sorted(WEAK2))}",
           "Changes: piece_harassed out, castling in.", "",
           "Development cards only (the list was chosen on them, so these numbers are optimistic):", ""] + fit.HEAD[:1]
    out[-1] += " Utility |"
    out.append(fit.HEAD[1] + " ---: |")
    for name, pol in (("R0", lambda c: 0), ("R1b (v1)", fit.r1b), ("R1b (v2)", r1v2)):
        m = fit.evaluate(cards, [pol(c) for c in cards], w)
        out.append(fit.line(name, m) + f" {utility(m):+.2f} |")
    (fit.HERE / "V2.md").write_text("\n".join(out) + "\n", encoding="utf-8")
    print("\n".join(out))


if __name__ == "__main__":
    main()
