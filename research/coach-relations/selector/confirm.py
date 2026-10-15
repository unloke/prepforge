"""Confirmation test of weak-type list v2 (PREREG.md). Run once, after the labels are final.

Labels: confirm/out (sol) and confirm/out2 (second judge); where they disagree on a candidate, the
user's verdict in confirm/adjudicated.jsonl ({"n": .., "good": [per rank position]}) decides.
The set is drawn in the pool's mix, so cards are unweighted.

  py -B selector/confirm.py
"""
import json

import numpy as np

import fit
import v2

D = fit.HERE / "confirm"


def judged(out):
    key = {k["n"]: k for k in map(json.loads, (D / "key.jsonl").read_text(encoding="utf-8").splitlines())}
    res = {}
    for p in sorted((D / out).glob("batch-*.jsonl")):
        for lab in map(json.loads, p.read_text(encoding="utf-8").splitlines()):
            byk = {c["k"]: c for c in lab["candidates"]}
            k = key[lab["n"]]
            res[lab["n"]] = [bool(byk[k["rank_of_k"][j]]["correct"] and byk[k["rank_of_k"][j]]["main"]) for j in range(len(k["facts"]))]
    return key, res


def cards():
    key, a = judged("out")
    _, b = judged("out2")
    adj = {}
    if (D / "adjudicated.jsonl").exists():
        adj = {o["n"]: o["good"] for o in map(json.loads, (D / "adjudicated.jsonl").read_text(encoding="utf-8").splitlines())}
    open_ = [n for n in key if a[n] != b[n] and n not in adj]
    assert not open_, f"{len(open_)} cards still need the user's verdict: {open_[:20]}"
    white = {o["n"]: o["side_to_move"] == "white" for p in D.glob("batch-*.jsonl")
             for o in map(json.loads, p.read_text(encoding="utf-8").splitlines())}
    return [dict(k, mover_white=white[n], good=a[n] if a[n] == b[n] else adj[n]) for n, k in sorted(key.items())]


def boot(cs, a, b, n=10000, seed=1):
    """Paired bootstrap 95% CI of hit(a) - hit(b)."""
    rng = np.random.default_rng(seed)
    G = np.array([[x is not None and c["good"][x] for x in (a[i], b[i])] for i, c in enumerate(cs)], float)
    S = np.array([[a[i] is not None, b[i] is not None] for i in range(len(cs))], float)
    dh = []
    for _ in range(n):
        k = rng.integers(0, len(cs), len(cs))
        hit = G[k].sum(0) / np.maximum(S[k].sum(0), 1)
        dh.append(hit[0] - hit[1])
    return np.percentile(dh, 2.5), np.percentile(dh, 97.5)


def main():
    cs = cards()
    pol = {"R0": [0] * len(cs), "R1": [fit.r1b(c) for c in cs], "v2": [v2.r1v2(c) for c in cs]}
    m = {k: fit.evaluate(cs, ch) for k, ch in pol.items()}
    lines = ["# Confirmation test (PREREG.md H1)", "", f"cards: {len(cs)}", ""] + fit.HEAD
    lines += [fit.line(k, x) for k, x in m.items()]
    lo0, _ = boot(cs, pol["v2"], pol["R0"])
    lo1, _ = boot(cs, pol["v2"], pol["R1"])
    checks = [("v2 - R0 hit >= +10pp", m["v2"]["hit"] - m["R0"]["hit"] >= 0.10),
              (f"v2 - R0 hit CI lower bound > 0 ({lo0:+.1%})", lo0 > 0),
              (f"v2 - R1 hit CI lower bound > -3pp ({lo1:+.1%})", lo1 > -0.03),
              ("v2 coverage >= R1 - 2pp", m["v2"]["coverage"] >= m["R1"]["coverage"] - 0.02),
              ("v2 should-abstain rate <= 12%", m["v2"]["should"] <= 0.12)]
    lines += ["", *[f"- [{'x' if ok else ' '}] {name}" for name, ok in checks], "",
              "H1 holds: ship v2." if all(ok for _, ok in checks) else "H1 fails: keep v1."]
    (fit.HERE / "CONFIRM.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
