"""Re-tag the reviewer's main reason from their own notes (LABELS.json stays untouched).

The first 36 reviews were tagged with a taxonomy that lacked mate, king safety, trades,
development and space, and the "which line" choice was missed at first. The notes and the
candidate ratings were right, so the kind and line are re-read from the note here.

    py research/coach-relations/review/adjust.py   ->  LABELS.adjusted.json, ADJUSTED.md
"""
import json
from collections import Counter
from pathlib import Path

HERE = Path(__file__).parent

KINDS = {
    "mate": "將殺／防殺", "material": "子力得失", "king_safety": "王的安全", "pawns": "兵形",
    "activity": "子力活動", "development": "出子", "space": "空間", "trade": "換子決策",
    "draw": "和棋資源", "unclear": "看不出來",
}
IN_SCOPE = {"activity", "development", "space"}  # the relation enumerator's first scope

# pos_id: (kind, where, motif, secondary kinds). Read from each note.
ADJUST = {
    "rr-001": ("material", "both", "undefended d5", ["pawns"]),
    "rr-002": ("material", "best", "pin, fork", ["king_safety"]),
    "rr-003": ("activity", "played", "open file", []),
    "rr-004": ("pawns", "best", "weak d6", ["activity"]),
    "rr-005": ("mate", "both", "defend mate", []),
    "rr-006": ("mate", "played", "king trapped", []),
    "rr-007": ("material", "played", "fork", ["activity"]),
    "rr-008": ("activity", "best", "outpost", []),
    "rr-009": ("material", "played", "miscalculation", []),
    "rr-010": ("mate", "best", "missed mate", []),
    "rr-011": ("trade", "best", "simplify when ahead", []),
    "rr-012": ("material", "best", "pin", []),
    "rr-013": ("material", "best", "discovered attack", ["activity"]),
    "rr-014": ("material", "both", "exchange", []),
    "rr-015": ("draw", "both", "stalemate", ["king_safety"]),
    "rr-016": ("material", "played", "hanging pawn", []),
    "rr-017": ("king_safety", "best", "attack f7 and king", ["activity"]),
    "rr-018": ("trade", "played", "avoid trades when worse", ["material"]),
    "rr-019": ("material", "played", "exchange", []),
    "rr-020": ("material", "played", "hanging pawn", []),
    "rr-021": ("mate", "played", "self-trap", []),
    "rr-022": ("mate", "best", "mating attack", []),
    "rr-023": ("space", "played", "pawn roller", ["pawns"]),
    "rr-024": ("material", "best", "fork", ["activity"]),
    "rr-025": ("mate", "best", "mate in 1", []),
    "rr-026": ("pawns", "played", "structure and centre", ["space"]),
    "rr-027": ("material", "best", "missed win", []),
    "rr-028": ("development", "best", "develop and hold centre", []),
    "rr-029": ("pawns", "best", "damage structure", []),
    "rr-030": ("material", "best", "fork", ["mate"]),
    "rr-031": ("development", "best", "faster development", ["activity"]),
    "rr-032": ("trade", "both", "bishop trade helps defender", ["material"]),
    "rr-033": ("mate", "best", "mate in 2", []),
    "rr-034": ("mate", "played", "allows mate", []),
    "rr-035": ("king_safety", "both", "open file at own king", []),
    "rr-036": ("king_safety", "played", "king cut off", ["material"]),
}


def main():
    labels = json.loads((HERE / "LABELS.json").read_text(encoding="utf-8"))
    out, rows = [], []
    for r in labels["reviews"]:
        if not r["submitted_at"]:
            continue
        kind, where, motif, secondary = ADJUST[r["pos_id"]]
        assert kind in KINDS and all(s in KINDS for s in secondary)
        out.append({**r, "kind": kind, "where": where, "motif": motif, "secondary": secondary,
                    "original": {"kind": r["kind"], "where": r["where"]}})
        changed = [f for f, new in (("kind", kind), ("where", where)) if r[f] != new]
        rows.append(f"| {r['pos_id']} | {r['kind']} → **{kind}** | {r['where']} → "
                    f"{'**' + where + '**' if 'where' in changed else where} | {motif} | "
                    f"{'、'.join(KINDS[s] for s in secondary)} |")
    doc = {"schema": "reason-review-adjusted/1", "set_sha256": labels["set_sha256"], "kinds": KINDS,
           "in_scope": sorted(IN_SCOPE), "reviews": out}
    (HERE / "LABELS.adjusted.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    kinds = Counter(r["kind"] for r in out)
    scope = sum(r["kind"] in IN_SCOPE for r in out)
    md = ["# Adjusted main reasons", "",
          f"{len(out)} reviews; kind changed in {sum(r['kind'] != r['original']['kind'] for r in out)}, "
          f"line changed in {sum(r['where'] != r['original']['where'] for r in out)}.", "",
          "| kind | n |", "|---|---|", *[f"| {KINDS[k]} ({k}) | {n} |" for k, n in kinds.most_common()], "",
          f"Main reason inside the enumerator's scope (activity, development, space): {scope} / {len(out)}.", "",
          "| pos | kind | line | motif | secondary |", "|---|---|---|---|---|", *rows, ""]
    (HERE / "ADJUSTED.md").write_text("\n".join(md), encoding="utf-8")
    print(dict(kinds), "in scope", scope)


if __name__ == "__main__":
    main()
