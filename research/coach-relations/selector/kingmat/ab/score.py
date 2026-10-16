"""Blind A/B of the material + mate-threat sentence, per judge (out-<judge>/), unblinded with
../../kingmat-ab-key.jsonl.

  py -B selector/kingmat/ab/score.py   -> ab/RESULTS.md
"""
import json
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent


def jsonl(p):
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]


def main():
    key = {k["n"]: k for k in jsonl(HERE.parents[1] / "kingmat-ab-key.jsonl")}
    gone = set(json.loads((HERE / "DROPPED.json").read_text(encoding="utf-8"))["n"])
    items = {o["n"]: o for p in sorted(HERE.glob("batch-*.jsonl")) for o in jsonl(p) if o["n"] not in gone}
    out = ["# Material + mate threat in one sentence: blind A/B", "", f"{len(items)} changed cards ({len(gone)} more in the batches are out: DROPPED.json).", ""]
    for d in sorted(HERE.glob("out-*")):
        labs = {o["n"]: o for p in sorted(d.glob("batch-*.jsonl")) for o in jsonl(p) if o["n"] not in gone}
        tally, ok, regress, worse = Counter(), Counter(), [], []
        for n, o in labs.items():
            new = key[n]["new"]
            old = "B" if new == "A" else "A"
            v = {new: "new", old: "old"}.get(o["verdict"], o["verdict"])
            tally[v] += 1
            ok["old"] += bool(o["ok"][old])
            ok["new"] += bool(o["ok"][new])
            if o["ok"][old] and not o["ok"][new]:
                regress.append(n)
            elif v == "old":
                worse.append(n)
        m = len(labs)
        out += [f"## {d.name[4:]}", "",
                f"- judged {m} of {len(items)}: new better {tally['new']}, old better {tally['old']}, "
                f"tie {tally['tie']}, both bad {tally['both_bad']}",
                f"- acceptable to show: old {ok['old']}/{m}, new {ok['new']}/{m}; old acceptable but new not: {len(regress)}", ""]
        for title, ns in (("Old acceptable, new not", regress), ("Old better (both acceptable)", worse)):
            if ns:
                out += [f"{title}:", ""]
                for n in ns:
                    o, new = items[n], key[n]["new"]
                    out.append(f"- n={n} {o['id']}: new: {o[new]} — {labs[n]['note']}")
                out.append("")
    (HERE / "RESULTS.md").write_text("\n".join(out) + "\n", encoding="utf-8")
    print("\n".join(l for l in out if not l.startswith("- n=")))


if __name__ == "__main__":
    main()
