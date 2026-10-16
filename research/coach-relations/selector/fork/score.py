"""Sol's check of the fork rule (make.py): were the dropped fork sentences wrong, and is the new card
text acceptable and better than the old one? Unblinds with ../fork-key.jsonl.

  py -B selector/fork/score.py   -> fork/RESULTS.md
"""
import json
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main():
    key = {k["n"]: k for k in map(json.loads, (HERE.parent / "fork-key.jsonl").read_text(encoding="utf-8").splitlines())}
    items = {o["n"]: o for p in sorted(HERE.glob("batch-*.jsonl")) for o in map(json.loads, p.read_text(encoding="utf-8").splitlines())}
    labs = {o["n"]: o for p in sorted((HERE / "out").glob("batch-*.jsonl"))
            for o in map(json.loads, p.read_text(encoding="utf-8").splitlines()) if p.read_text(encoding="utf-8").strip()}
    missing = sorted(set(items) - set(labs))
    removed = [(n, r["k"], r["real"]) for n, o in labs.items() for r in o["removed"]]
    real = [(n, k) for n, k, x in removed if x]
    tally, ok, regress = Counter(), Counter(), []
    for n, o in labs.items():
        new = key[n]["new"]
        if new is None or o.get("verdict") is None:
            continue
        old = "B" if new == "A" else "A"
        v = o["verdict"]
        tally[{new: "new", old: "old"}.get(v, v)] += 1
        ok["old"] += bool(o["ok"][old])
        ok["new"] += bool(o["ok"][new])
        if o["ok"][old] and not o["ok"][new]:
            regress.append(n)
    changed = sum(tally.values())
    out = ["# False-fork rule: sol's check", "",
           f"- cards judged: {len(labs)} of {len(items)}" + (f" (missing {len(missing)})" if missing else ""),
           f"- dropped fork sentences: {len(removed)}; sol says the fork was real: {len(real)} "
           f"({len(real) / max(1, len(removed)):.0%})",
           f"- changed card texts: {changed}; new better {tally['new']}, old better {tally['old']}, "
           f"tie {tally['tie']}, both bad {tally['both_bad']}",
           f"- acceptable to show: old {ok['old']}/{changed}, new {ok['new']}/{changed}; "
           f"old acceptable but new not: {len(regress)}", "",
           "Dropped forks sol calls real:", ""]
    for n, k in real:
        o = items[n]
        out.append(f"- n={n} {o['id']}: {o['removed'][k]['text']} — {labs[n]['note']}")
    out += ["", "Old acceptable, new not:", ""]
    for n in regress:
        o, new = items[n], key[n]["new"]
        out.append(f"- n={n} {o['id']}: old: {o['B' if new == 'A' else 'A']} | new: {o[new]} — {labs[n]['note']}")
    (HERE / "RESULTS.md").write_text("\n".join(out) + "\n", encoding="utf-8")
    print("\n".join(out[:8]))


if __name__ == "__main__":
    main()
