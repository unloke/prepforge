"""Where the concept router would make the Coach say a different proven point.

  py research/concept-coach/pick.py   (after candidates.mjs)

Among each position's proven candidates (candidates.jsonl), the router picks the one whose
concept it rates highest relative to that concept's base rate, from the router chosen on
validation (probe RESULTS.json). Mate, forced and "nothing helps" prose is never touched,
and only fine concepts the probe kept are eligible. Writes swaps.jsonl: the current prose
and the same prose with the router's point in place of the current one.
"""
import json
import pathlib
import re

HERE = pathlib.Path(__file__).parent
PROBE = HERE.parents[1] / "artifacts/benchmarks/concept-labels-20261012/probe-deepseek"
results = json.loads((PROBE / "RESULTS.json").read_text(encoding="utf-8"))
router, base, kept = results["coach_router"], results["positive_rate"], set(results["kept"])
scores = {r["id"]: r for r in map(json.loads, (PROBE / "coach-concepts.jsonl").read_text(encoding="utf-8").splitlines())}
FIXED = re.compile(r"mate|only legal|Nothing helps|Checkmate")

counts, swaps = {}, []
for r in map(json.loads, (HERE / "candidates.jsonl").read_text(encoding="utf-8").splitlines()):
    cands = [c for c in r["candidates"] if c["concept"] in kept]
    if len({c["concept"] for c in cands}) < 2:
        kind = "fewer than 2"
    elif FIXED.search(r["prose"]):
        kind = "mate/forced"
    else:
        current = [c for c in cands if c["phrase"] in r["prose"]]
        s = scores[r["id"]]
        pick = max(cands, key=lambda c: s[f"{router}:{c['side']}"][c["concept"]] / base[c["concept"]])
        if not current:
            kind = "prose uses none"
        elif pick in current:
            kind = "same"
        else:
            kind = "different"
            swaps.append({"id": r["id"], "code": r["code"], "before": r["prose"],
                          "after": r["prose"].replace(current[0]["phrase"], pick["phrase"], 1),
                          "from": current[0]["concept"], "to": pick["concept"]})
    counts[kind] = counts.get(kind, 0) + 1
print(counts)
(HERE / "swaps.jsonl").write_text("".join(json.dumps(s) + "\n" for s in swaps), encoding="utf-8")
for s in swaps:
    print(f"{s['before']}\n   -> {s['after']}")
