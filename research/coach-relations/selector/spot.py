"""The user's spot-check of 60 development cards (hark.py draws them) against sol and Hark: the
precondition in PREREG.md. Written before the review; runs only on a complete ledger.

  py -B selector/spot.py   -> SPOT.md

Precondition (40 random cards): user vs sol speak/stay-bare kappa >= 0.6 and multi-candidate best
agreement >= 70% (cards where both pick a reason). The 20 disagreement cards say whom the user sides
with. Card verdicts are the shown candidate's k (the order sol pass 1 and Hark saw) or "none".
"""
import json

import fit
from agree import kappa


def main():
    key = [json.loads(l) for l in (fit.HERE / "spot/key.jsonl").read_text(encoding="utf-8").splitlines()]
    doc = json.loads((fit.HERE / "spot/human-review/HUMAN-REVIEW.json").read_text(encoding="utf-8"))
    user = {r["pair_id"]: None if r["verdict"] == "none" else int(r["verdict"]) for r in doc["reviews"] if r["verdict"] is not None}
    assert len(user) == len(key) == 60, f"review incomplete: {len(user)} / {len(key)}"
    sol = {c["n"]: c["best"] for c in fit.load_pass("cand")}
    hark = {c["n"]: c["best"] for c in fit.load_pass("cand", "judge/out")}
    multi = {c["n"]: len(c["facts"]) > 1 for c in fit.load_pass("cand")}

    rand = [k for k in key if k["set"] == "random"]
    out = ["# User spot-check (60 development cards)", ""]
    for name, judge in (("sol", sol), ("Hark", hark)):
        u = [user[k["pair_id"]] is not None for k in rand]
        j = [judge[k["n"]] is not None for k in rand]
        both = [k for k in rand if multi[k["n"]] and user[k["pair_id"]] is not None and judge[k["n"]] is not None]
        same = sum(user[k["pair_id"]] == judge[k["n"]] for k in both)
        out.append(f"- 40 random, user vs {name}: speak/stay-bare agreement {sum(a == b for a, b in zip(u, j)) / len(u):.0%}, "
                   f"kappa {kappa(u, j):.2f}; multi-candidate best agreement {same}/{len(both)}"
                   f" ({same / max(1, len(both)):.0%}); user speaks on {sum(u)}, {name} on {sum(j)}")
    u = [user[k["pair_id"]] is not None for k in rand]
    j = [sol[k["n"]] is not None for k in rand]
    both = [k for k in rand if multi[k["n"]] and user[k["pair_id"]] is not None and sol[k["n"]] is not None]
    ok = kappa(u, j) >= 0.6 and sum(user[k["pair_id"]] == sol[k["n"]] for k in both) / max(1, len(both)) >= 0.7
    out += ["", f"Precondition (vs sol: kappa >= 0.6, best agreement >= 70%): {'met' if ok else 'not met'}", ""]

    dis = [k for k in key if k["set"] == "disagree"]
    tally = {"sol": 0, "Hark": 0, "neither": 0}
    for k in dis:
        v = user[k["pair_id"]]
        tally["sol" if v == sol[k["n"]] else "Hark" if v == hark[k["n"]] else "neither"] += 1
    out.append(f"- 20 disagreement cards, user sides with: sol {tally['sol']}, Hark {tally['Hark']}, neither {tally['neither']}")
    (fit.HERE / "SPOT.md").write_text("\n".join(out) + "\n", encoding="utf-8")
    print("\n".join(out))


if __name__ == "__main__":
    main()
