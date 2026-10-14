"""Research only. Does the enumerator list the reviewer's main reason?

  py research/coach-relations/review/score.py [--show]

Reads LABELS.adjusted.json (main reason kind and line, re-read from the reviewer's notes) and
re-runs the current enumerator on those positions. A position counts as covered when a
candidate of a matching type sits on the reviewer's line ("both" accepts either).
These 36 positions tuned the tactical detectors, so their recall is optimistic.
"""
import json
import pathlib
import sys
from collections import Counter

HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
from enumerate import candidates  # noqa: E402

MATCH = {
    "material": {"material", "fork"},
    "mate": {"mate", "forced_mate", "mate_threat"},
    "king_safety": {"king_exposed", "shield"},
    "trade": {"trades"},
    "activity": {"enter", "open_file", "outpost", "piece_harassed"},
    "development": set(),
    "space": set(),
    "pawns": {"shield", "pawn_weakness"},
    "draw": {"draw_risk"},
}


def main():
    show = "--show" in sys.argv
    labels = json.loads((HERE / "LABELS.adjusted.json").read_text(encoding="utf-8"))["reviews"]
    sets = {p["pos_id"]: p for p in json.loads((HERE / "set.json").read_text(encoding="utf-8"))}
    rows = {json.loads(l)["id"]: json.loads(l) for l in (HERE.parent / "positions.jsonl").read_text(encoding="utf-8").splitlines()}
    hit, total, sizes = Counter(), Counter(), []
    for r in labels:
        cands = candidates(rows[sets[r["pos_id"]]["card"]])
        sizes.append(len(cands))
        lines = {"played", "best"} if r["where"] == "both" else {r["where"]}
        ok = any(c["type"] in MATCH[r["kind"]] and c["line"] in lines for c in cands)
        total[r["kind"]] += 1
        hit[r["kind"]] += ok
        if show:
            print(f"{r['pos_id']} {'HIT ' if ok else 'MISS'} {r['kind']}/{r['where']} {r['motif']}")
            for c in cands:
                if c["type"] in MATCH[r["kind"]]:
                    print("     ", {k: v for k, v in c.items() if k != "at"})
    print({k: f"{hit[k]}/{n}" for k, n in total.most_common()}, f"all {sum(hit.values())}/{sum(total.values())}",
          f"candidates median {sorted(sizes)[len(sizes) // 2]}")


if __name__ == "__main__":
    main()
