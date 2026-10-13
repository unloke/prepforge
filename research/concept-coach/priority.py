"""Which concepts the Coach misses that Maia identifies reliably: the next detectors to build.

  py research/concept-coach/priority.py   (after coverage.mjs and the move-aware probe)

Per fine concept: how the Coach can say it today (COACH below, from web-src/coach), its
engine-free recall on the labelled comments (coverage.json), and the move-aware router's
test AUC, average precision and precision lift over the base rate (probe RESULTS.json),
next to the after-only router. Reliable = kept on validation and test AUC 0.75+. Writes
PRIORITY.md.
"""
import json
import pathlib

HERE = pathlib.Path(__file__).parent
PROBE = HERE.parents[1] / "artifacts/benchmarks/concept-labels-20261012/probe-move"
# How production Coach can name a concept: a phrase concepts.mjs maps (plus the hanging-piece
# reply line in commentary.js), or only the move grade. Everything else it cannot say.
COACH = {
    "detector": {"mate_threat", "castling", "promotion", "fork", "skewer", "pin", "development",
                 "center_control", "passed_pawn", "open_file", "winning_material", "trades", "defense",
                 "passive_piece", "prophylaxis", "threat", "hanging_piece"},
    "grade": {"blunder"},
}
RELIABLE_AUC = 0.75

r = json.loads((PROBE / "RESULTS.json").read_text(encoding="utf-8"))
cov = json.loads((HERE / "coverage.json").read_text(encoding="utf-8"))
move, after = r["routers"]["move-mlp"]["per_tag"], r["routers"]["maia-mlp"]["per_tag"]
ci = r["bootstrap"]["per_tag"]
rows = []
for t in r["tags"]:
    if t.startswith("["):
        continue
    how = next((k for k, v in COACH.items() if t in v), "none")
    m = move[t]
    rows.append({"concept": t, "coach": how, "recall": cov.get(t, {}).get("recall") or 0,
                 "auc": m["auc"], "ci": ci[t]["move-mlp"], "ap": m["ap"], "lift": m["ap"] / m["base_rate"],
                 "after_auc": after[t]["auc"], "gain": ci[t]["move-mlp - maia-mlp"],
                 "kept": t in r["kept"], "train": r["train_counts"][t]})
reliable = lambda x: x["kept"] and x["auc"] >= RELIABLE_AUC
rows.sort(key=lambda x: (x["coach"] != "none", not reliable(x), -x["auc"]))

lines = ["# Concepts the Coach misses that Maia sees", "",
         f"Move-aware router (move-mlp), test split. Reliable = kept on validation and test AUC {RELIABLE_AUC}+.",
         "Coach: how production can say it (detector / grade only / none); recall = engine-free detectors",
         "naming it on comments that mention it. Lift = average precision / base rate. Gain = move minus",
         "after-only AUC, 95% bootstrap interval.", "",
         "| concept | coach | recall | AUC (95% CI) | after-only | gain | AP | lift | train | reliable |",
         "|---|---|---|---|---|---|---|---|---|---|"]
for x in rows:
    lines.append(f"| {x['concept']} | {x['coach']} | {x['recall']:.2f} | {x['auc']:.3f} ({x['ci'][0]:.2f}–{x['ci'][1]:.2f}) | "
                 f"{x['after_auc']:.3f} | {x['gain'][0]:+.3f}…{x['gain'][1]:+.3f} | {x['ap']:.3f} | {x['lift']:.1f} | "
                 f"{x['train']} | {'yes' if reliable(x) else ''} |")
(HERE / "PRIORITY.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
print("\n".join(lines))
