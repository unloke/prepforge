"""Cards where explain.py gives no reason, for the user to note the real one (coach-ab-review's
single-answer mode).

  py research/coach-relations/make_notes.py notes1 --reads artifacts/benchmarks/coach-relations-20261014/prod-depth/out
  node research/coach-ab-review/serve.mjs research/coach-relations/notes1 --port 5216

Draws, from the prod-depth fresh* cards no A/B round or notes set has shown, PER_GRADE cards of
each error grade (blunders first) whose explain.py card names no fact. The page shows the board,
both lines, the scores and the game; the answer is the new Coach's text; the note is the user's
reason. ids.json joins the shown cards (make_ab.unseen), so later rounds do not draw them.
"""
import json
import os
import random
import sys
import pathlib

import tactics
from explain import explain
from make_ab import answer, game, jsonl, row, score, unseen

HERE = pathlib.Path(__file__).parent
PER_GRADE = {"blunder": 14, "mistake": 13, "inaccuracy": 13}


def main():
    NOTES, reads = HERE / sys.argv[1], pathlib.Path(sys.argv[sys.argv.index("--reads") + 1])
    tactics.READ += [d / "sf_cache.jsonl" for d in reads.glob("fresh*")] + sorted(reads.parents[1].glob("explain-*/*/explain/sf_cache-*.jsonl"))
    cards, games = {}, {}
    for d in sorted(reads.glob("fresh*")):
        for c in jsonl(d / "cards.jsonl"):
            cards[c["id"]] = c
            games.setdefault(c["id"].split("/")[0], []).append(c)
    seen, rng = unseen(), random.Random(int.from_bytes(os.urandom(16), "big"))
    picked = []
    for g in ("blunder", "mistake", "inaccuracy"):
        pool = sorted(i for i, c in cards.items() if c["code"] == g and i not in seen)
        rng.shuffle(pool)
        n = 0
        for i in pool:
            r = row(cards[i])
            if not r["played_pv"] or not r["best_pv"] or r["played_pv"][0] == r["best_pv"][0]:
                continue
            e = explain(r)
            if not e["facts"]:
                picked.append((i, r, e))
                n += 1
                if n == PER_GRADE[g]:
                    break
    tactics.close()
    rng.shuffle(picked)
    out = []
    for n, (i, r, e) in enumerate(picked, 1):
        c = cards[i]
        out.append({
            "pair_id": f"card-{n:03d}",
            "prompt": f"{c['san']} ({c['code']}), {c['mover']}, move {c['moveNumber']}.",
            "facts": {"fen_before": c["fen"], "fen_after": c["fenAfter"], "side": c["mover"], "move_number": c["moveNumber"],
                      "played_uci": c["uci"], "played_san": c["san"], "best_uci": c["bestUci"], "best_san": c["bestSan"],
                      "is_best": c["isBest"], "grade": c["code"], "played_pv": r["played_pv"], "best_pv": r["best_pv"],
                      "before": score(c["before"]), "after": score(c["after"]), "game": game(games[i.split("/")[0]], i)},
            "A": answer(e["text"]),
        })
    (NOTES / "run-output").mkdir(parents=True, exist_ok=True)
    (NOTES / "ids.json").write_text(json.dumps([i for i, _, _ in picked]) + "\n", encoding="utf-8")
    (NOTES / "run-output/BLINDED.jsonl").write_text("".join(json.dumps(o, ensure_ascii=False) + "\n" for o in out), encoding="utf-8")
    (NOTES / "run-output/KEY.json").write_text(json.dumps({o["pair_id"]: i for o, (i, _, _) in zip(out, picked)}, indent=1) + "\n", encoding="utf-8")
    print(len(out), "cards")


if __name__ == "__main__":
    main()
