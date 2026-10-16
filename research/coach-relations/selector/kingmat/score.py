"""Sol's view of the material + king-safety cards (make.py): how the two parts relate, by the
structural class of the pair, and which cards need both. Unblinds with ../kingmat-key.jsonl.

  py -B selector/kingmat/score.py   -> kingmat/RESULTS.md
"""
import json
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent


def jsonl(p):
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]


def main():
    key = {k["n"]: k for k in jsonl(HERE.parent / "kingmat-key.jsonl")}
    items = {o["n"]: o for p in sorted(HERE.glob("batch-*.jsonl")) for o in jsonl(p)}
    labs = {o["n"]: o for p in sorted((HERE / "out").glob("batch-*.jsonl")) for o in jsonl(p)}
    groups = defaultdict(list)
    for n, o in labs.items():
        k = key[n]
        groups[(k["line"], k["facts"][1]["type"], k["relation"])].append(n)
    out = ["# Material and king safety: sol's view", "",
           f"- cards judged: {len(labs)} of {len(items)}", "",
           "| line | king part | timing | cards | needs both | relation | material ok | king ok | shown ok |",
           "| --- | --- | --- | ---: | ---: | --- | ---: | ---: | ---: |"]
    for g in sorted(groups, key=lambda g: -len(groups[g])):
        ns = groups[g]
        rel = Counter(labs[n]["relation"] for n in ns)
        ok = Counter()
        for n in ns:
            kinds, cs = key[n]["kinds"], {c["k"]: c for c in labs[n]["candidates"]}
            texts = {c["k"]: c["text"] for c in items[n]["candidates"]}
            ok["material"] += any(cs[j]["ok"] for j, t in enumerate(kinds) if t == "material")
            ok["king"] += any(cs[j]["ok"] for j, t in enumerate(kinds) if t != "material")
            shown = [j for j in texts if texts[j] == key[n]["shown"]]
            ok["shown"] += bool(shown) and cs[shown[0]]["ok"]
            ok["shown_known"] += bool(shown)
        out.append(f"| {g[0]} | {g[1]} | {g[2]} | {len(ns)} | {sum(labs[n]['needs_both'] for n in ns)} | "
                   + ", ".join(f"{r} {c}" for r, c in rel.most_common())
                   + f" | {ok['material']} | {ok['king']} | {ok['shown']}/{ok['shown_known']} |")
    tot = Counter(o["relation"] for o in labs.values())
    out += ["", f"All: needs both {sum(o['needs_both'] for o in labs.values())} of {len(labs)}; "
            + ", ".join(f"{r} {c}" for r, c in tot.most_common()), "", "## Cards that need both", ""]
    for g in sorted(groups, key=lambda g: -len(groups[g])):
        ns = [n for n in groups[g] if labs[n]["needs_both"]]
        if not ns:
            continue
        out += [f"### {' / '.join(g)}", ""]
        for n in ns:
            out.append(f"- n={n} {key[n]['id']} ({labs[n]['relation']}): {labs[n]['ideal']}")
        out.append("")
    (HERE / "RESULTS.md").write_text("\n".join(out) + "\n", encoding="utf-8")
    print("\n".join(out[:40]))


if __name__ == "__main__":
    main()
