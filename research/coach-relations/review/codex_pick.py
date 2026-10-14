"""Research only. Gathers Codex's first-pass labels for a round and picks the positions a human
should check first.

  py research/coach-relations/review/codex_pick.py 4 artifacts/benchmarks/coach-relations-20261014/codex-annot-r4/out

Writes LABELS-r<round>.codex.json (Codex's labels, kept apart from the human's LABELS file) and
prints the picks: positions where Codex rated a candidate wrong, said it was unsure, or named a
reason other than material or mate with no candidate rated key. Up to 15, in that order.
"""
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).parent
TACTICAL = ("material", "mate")


def main():
    rnd, src = sys.argv[1], pathlib.Path(sys.argv[2])
    positions = {p["pos_id"]: p for p in json.loads((HERE / f"set-r{rnd}.json").read_text(encoding="utf-8"))}
    rows = [json.loads(l) for f in sorted(src.glob("batch*.jsonl")) for l in f.read_text(encoding="utf-8").splitlines() if l.strip()]
    labels = {r["pos_id"]: r for r in rows}
    missing = sorted(set(positions) - set(labels))
    (HERE / f"LABELS-r{rnd}.codex.json").write_text(
        json.dumps({"source": "codex exec, RUBRIC.md in " + src.parent.name, "reviews": [labels[k] for k in sorted(labels)]},
                   ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    picks = []
    for pid in sorted(labels):
        r, cands = labels[pid], positions[pid]["candidates"]
        ratings = [r["ratings"].get(str(i)) for i in range(len(cands))]
        why = ("wrong fact" if "wrong" in ratings else
               "low confidence" if r.get("confidence") == "low" else
               "no key fact" if r["kind"] not in TACTICAL and "key" not in ratings else None)
        if why:
            picks.append((["wrong fact", "low confidence", "no key fact"].index(why), pid, why, r))
    tactical = [r for r in labels.values() if r["kind"] in TACTICAL]
    covered = lambda rs: sum("key" in r["ratings"].values() for r in rs)
    positional = [r for r in labels.values() if r["kind"] not in TACTICAL]
    print(f"{len(labels)} labelled, missing {missing}")
    print(f"tactical {covered(tactical)}/{len(tactical)} with a key fact, other {covered(positional)}/{len(positional)}")
    print(f"high confidence {sum(r.get('confidence') == 'high' for r in labels.values())}")
    for _, pid, why, r in sorted(picks)[:15]:
        print(f"{pid}  {why:15} {r['kind']}/{r['where']}  {r['note']}" + (f"  ({r['doubt']})" if r.get("doubt") else ""))


if __name__ == "__main__":
    main()
