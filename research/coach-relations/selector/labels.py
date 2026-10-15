"""Build the judged-card table. Run with: py -B selector/labels.py

Only selector/ is written; feature extraction uses cached Stockfish reads exclusively.
"""
import json
import sys
from collections import Counter
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
BENCH = ROOT.parents[1] / "artifacts/benchmarks/coach-relations-20261014"
CHECKS = {"guard": "defender", "bp": "bishop_pair", "qc": "queen_chased",
          "pr": "promotion", "kl": "king_leaves"}


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def jsonl(path):
    with path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def record(source, folder, card, facts, text, labels, note, **extra):
    return {"source": source, "folder": folder.relative_to(ROOT).as_posix(),
            "id": card["id"], "fact_types": facts, "coach_text": text,
            "grade": card.get("grade"), "loss_cp": card.get("loss"),
            "labels": labels, "note": note, **extra}


def judgments():
    rows = []
    for prefix, kind in CHECKS.items():
        for path in sorted((ROOT / f"{prefix}-check").glob("**/out/check.jsonl")):
            folder = path.parents[1]
            items = {r["i"]: r for r in jsonl(folder / "items.jsonl")}
            for judgment in jsonl(path):
                card = items[judgment["i"]]
                labels = {k: v for k, v in judgment.items() if isinstance(v, bool)}
                rows.append(record("sol_check", folder, card, [kind], card.get("coach_text"),
                                   labels, judgment.get("note", ""), i=judgment["i"]))
    for folder in sorted(p for p in ROOT.glob("ab*") if p.is_dir()):
        output = folder / "run-output"
        key = read(output / "BLIND-KEY.json")["pairs"]
        cards = {r["pair_id"]: r for r in jsonl(output / "BLINDED.jsonl")}
        reviews = [("sol_ab", r) for p in sorted(output.glob("judge/out/*.jsonl")) for r in jsonl(p)]
        human = folder / "human-review/HUMAN-REVIEW.json"
        if human.exists():
            reviews += [("user", r) for r in read(human)["reviews"]]
        for source, review in reviews:
            pid, verdict = review["pair_id"], review["verdict"]
            k, card = key[pid], cards[pid]
            side, = [s for s in ("A", "B") if k[s] == "relations"]
            outcome = ("won" if verdict == side else "lost") if verdict in ("A", "B") else verdict
            assert outcome in ("won", "lost", "tie", "both_bad"), review
            labels = {"outcome": outcome, "issues": review["issues"][side]}
            for field in ("main_reason", "confidence"):
                if field in review:
                    labels[field] = review[field]
            rows.append(record(source, folder, {"id": k["id"], "grade": card["facts"]["grade"]},
                               k.get("facts"), card[side]["response"], labels,
                               review.get("note", review.get("why", "")),
                               pair_id=pid, relations_side=side))
    return rows


def feature_rows(rows):
    sys.path.insert(0, str(ROOT))
    import explain as explainer
    import tactics
    from make_ab import row as card_row
    from unittest.mock import patch

    reads = BENCH / "prod-depth/out"
    card_files = sorted(reads.glob("*/cards.jsonl"))
    tactics.READ = ([p.parent / "sf_cache.jsonl" for p in card_files]
                    + sorted(BENCH.glob("explain-*/*/explain/sf_cache-*.jsonl")))
    cache = {r["fen"]: r for p in [*tactics.READ, tactics.CACHE] if p.exists() for r in jsonl(p)}

    class CacheMiss(Exception):
        pass

    def cached_only(board):
        fen = board.fen()
        if fen not in cache:
            raise CacheMiss(fen)
        return cache[fen]

    # Replace the search entry point: even an unexpected tail request cannot launch an engine.
    tactics.analyse = cached_only
    wanted = {r["id"] for r in rows}
    production = {c["id"]: card_row(c) for p in card_files
                  for c in jsonl(p) if c["id"] in wanted}
    positions = {r["id"]: r for r in jsonl(ROOT / "positions.jsonl") if r["id"] in wanted}
    inputs = {"production": production, "v5": positions}
    results, skipped = {}, Counter()
    candidates = explainer.candidates
    for n, labeled in enumerate(rows, 1):
        kind = "v5" if labeled["folder"] in ("ab", "ab2", "ab3", "ab4", "ab5") else "production"
        key = (kind, labeled["id"])
        r = inputs[kind].get(labeled["id"])
        if key not in results:
            facts = []

            def collect(row):
                found = candidates(row)
                facts.extend(found)
                return found

            if r is None:
                results[key] = ({}, "missing_input")
            else:
                try:
                    with patch.object(explainer, "candidates", collect):
                        e = explainer.explain(r)
                    first = e["chosen"][0] if e["chosen"] else None
                    results[key] = ({
                        "chosen_fact_type": first["type"] if first else None,
                        "line": first["line"] if first else None,
                        "first_ply": first["ply"] if first else None,
                        "other_line_same_type": any(f["type"] == first["type"] and f["line"] != first["line"]
                                                    for f in facts) if first else None,
                        "loss": r.get("loss"), "grade": r["grade"],
                        "num_facts": len(facts), "num_chosen_facts": len(e["chosen"]),
                    }, None)
                except CacheMiss:
                    results[key] = ({}, "cache_miss")
        labeled["features"], reason = results[key]
        if r is not None:
            labeled["grade"] = r["grade"]
            labeled["loss_cp"] = r.get("loss")
        if reason:
            skipped[reason] += 1
        if n % 100 == 0:
            print(f"Features: {n}/{len(rows)} rows", flush=True)
    assert tactics._engine is None
    return skipped, len(cache), len(tactics.READ)


def report(rows, skipped, cache_size, cache_files):
    lines = ["# Selector labels", "", "Generated with `py -B selector/labels.py`.", "",
             f"{len(rows)} judged rows; {len({r['id'] for r in rows})} distinct card IDs. "
             "Each judgment remains a separate row, including repeated cards and user reviews.", "",
             "| Source | Rows | With features |", "| --- | ---: | ---: |"]
    for source in ("sol_check", "sol_ab", "user"):
        group = [r for r in rows if r["source"] == source]
        lines.append(f"| {source} | {len(group)} | {sum(bool(r['features']) for r in group)} |")
    lines += ["", "Fact types are the check folder's type or the sealed key's historical `facts`. "
              "`null` means the key did not record facts; `[]` means it recorded no chosen fact. "
              "Types count once per row, so rows with multiple types appear in multiple counts.", "",
              "| Fact type | sol_check | sol_ab | user | Total |", "| --- | ---: | ---: | ---: | ---: |"]
    counts = Counter((r["source"], t) for r in rows for t in
                     (set(r["fact_types"]) if r["fact_types"] else
                      ["unknown" if r["fact_types"] is None else "no fact"]))
    for kind in sorted({t for _, t in counts}):
        nums = [counts[source, kind] for source in ("sol_check", "sol_ab", "user")]
        lines.append(f"| {kind} | " + " | ".join(map(str, [*nums, sum(nums)])) + " |")
    lines += ["", "| Folder | Rows | With features |", "| --- | ---: | ---: |"]
    for folder in sorted({r["folder"] for r in rows}):
        group = [r for r in rows if r["folder"] == folder]
        lines.append(f"| {folder} | {len(group)} | {sum(bool(r['features']) for r in group)} |")
    total = sum(bool(r["features"]) for r in rows)
    lines += ["", f"Features: **{total}/{len(rows)} rows**. Empty features: "
              + (", ".join(f"{k}={v}" for k, v in sorted(skipped.items())) or "none") + ".", "",
              "Feature inputs follow make_ab.py: rounds ab–ab5 use positions.jsonl (v5 cut lines); "
              "later rounds and board checks use make_ab.row on the production-depth "
              "out/{fresh1,fresh2,fresh3,fresh4,v5}/cards.jsonl full lines. The v5 kernel supplies "
              "22 board-check cards absent from fresh*. Grade and loss_cp use that input where "
              "available; unknown loss remains null.", "",
              f"Read {cache_files} additional cache files plus tactics.CACHE ({cache_size} cached FENs). "
              "The analyse entry point is replaced by a cache-only lookup; no engine searches or "
              "cache writes occur. A missing input or any required FEN missing from the cache leaves "
              "the entire features object empty. Unexpected errors stop generation.", "",
              "Features use the current explain.explain result: chosen_fact_type, line, and first_ply "
              "refer to its first chosen fact (null when none). other_line_same_type checks the "
              "enumerator's candidates, captured during that exact explain call, before explain's "
              "wording filters; null when there is no chosen fact. num_facts counts those candidate "
              "facts; num_chosen_facts counts the facts selected for the reason. loss is row['loss'] "
              "in centipawns, null when unavailable. Historical coach text and fact_types are never "
              "replaced by the rerun.", "",
              "Check labels preserve every boolean field, including false values. A/B labels store "
              "the relations-side outcome (won/lost/tie/both_bad) and its issues; pair_id and "
              "relations_side retain the unblinding link. Judge main_reason and confidence are kept "
              "in labels; note preserves the user/check note or the judge's why verbatim. All text "
              "is read and written as UTF-8 without normalization.", ""]
    (HERE / "LABELS.md").write_text("\n".join(lines), encoding="utf-8")


def main():
    rows = judgments()
    skipped, cache_size, cache_files = feature_rows(rows)
    (HERE / "labels.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
                                     encoding="utf-8")
    report(rows, skipped, cache_size, cache_files)
    print(f"Wrote {len(rows)} rows; {sum(bool(r['features']) for r in rows)} with features")


if __name__ == "__main__":
    main()
